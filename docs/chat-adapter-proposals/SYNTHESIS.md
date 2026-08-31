# ChatAdapter — synthesis

Four independent proposals (console.md, telegram.md, slack.md, discord.md),
each reasoning from a different platform's actual constraints before any of
them saw the others. This is the reconciliation into one interface
(`src/chat/types.ts`), decision by decision, with which proposal drove each
call and why.

## Where all four already agreed (no real conflict to resolve)

- `MessageRef` must be **opaque**, not a platform-shaped id. Console and
  Telegram proposed a plain string; Slack and Discord proposed a structured
  object (`{platform, opaque}` / `{channelId, messageId}`). **Kept as a plain
  `string`** — a structured ref buys nothing at the interface level (core
  never inspects it either way) and a plain string keeps `generations`'
  persisted column a single `TEXT` field instead of two. Slack/Discord
  adapters serialize their own `channel:ts` / `channelId:messageId` pair into
  that string internally.
- `REJECT_REASONS` (the actual list + labels) stays in **core**, passed into
  `ShotState`'s `reject_reasons` case — not hardcoded in any adapter. All four
  agreed independently.
- File upload content should arrive as an already-fetched `Buffer`, not a
  lazy fetch the handler has to trigger — Slack's proposal made this
  explicit; adopted for all platforms so core never touches download
  mechanics regardless of adapter.
- Authorization does not belong on the adapter. **Went further than any
  single proposal**: since every event already carries `ChatUser`, and core
  already holds the configured "Ellie" id, there's no need for an
  `isAuthorized(user)` adapter method at all (Slack/Discord proposed one;
  Console argued for keeping the whole concern out of the adapter). Dropped
  it — core just compares `event.actor.id` directly.

## The one real disagreement, and the fix it forced

**Slack's proposal surfaced an actual bug**, not just a design question:
`decideGeneration` in `db/index.ts` is not currently idempotent at the DB
layer — the "already decided" guard lives in `bot.ts`'s callback handler
(`if (gen.decision !== "pending") return`), checked *before* the write, not
enforced *by* the write. Telegram never surfaces this because it has no
redelivery behavior. Slack does: any interaction Slack's own 3-second ack
budget is missed on gets redelivered, and two concurrent handler
invocations can both read `pending` before either write lands — double-
counting an approval, double-firing the "done!" message, or letting a
second `decidedBy` silently overwrite the first.

Fixed at the source: `decideGeneration`/`undecideGeneration` now guard
inside the `UPDATE ... WHERE decision = 'pending'` itself (atomic, DB-level),
not just in the caller. This makes the fix universal — it protects Telegram
too, it was just never exercised there. See the code diff in `db/index.ts`.

**Consequence for the interface**: every `ChatAdapter` handler
(`onCommand`/`onDecision`/`onCsvUpload`) is specified as invoked *after* the
platform ack, with results reported only via explicit outbound calls
(`sendText`, `updateShotMessage`, `event.acknowledge()`) — never via a
handler's return value. This is a strictly Slack-driven requirement, but it
costs nothing on Telegram/Discord/Console, so it applies everywhere rather
than special-casing one platform's contract.

## Other reconciliations

- **Message editing is best-effort, not guaranteed** (Telegram's own
  self-critique: WhatsApp/SMS can't edit at all). `updateShotMessage` is
  documented as falling back to posting a new message rather than throwing.
- **Edits key off a durable ref, never a live interaction/request context**
  (Discord's finding: interaction tokens expire in 15 minutes; Undo can fire
  days later). `updateShotMessage(ref, ...)` only ever takes the persisted
  `MessageRef` from `sendGeneratedShot`, never anything tied to the click
  that triggered a particular edit.
- **Ack and edit are separate calls** (Discord + Slack agree, Console/Telegram's
  designs already kept them separable). `DecisionEvent.acknowledge()` is
  cheap and satisfies the platform's UX/deadline; `updateShotMessage` carries
  the actual visible state change and can run arbitrarily later.
- **Three separate registration points** (`onCommand`/`onDecision`/
  `onCsvUpload`), not one unified event union (Console's `onEvent` proposal).
  Went with the majority (Telegram/Discord/Slack all split these three ways)
  since it matches how each platform actually delivers them as distinct
  triggers, avoiding a `switch` on event type inside every adapter.
- **`updateShotMessage` takes a light `{sku, variantIndex}` context, not the
  full `GeneratedShotContent`** — an edit never needs to re-send `imageUrl`
  or re-derive `shotIdea`; dragging those along would imply re-attaching the
  image on every edit, which no platform does or needs.

## What this does NOT attempt to solve

- **Multi-channel fan-out** (e.g. a 1:1 medium like SMS needing separate
  threads per read-only viewer instead of one shared channel). Telegram's
  proposal flagged this as out of scope for any of the four lenses used here
  — still true. `ChatAdapter` assumes one review channel, matching the
  actual product requirement.
- **Discord's 5-button/5-row cap being brushed up against today** (5 reject
  reasons, zero headroom) isn't a code change — just a documented constraint
  on `REJECT_REASONS` worth remembering if that list ever grows.
