# Setup

Everything below is what it actually takes to stand this up from scratch — written from doing it live, not from a script. Nothing here is theoretical; every step (and every troubleshooting note) reflects something that actually happened during this build.

## Code structure, if you're reading this to understand the code rather than deploy it

```
src/
  index.ts, worker.ts, config.ts   Entrypoint, the generation loop, env loading — start here
  db/
    schema.sql                      Every table, with inline comments on why each column exists
    index.ts                        All persistence — every query the app makes lives here
  chat/
    types.ts                        The ChatAdapter interface — read this before any adapter file
    orchestrator.ts                 Platform-agnostic business logic (commands, decisions, CSV
                                     upload) wired onto whatever adapter index.ts constructs
    notifier.ts                     Work-hours-gated, per-product-grouped posting loop
    telegram.ts + telegram.test.ts  The ONE adapter actually deployed to production
    console.ts + console.test.ts    Credential-free reference adapter, used for adapter-contract tests
    discord.ts, discord-protocol.ts,
    slack.ts, slack-blocks.ts       Built and independently tested against the same interface,
                                     proving portability -- NOT wired into the deployed app (see
                                     APPROACH.md's scope ledger for why). discord.ts/slack.ts won't
                                     typecheck without their real dependency installed -- that's
                                     intentional (tsconfig.json excludes them from the default
                                     build); discord-protocol.ts and slack-blocks.ts are the
                                     dependency-free logic underneath and do compile/test normally.
  luma/client.ts                    Luma image_edit API, 429 retry/backoff
  quality/screen.ts                 Vision pre-screen before a shot reaches chat
  storage/s3.ts                     S3/R2 upload + signed URLs
  ingest/csv.ts, export.ts,
       validate.ts                  CSV import (idempotent), export, photo URL validation
  util/time.ts, workhours.ts        Display formatting, the work-hours gate

docs/chat-adapter-proposals/        Design-process artifacts: 4 independent platform proposals
                                     + SYNTHESIS.md, the reconciliation into types.ts. Read this
                                     if you want the reasoning behind the ChatAdapter shape, not
                                     just the shape itself.

scripts/                            Reusable dev utilities (not scratch files) -- each has an
                                     npm script; see package.json.
```

The one-sentence map: **`index.ts` wires one concrete `ChatAdapter` (Telegram) to `orchestrator.ts` (business logic) and starts `worker.ts` (generation) + `chat/notifier.ts` (posting) as independent loops that only ever touch the database and the adapter interface — never each other directly.**

## Prerequisites

- A Telegram account
- A [Railway](https://railway.app) account (or another host that runs a long-lived Node process — see "Other hosts" below)
- A [Cloudflare](https://dash.cloudflare.com) account (for R2 storage) — or a real AWS account if you'd rather use S3 directly
- The Luma API key from `.env.local` (already provided with this challenge)
- An Anthropic API key, for the quality pre-screen (optional — the pre-screen fails open and no-ops if unset)

## 1. Create the Telegram bot

1. Message **@BotFather** in Telegram
2. `/newbot` → give it a name (e.g. `Styled Shots`) → give it a username ending in `bot` (e.g. `homegoods_styled_shots_bot`)
3. Copy the token it gives you — looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz1234567`. This is `TELEGRAM_BOT_TOKEN`.

## 2. Create the review chat

1. Create a Telegram group (e.g. `Home Goods — Styled Shots`)
2. Add the bot to it
3. Add whoever is the single approver ("Ellie") to the group
4. Send any message in the group so it shows up in the bot's update log

## 3. Get the chat ID and the approver's user ID

Once the bot's token exists and a message has been sent in the group, and separately a `/start` sent to the bot in a 1:1 DM:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
```

Look for `"chat":{"id": ...}` from the group message — that's `TELEGRAM_CHAT_ID` (will be **negative** for a group; a positive number means you're looking at a 1:1 chat by mistake). Look for `"from":{"id": ...}` on the approver's `/start` message — that's `TELEGRAM_ELLIE_USER_ID`.

## 4. Storage — Cloudflare R2 (or real S3)

**R2** (no AWS account needed):
1. [dash.cloudflare.com](https://dash.cloudflare.com) → **R2 Object Storage** → Create bucket
2. **R2 → Manage API Tokens → Create API Token**, Object Read & Write, scoped to that bucket
3. You'll get an Access Key ID, Secret Access Key, and an endpoint shaped like `https://<account-id>.r2.cloudflarestorage.com`

**Real AWS S3** instead: skip `S3_ENDPOINT` entirely (see env var table below) — the app defaults to real S3 when it's unset.

## 5. Deploy to Railway

1. [railway.app](https://railway.app) → sign up → **New Project → Deploy from GitHub repo**
2. If the repo doesn't show up in the picker: go to [github.com/settings/installations](https://github.com/settings/installations) → **Installed GitHub Apps** (not "Authorized GitHub Apps" — different tab, easy to land on the wrong one) → Railway → Configure → grant it access to this repo
3. In the same Railway project: **+ New → Database → Add PostgreSQL**
4. On your app service → **Variables** tab, set everything in the table below
5. Railway auto-deploys on push to `main`, and redeploys automatically on every subsequent push

### Environment variables

| Variable | Where it comes from | Notes |
|---|---|---|
| `LUMA_AGENTS_API_KEY` | Provided with the challenge (`.env.local`) | |
| `ANTHROPIC_API_KEY` | Provided with the challenge, or your own | Optional — quality pre-screen no-ops without it |
| `TELEGRAM_BOT_TOKEN` | Step 1 | |
| `TELEGRAM_CHAT_ID` | Step 3 | Must be negative (a group), not positive |
| `TELEGRAM_ELLIE_USER_ID` | Step 3 | The one user allowed to write |
| `DATABASE_URL` | Railway's Postgres service → Variables tab | **Use the real value from Railway, not a placeholder** — see Troubleshooting |
| `DATABASE_SSL` | Set to `require` | Railway's managed Postgres needs SSL; this is the #1 first-deploy failure otherwise |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | R2 API token (step 4), or real AWS creds | |
| `AWS_REGION` | `auto` for R2; a real region (e.g. `us-west-2`) for S3 | R2 ignores the value but the SDK requires something non-empty |
| `S3_ENDPOINT` | R2's endpoint URL (step 4) | **Omit entirely for real S3** |
| `S3_BUCKET_NAME` | Your bucket name | |
| `PORT` | Set automatically by Railway | Don't set manually |

Everything else in `.env.example` has a sane default (work hours, timezone, worker/notifier pacing, etc.) — only override if you actually need to.

## 6. Verify it's alive

1. Send `/start` in the Telegram group → should get the onboarding reply
2. Send `/status` → should show all zeros on a fresh database
3. Drop `data/catalog.csv` (or a real drop) into the chat as a file attachment → should get an import summary
4. Within configured work hours, generated shots should start landing with Approve/Reject buttons

## Troubleshooting (all of these actually happened)

**`getaddrinfo ENOTFOUND host`, hostname literally `'host'`** — `DATABASE_URL` is still the literal placeholder text from `.env.example` (`postgres://user:pass@host:5432/dbname`), not the real connection string from Railway's Postgres service. Go copy the actual value (or use a Variable Reference to the Postgres service instead of pasting a static value).

**Repo doesn't show up in Railway's "Deploy from GitHub repo" search** — it's a GitHub App permissions issue, not Railway. Fix in step 5 above; the key detail is landing on "Installed GitHub Apps," not "Authorized GitHub Apps" (they look similar, only one controls repo-level access).

**`XMinioStorageFull` / storage writes failing on a self-hosted MinIO** — this only applies if you're running storage locally rather than R2/S3. It means the *host disk* is nearly full — check `df -h`, not the bucket. A few hundred MB of cleanup often isn't enough if the disk is already >90% used; MinIO's safety threshold is based on the overall ratio, not absolute free bytes.

**Products stuck showing "Generating" forever** — self-heals automatically on the next process restart (`reclaimStuckGenerating()` runs on every boot). If you need it to clear without waiting for a redeploy, that's the only case where direct DB access would be needed — not expected in normal operation.

**A batch of products all error at once with the same Luma 429 message** — should be rare now (worker/notifier ticks no longer overlap, capping real concurrent Luma calls at the intended batch size), but if it happens: `/redo all` requeues everything in `error`/`needs_redo` in one command rather than one SKU at a time.

**Import summary never comes back after dropping a CSV in chat** — check the exact filename shown in Telegram; the importer only reacts to files ending in `.csv` and silently ignores anything else (by design, so it doesn't react to random file shares in the chat).

## Local development (optional)

For iterating without touching the deployed instance:

```bash
brew install postgresql@16 && brew services start postgresql@16
createdb styled_shots
brew install minio
MINIO_ROOT_USER=<user> MINIO_ROOT_PASSWORD=<pass> minio server --address :9000 --console-address :9001 /usr/local/var/minio-data
npm run setup:minio-bucket   # creates the bucket via the AWS SDK, no mc CLI needed
```

Point `.env` at `DATABASE_URL=postgres://<you>@localhost:5432/styled_shots` and `S3_ENDPOINT=http://localhost:9000` with the MinIO credentials above. **Note**: Telegram's servers can't reach `localhost` — `TelegramChatAdapter.sendGeneratedShot` downloads and re-uploads image bytes itself rather than handing Telegram a URL to fetch, specifically so this works locally too, not just against a real public bucket.

Never run two instances (local + deployed) against the same `TELEGRAM_BOT_TOKEN` simultaneously — Telegram only allows one active long-poll connection per bot token; the second one will get `409 Conflict`.

## Other hosts

Anywhere that runs a persistent Node process works — Fly, Render, a VPS with `pm2`/`systemd`, etc. The only Railway-specific things above are the Postgres-addon flow and the GitHub-connection UI; the app itself (`npm start` → `tsx src/index.ts`) has no Railway dependency.
