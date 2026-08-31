# Approach

## Deployed, live

- **Product**: [lumalabs-eng-take-home-production-cb4e.up.railway.app](https://lumalabs-eng-take-home-production-cb4e.up.railway.app) — Railway, real Postgres, real R2 storage, long-polling Telegram bot. Not a demo build; this is the same code running against real credentials that everything in this doc describes.
- **Chat workspace**: [t.me/+4WKv-w4frwZjNjAx](https://t.me/+4WKv-w4frwZjNjAx) — join and try `/status`, `/review`, `/export` yourself. Ellie is the sole writer by design (see Assumptions), so everyone else — including anyone joining via this link — is read-only: you can watch and pull status, but can't approve/reject/undo/redo/import. That's not a demo restriction, it's the actual permission model.
- See `SETUP.md` for how this was stood up from scratch, including the real issues hit along the way.

## What I built, and why

Ellie's actual bottleneck was never generation quality — it was that requests sat in a spreadsheet column for months because "get a photographer" only happens 2-3 times a year. So the build is a straight pipeline from **Shot Idea text → styled photo → Ellie's phone**, with everything else in service of that:

- **Chat-native, one surface, one writer.** Every interaction — approve, reject, undo, `/status`, `/redo`, importing a new catalog drop — happens in the same Telegram thread Ellie already has open. No dashboard, no second login. She said "if I can't do it from the chat, on my phone, it doesn't exist" and the whole design takes that literally, including that she's the *only* one who can act; everyone else is read-only.
- **A platform-agnostic `ChatAdapter` interface**, not Telegram-specific code wired straight into the business logic. `worker.ts`, the notifier, and the DB layer only ever talk to the interface; Telegram is the one concrete implementation actually deployed. Console (a credential-free test harness) and Telegram are fully built and running; Slack and Discord adapters are built and independently tested against the same interface, proving the architecture is genuinely portable — not deployed, because this specific customer only needs one platform and explicitly refuses to juggle several.
- **Image-conditioned generation (Luma `image_edit`), not text-to-image.** The product itself has to survive stylization. Verified empirically, not assumed: 4/4 real generations against real catalog products held shape, color, and material while landing convincingly in the requested scene.
- **A quality pre-screen before Ellie ever sees a shot.** A cheap vision call (Claude) checks product identity and technical soundness; a flagged image gets exactly one retry with a nudged prompt before being shown anyway (flagged, never silently dropped). This is the actual answer to "how do you test the gate" — the pre-screen's own hit rate is tracked against her real reject rate in `/status`.
- **Generation runs continuously; notification doesn't.** The worker generates and screens around the clock, but Ellie is only ever pinged inside configured work hours. Everything ready outside that window just queues — nothing is lost, nothing pings her phone at 11pm.
- **Cost discipline is structural, not a policy.** No auto-regeneration on reject — a reject reason feeds into the *next* explicit `/redo`, but nothing retries on its own. Photo URLs are validated (and the validation cached) before a Luma call is ever made. A backlog throttle stops generation from running further ahead of Ellie's actual review pace than she can absorb.

## Key decisions and tradeoffs

| Decision | Why | What it cost |
|---|---|---|
| Telegram over Slack | No OAuth/app-review ceremony, long-polling needs no public webhook — fastest real path for a 1-day build | Slack's richer Block Kit UI unused for now |
| Universal `ChatAdapter`, only Telegram deployed | Portability proven without paying to build/maintain platforms nobody asked for | Real engineering time spent on an abstraction the immediate customer doesn't strictly need — justified by "runs universally" being an explicit requirement, not by the brief itself |
| 3 approvals (ceiling of README's "2-3"), 3 variants generated per pass | Avoids a `/redo` round-trip on a clean pass; still ~$0.13/product | Slightly more spend up front than the floor (2) would cost |
| No auto-regeneration, ever | "Don't burn budget on stuff she'll reject" — direct quote | A rejected product needs an explicit `/redo`; nothing self-heals |
| Ellie-only writer, single Telegram chat as the whole auth boundary | Matches "her pick is the decision" literally, and fits a 6-person team without over-building RBAC | No delegation if she's out; a compromised account is a real (if low-likelihood) risk |
| S3-compatible storage (Cloudflare R2 in production), not real Google Drive | The drive-folder step already works for them manually; swapping in real Drive is pure OAuth/API surface for a step that isn't broken | Approved images land in a bucket, not literally their shared drive — someone still moves them over, same as today |

## Scope ledger

**In:**
- Chat-driven CSV import (idempotent by SKU, photo-URL validated and cached, duplicate-SKU detection) — verified live to correctly distinguish a genuinely new drop (5 new Shot Ideas queued) from a re-send of unchanged rows (35 correctly skipped, not re-processed)
- Luma `image_edit` generation with real 429 retry/backoff, and correctly-bounded worker concurrency (the `setTimeout`-chain fix — see "what breaks first")
- Quality pre-screen with one bounded retry
- Full approve/reject/undo/redo flow, two-step reject-reason picker, export-locked undo
- **Notifications grouped per product**, not flat FIFO across everyone's candidates — found live that mixing variants from different products in one stream reads as a jumble; fixed to post one product's full set together before moving to the next
- **Bulk recovery** (`/redo all`) for when a systemic issue errors out several products at once, not just one-at-a-time recovery
- **Export surfaces the actual failure reason** (`error_message`), not just a status label — found live that "6 errors" with no explanation isn't actionable for Ellie or Maya
- Work-hours-gated notifications; generation runs independently, 24/7, and self-heals anything stuck mid-flight from a crash/redeploy on the next boot
- Backlog throttle tying generation pace to review capacity
- Critical-failure alerting (systemic, not per-product) — separate from and explicitly *not* a budget-alert system
- Spend tracking that survives partial failure (the `luma_spend_log`, added after a real storage outage showed spend was going untracked when a paid generation never made it to the DB)
- The `ChatAdapter` interface + Console/Telegram (deployed) + Slack/Discord (built, tested, not deployed)
- `SETUP.md` — real setup steps and troubleshooting from actually standing this up, not a hypothetical handoff doc

**Out — cut by value, not by running out of time:**
- **Real Google Drive integration.** The manual step already works for this team; building OAuth+Drive API for a non-broken step isn't where the day should go.
- **Live Google Sheets sync for ingestion.** The brief says outright: *"nobody is asking for live sheet sync."* The chat-drop CSV path is already low-frequency (per-drop, not per-product) and low-friction. Building live polling against their actual sheet would close the very last non-approve/deny human touchpoint in the system — genuinely worth naming — but it's solving a problem the customer told us they don't have, at the cost of a real onboarding step (granting API access to their live sheet).
- **Slack/Discord/WhatsApp as deployed, live platforms.** The architecture supports it; this customer explicitly doesn't want more than one surface.
- **Budget/spend alerts.** Explicit direction: no proactive budget pings. `/status` surfaces spend on request; nothing pushes it.
- **Category-level prompt learning** (aggregating reject reasons across the catalog to bias baseline prompts *before* generating, not just per-SKU after a reject). Needs real usage data this build doesn't have yet.
- **Multi-tenancy.** This is a forward-deployed engagement with one customer, not a platform for many.

**Next, if this were a week instead of a day:**
1. Live Sheets polling — the one path to a literally-zero-touch ingestion story
2. Real Google Drive as the storage backend
3. Category-level prompt learning from aggregate reject data
4. An automated test suite for the core business logic (today: unit tests on the `ChatAdapter` layer, real logic validated via live smoke testing against actual Telegram/Luma/Postgres — solid, but not a regression net for future changes)
5. Tighten `DecisionEvent` into a proper discriminated union (`reasonCode` is currently only *documented*, not *typed*, as reject-only)

## Unit economics

**Per image:** $0.0434 (Luma `uni-1`, `image_edit`), matching real spend observed live ($1.48 across 34 stored images during testing). Quality pre-screen adds a fraction of a cent (Claude Haiku vision call) — negligible next to generation cost.

**Wasted spend is tracked, not just successful spend.** `/status` reports it separately whenever it's nonzero — a Luma call is billed the moment it succeeds, before upload or screening, both of which can still fail afterward. Found live: a storage outage meant paid-for images were going completely untracked because the old design only recorded cost after a successful upload. That gap is closed; the honest number now includes money spent with nothing to show for it, not just the number that looks good.

**Per approved product** (3 variants generated per pass, the common case): **≈$0.13 and ≈1–3 minutes of machine time** (three sequential Luma calls, each ~10–30s including polling, observed directly against the live API — not estimated). **Ellie's actual attention time is the smaller number**: roughly 15–45 seconds of taps per product, once the shots are ready. That gap — minutes of machine time versus seconds of her time — is the entire point of the build: what used to take a photographer weeks now costs her under a minute of phone time per product.

**At 10x the catalog (300 → 3,000 products, or a 40-product drop → 400):**
- **Dollars scale linearly** — no surprises. ~$390 total spend for 3,000 products at the same per-product rate.
- **Machine throughput does *not* scale for free.** Luma enforces an account-wide concurrent-generation cap — confirmed live during testing at **10 concurrent generations**, not a number from documentation. Past a certain batch size, more parallelism just means more 429s and retries, not more throughput. This is a real ceiling worth negotiating with Luma before a 10x rollout, not something our own backoff logic can engineer around.
- **Ellie's own review time is the actual bottleneck, and it arrives before infrastructure does.** 3,000 products × ~30–45 seconds of her attention each is 25–37 hours of pure tapping — not sustainable for one person regardless of how fast generation runs. This isn't a flaw to patch; it's the system correctly reflecting a real constraint. The backlog throttle already protects against generation outrunning her pace — the actual next lever at 10x scale is either more reviewers, or smarter triage (e.g., auto-approving above some confidence threshold, which nothing here does today and would be a real product conversation with the customer, not just an engineering one).

## What breaks first under pressure

1. **Ellie's own throughput**, not the software — see above. This is the honest answer, not a deflection.
2. **Luma's 10-concurrent-generation cap, confirmed live** — but the sharper finding is that we *self-inflicted* a collision with it first. Both the worker and notifier loops originally used `setInterval`, which fires every poll interval regardless of whether the previous tick finished; since one product's generation (three sequential Luma calls) routinely takes longer than the 15s poll interval, ticks overlapped and true concurrent Luma load ran well past the intended `batchSize=3` — straight into Luma's real ceiling. Fixed by chaining `setTimeout` instead, so at most one tick is ever in flight. The cap itself is still real and worth negotiating with Luma before a 10x rollout, but our own client-side concurrency is now correctly bounded rather than accidentally unbounded.
3. **Single-instance deployment, no redundancy.** If the process crashes, generation and notification stop until the host restarts it. Partially mitigated since writing this: any product stuck mid-`generating` at the moment of a crash/redeploy now self-heals on the next boot (`reclaimStuckGenerating()`) — found necessary live, on an actual Railway redeploy. What's still true: there's a gap between crash and restart with nothing running, and no self-alerting if the process fails to boot at all (bad env var, unreachable DB) — the bot can't page anyone about its own failure to start. Railway's own deploy-failure notifications are the real safety net for that specific case, not something worth re-building in-app.
4. **Disk/storage headroom on whatever host runs storage**, if self-hosting rather than a managed bucket — found live during local testing (a MinIO instance backed by a nearly-full disk silently broke uploads well after the Luma spend had already happened, and that spend was invisible in `/status` until the `luma_spend_log` fix). Production uses R2, a managed bucket, so this specific failure mode doesn't apply to the deployed instance — but it's exactly the kind of thing "it worked in dev" hides until it doesn't.
5. **No automated regression coverage on core business logic.** The `ChatAdapter` layer has real unit tests (54 passing); `worker.ts`, the CSV importer, and the DB layer are validated by live testing against real Telegram/Luma/Postgres/R2, not a test suite. That live testing is what actually found the tick-overlap bug, the stuck-`generating` gap, the notifier interleaving-by-product bug, and the invisible-spend-on-storage-failure bug — real value, but it's manual, not a regression net. A future change could reintroduce any of those without anyone noticing until it's live again.
