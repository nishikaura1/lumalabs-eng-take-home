# `ChatAdapter` proposal — Slack

Author's lens: designing this interface as the person who has to implement it
*against Slack* (Block Kit + the Web API, using `@slack/bolt`), while keeping
it generic enough that `src/telegram/bot.ts` / `src/telegram/notifier.ts`
could be rewritten against the same interface without changing
`src/worker.ts` or `src/db/index.ts`.

I read `src/telegram/bot.ts` and `src/telegram/notifier.ts` in full before
writing this. The behaviors below are the ones the interface has to carry —
nothing more:

- Post a generated shot (image + caption) with Approve/Reject buttons tied to
  a `generationId`.
- Post a plain text/status message (`/start`, `/status`, `/review`, import
  results).
- Post a CSV document (the `/export` deliverable).
- Post a critical-failure alert that bypasses work-hours gating.
- Edit a previously-sent message in place: swap Approve/Reject → reason
  picker → decided badge + Undo → back to Approve/Reject.
- Handle slash-style commands (`/start`, `/status`, `/review`, `/export`,
  `/redo <sku>`).
- Handle a two-step reject flow (tap Reject → pick a reason → confirm) and a
  separate Undo action.
- Handle a CSV file upload (catalog import).
- Restrict all mutating actions to one person ("Ellie"); everyone else is
  read-only.

## 1. The interface

```ts
/**
 * Platform-agnostic identity of whoever triggered an inbound event.
 *
 * `id` is intentionally opaque and platform-scoped (Telegram: numeric user
 * id as a string; Slack: "U0123ABC456"). Core business logic maps `id` to
 * "is this Ellie?" via config (mirrors today's `ellieUserId` check) — the
 * adapter's only job is to normalize whatever the platform gives it into
 * this shape. The adapter must never make the authorization decision
 * itself; it just reports who acted.
 */
export interface ChatUser {
  /** Stable, platform-scoped identifier. Never assume a format or reuse it across platforms. */
  id: string;
  /** Best-effort human-readable name, for attribution/logging only (e.g. "— decided by ..."). Not guaranteed unique, stable, or even present. */
  displayName: string;
}

/**
 * Opaque handle to a previously-sent message, returned by every outbound
 * send and threaded back into `updateMessage`. Core code stores it (e.g. in
 * `getUnpostedGenerations`/`markPosted`) and passes it straight back —
 * it must never inspect or construct one itself. A Telegram adapter closes
 * over `{chatId, messageId}`; a Slack adapter closes over `{channel, ts}`
 * (the tuple `chat.update` actually needs).
 */
export interface ChatMessageRef {
  readonly platform: string;
  readonly opaque: unknown;
}

/** One tappable button. */
export interface ChatButton {
  /** Visible label, e.g. "✅ Approve". Adapters render this as-is; emoji are part of the label, not a separate platform feature. */
  label: string;
  /**
   * Opaque id round-tripped verbatim to the action handler when this button
   * is pressed (e.g. `"appr:42"`, `"rejr:42:staged"`, `"undo:42"`). Core owns
   * the encoding/decoding scheme entirely; the adapter only carries the
   * string. (On Slack this becomes a Block Kit button's `value`, not its
   * `action_id` — see §2.)
   */
  actionId: string;
}

/** A row of buttons rendered together (mirrors Telegram's `inline_keyboard` rows / a Block Kit `actions` block). */
export type ChatButtonRow = ChatButton[];

/**
 * A full replacement for a message's text and buttons. This is always the
 * *complete* new state, never a delta/patch — Slack's `chat.update` replaces
 * the whole block array in one call, and modeling this as a diff would force
 * every adapter to reconstruct one from scratch anyway. `buttons` omitted or
 * `[]` means "no buttons" (used for the final decided-and-exported state,
 * if buttons are ever fully removed).
 */
export interface MessageUpdate {
  text: string;
  buttons?: ChatButtonRow[];
}

export interface SendGeneratedShotOptions {
  /** Signed, time-limited URL (S3) — never raw bytes. Both Telegram (`sendPhoto`) and Slack (an `image` block's `image_url`) can render an image by URL directly. */
  imageUrl: string;
  /** Fully-formed caption text; core builds this (sku, shot idea, variant, optional quality note) — the adapter does not format it. */
  caption: string;
  /** Full initial button layout, e.g. `[[{label:"✅ Approve", actionId:"appr:42"}, {label:"❌ Reject", actionId:"rej:42"}]]`. */
  buttons: ChatButtonRow[];
}

export interface SendDocumentOptions {
  fileName: string;
  content: Buffer;
  /** MIME type, e.g. `"text/csv"`. */
  contentType: string;
  /** Optional text posted alongside the file (Telegram: photo/document caption; Slack: `initial_comment`). */
  caption?: string;
}

export interface CommandContext {
  user: ChatUser;
  /** Raw text after the command name, e.g. `/redo HG-002` → `"HG-002"`. Empty string if none. */
  args: string;
  /**
   * Send a follow-up message as the command's result.
   *
   * IMPORTANT: this is always a *follow-up*, never "the HTTP response" to
   * the command — see §3. Do not assume it completes within any particular
   * time budget from the moment the command was invoked.
   */
  reply(text: string): Promise<ChatMessageRef>;
  replyWithDocument(opts: SendDocumentOptions): Promise<ChatMessageRef>;
}

/**
 * Handles one invocation of a registered command.
 *
 * Contract: this function is invoked *after* the platform has already been
 * satisfied (acked). Do not structure a handler expecting its return/resolve
 * to be what tells the platform "ok, request handled" — by the time this
 * runs, that has already happened. Do slow work (DB reads/writes) here, then
 * report the result via `ctx.reply`/`ctx.replyWithDocument`.
 */
export type CommandHandler = (ctx: CommandContext) => Promise<void>;

export interface ActionContext {
  /** Whoever pressed the button. */
  user: ChatUser;
  /** The `actionId` of the button that was pressed, verbatim — core parses it (e.g. splitting `"rejr:42:staged"`). */
  actionId: string;
  /** The message the button lived on — pass straight through to `updateMessage`. */
  message: ChatMessageRef;
  /**
   * Best-effort, cheap, ephemeral feedback shown only to the presser
   * (Telegram: a toast via `answerCallbackQuery`; Slack: an ephemeral
   * message, since Slack has no toast primitive). Not a substitute for the
   * platform-level ack — the adapter has already satisfied that before this
   * handler ran (see §3) — this is purely a UX nicety layered on top, and
   * callers must not depend on it completing before other work continues.
   * Telegram's `show_alert: true` (a blocking modal popup) has no Slack
   * equivalent; Slack adapters degrade it to the same ephemeral message.
   */
  acknowledge(text?: string): Promise<void>;
}

/**
 * Handles one button press (approve / reject / reject-reason / undo).
 *
 * Same fire-and-forget contract as `CommandHandler`: the platform's ack has
 * already happened by the time this runs. Report results by calling
 * `updateMessage` on `ctx.message` and/or `ctx.acknowledge` — never by
 * returning a value.
 *
 * Must be safe to invoke more than once for the same logical press: Slack
 * retries interaction delivery if its own ack round-trip is slow, so the
 * same tap can arrive twice. Decisions this drives (e.g. `decideGeneration`)
 * must already be idempotent against a re-delivered `actionId` — check
 * "already decided" before writing, the way `bot.ts` already does today.
 */
export type ActionHandler = (ctx: ActionContext) => Promise<void>;

export interface FileUploadContext {
  user: ChatUser;
  fileName: string;
  /** Full file bytes, already downloaded by the adapter (Telegram: `getFile` + fetch; Slack: authenticated GET of `url_private` using the bot token). Core never touches platform download mechanics. */
  content: Buffer;
  reply(text: string): Promise<ChatMessageRef>;
}

/** Same fire-and-forget contract as the other two handler types — see `ActionHandler`. */
export type FileUploadHandler = (ctx: FileUploadContext) => Promise<void>;

export interface ChatAdapter {
  /** Start listening for inbound events (Telegram: begin long-polling; Slack: start the Bolt HTTP server / socket-mode connection). Resolves once ready to receive traffic. */
  start(): Promise<void>;

  /** Stop listening and release any resources (in-flight sends are not guaranteed to complete). */
  stop(): Promise<void>;

  /** Post a generated shot with its initial Approve/Reject buttons. Returns a ref for later `updateMessage`/`markPosted` calls. */
  sendGeneratedShot(opts: SendGeneratedShotOptions): Promise<ChatMessageRef>;

  /** Post a plain text message with no buttons (status replies, import summaries, the notifier's batch header). */
  sendText(text: string): Promise<ChatMessageRef>;

  /**
   * Post an operational alert that bypasses whatever gating a caller applies
   * elsewhere (e.g. the notifier's work-hours window) — this method itself
   * has no gating logic; callers decide when to invoke it. Kept distinct
   * from `sendText` so each adapter is free to render it differently
   * (Telegram: a 🔴 prefix; Slack: e.g. a danger-colored attachment or an
   * `@here` mention) without core needing to know how.
   */
  sendCriticalAlert(text: string): Promise<ChatMessageRef>;

  /** Post a file (the `/export` CSV). */
  sendDocument(opts: SendDocumentOptions): Promise<ChatMessageRef>;

  /**
   * Replace a previously-sent message's text and buttons in place. Always
   * pass the complete new state (see `MessageUpdate`) — there is no partial
   * patch, on Slack or in this interface.
   */
  updateMessage(ref: ChatMessageRef, update: MessageUpdate): Promise<void>;

  /** Register a handler for a named command (no leading slash), e.g. `onCommand("redo", handler)`. */
  onCommand(name: string, handler: CommandHandler): void;

  /** Register a single handler for all button presses across all messages. `ctx.actionId` disambiguates which button/message. */
  onAction(handler: ActionHandler): void;

  /** Register a handler for inbound file uploads (core filters by filename/extension, matching today's `.csv` check in `bot.ts`). */
  onFileUpload(handler: FileUploadHandler): void;
}
```

Two things deliberately left **out** of this interface:

- **Authorization ("is this Ellie?").** Today `isEllie`/`isAuthorizedChat`
  live inside `bot.ts` and check a Telegram-specific numeric id and chat id
  from config. Under this design that check moves to shared core logic
  operating on `ChatUser.id`, driven by a per-platform config value (a new
  `SLACK_ELLIE_USER_ID` alongside the existing `TELEGRAM_ELLIE_USER_ID`).
  The adapter's only responsibility is producing a correct, stable
  `ChatUser` — not deciding who's allowed to write.
- **Which channel/chat to operate in.** Telegram's `chatId` and a future
  Slack `channelId` are adapter *construction* config (env vars passed to
  the adapter's constructor), not part of the shared interface — same
  reasoning as above.

## 2. Slack-specific constraints and idioms this design had to account for

- **3-second ack, always.** Every inbound HTTP request from Slack — slash
  command, block action (button press), or an Events API event — must get an
  HTTP response within 3 seconds, or Slack treats it as failed and (for
  interactivity and events) retries the delivery. This is the constraint
  that shaped `CommandHandler`/`ActionHandler`/`FileUploadHandler` as
  fire-and-forget functions invoked *after* the ack, not functions whose
  return value *is* the ack. See §3 for what breaks if this is missed.
- **Interactivity payloads carry `action_id` + `value` separately**, not one
  free-form string like Telegram's `callback_data`. A Block Kit button needs
  a routing `action_id` (Slack uses this, plus `block_id`, to know which
  registered handler to invoke) and a separate `value` field for payload.
  This design's `ChatButton.actionId` (e.g. `"rejr:42:staged"`) maps to
  Block Kit's `value`; the Slack adapter supplies a single constant
  `action_id` (e.g. `"shot_button"`) for every button in this app, and
  dispatches internally by decoding `value`.
- **`chat.update` replaces the whole block array**, not a partial patch —
  already reflected in `MessageUpdate` being a full-state replacement.
- **Slash commands must be individually pre-registered** in the Slack app
  configuration/manifest (name, description, Request URL) — there's no
  Telegram-style "match any `/word` and dispatch." `/start`, `/status`,
  `/review`, `/export`, `/redo` need five separate command registrations.
- **Slash commands and block actions (button presses) are distinct HTTP
  concepts** with separate Request URLs (they can point at the same server/
  route, but Slack treats and signs them as different request types)
  — reflected in `onCommand` and `onAction` being separate registration
  methods rather than one generic "inbound event" callback.
- **File upload/download is not a single "send me the bytes" call.** Posting
  the CSV export uses `files.upload`/the newer external-upload flow
  (`files.getUploadURLExternal` → PUT bytes → `files.completeUploadExternal`)
  rather than Telegram's one-shot `sendDocument`. Reading an uploaded catalog
  CSV requires catching a `file_shared` event (Events API — its own signed,
  3-second-acked HTTP endpoint), then a follow-up authenticated `GET` on the
  file's `url_private` using the bot token — analogous to, but not the same
  call shape as, Telegram's `getFile` + fetch. Both are hidden inside the
  Slack adapter's implementation of `sendDocument`/`onFileUpload`; the
  interface doesn't leak either mechanism.
- **Every inbound request must be signature-verified** (HMAC over the
  request body + timestamp, using the signing secret) before it's trusted —
  a security step Telegram's long-polling model doesn't need at all
  (Telegram simply doesn't push to you; you pull).
- **No blocking modal-popup primitive.** Telegram's
  `answerCallbackQuery({show_alert: true})` interrupts the user with a
  modal. Slack's nearest equivalent (`views.open`) requires a `trigger_id`
  that's only valid for ~3 seconds from the *original* interaction and would
  itself have to be used inside the ack window — not after doing the DB
  work that decides whether to show it. This design does not attempt to
  preserve blocking-alert semantics; `ActionContext.acknowledge` degrades to
  a plain ephemeral message on Slack (see `ActionContext` doc comment).
- **Required OAuth scopes** for a Slack app implementing this interface:
  - `chat:write` — post and update messages (`sendGeneratedShot`, `sendText`,
    `sendCriticalAlert`, `updateMessage`).
  - `commands` — register and receive slash commands (`onCommand`).
  - `files:write` — post the `/export` CSV (`sendDocument`).
  - `files:read` — download an uploaded catalog CSV (`onFileUpload`).
  - `users:read` — resolve a Slack user id to a display name for
    `ChatUser.displayName` (attribution on the decided/undone badge).
  - Interactivity & Shortcuts must be enabled (for `onAction`) and Event
    Subscriptions enabled with `file_shared` (for `onFileUpload`) — both are
    app-configuration toggles with their own Request URLs, not OAuth scopes,
    but are required alongside the scopes above.
  - `chat:write.public` is **not** needed as long as the bot is invited to
    the one operating channel, matching the existing Telegram assumption
    that channel membership is the auth boundary.
- **Recommend `@slack/bolt` over raw HTTP.** Bolt bundles the HTTP server,
  signature verification, the ack/`ack()` helper, and typed Block Kit
  builders — it removes an entire class of "forgot to ack in time" or
  "forgot to verify the signature" bugs that a hand-rolled HTTP handler
  would otherwise have to get right itself. It also cleanly separates
  `app.command(...)`, `app.action(...)`, and `app.event(...)` registration,
  which maps directly onto `onCommand`/`onAction`/`onFileUpload`.

## 3. Where a naive, Telegram-shaped design breaks under Slack's ack-then-async model

The single biggest risk in this interface is modeling `CommandHandler` /
`ActionHandler` as "the function whose completion produces the platform's
response" — which is exactly how it reads if you port Telegram's code
directly. In `bot.ts` today, a callback handler does its DB work
(`decideGeneration`, `undecideGeneration`) and *then* calls
`ctx.answerCallbackQuery(...)`, all within one linear `async` function, and
that's fine — Telegram doesn't enforce a hard external ack deadline the way
Slack does. If this interface's `ActionHandler`/`CommandHandler` were
implemented the same way against Slack (i.e., the Slack adapter waits for
the handler promise to resolve, *then* sends the HTTP 200 to Slack), it
breaks concretely:

1. **Timeouts under normal DB latency.** `decideGeneration`/
   `undecideGeneration` are real Postgres round-trips. Any time they (plus
   network jitter) exceed 3 seconds, Slack times out the request and shows
   the user an error/retries it — a button tap that looks like it silently
   failed.
2. **Duplicate processing on retry.** Slack retries an interaction payload
   it didn't get a fast ack for. If the adapter is still awaiting the first
   attempt's DB write when the retry arrives, `decideGeneration` can run
   twice for one tap. The existing `gen.decision !== "pending"` guard in
   `bot.ts` happens to make this idempotent today, but that's incidental —
   this design calls it out explicitly (`ActionHandler`'s doc comment) as a
   requirement, not a side effect, precisely because Slack retries make it a
   real, expected occurrence rather than a rare edge case.
3. **The two-step reject flow needs two independent sends, not one
   response.** Tap 1 (Reject) swaps in the reason buttons; tap 2 (a reason)
   swaps in the decided badge + Undo. A design where "handle the event" and
   "respond to Slack" are the same step can express at most one edit per
   incoming request — which happens to be enough here since each tap *is* a
   separate request, but only if the adapter's ack and the resulting
   `chat.update` are understood as two independent calls (ack now with an
   empty 200; `updateMessage` separately, whenever the handler gets to it).
   A synchronous "handle-and-respond" mental model tends to conflate these
   into one, which works by accident on Telegram and fails the instant the
   handler's work takes any real time on Slack.
4. **Slash commands fail the same way for slow commands.** `/status` runs
   two queries (`statusCounts`, `getMetrics`); `/export` builds a full CSV
   from the DB. Both can plausibly exceed 3 seconds under load. Because
   `CommandContext.reply` is specified as a *follow-up* send (via
   `response_url` or a fresh `chat.postMessage`) rather than "the" response
   Slack is waiting on, this is safe by construction in this design — but
   it's the detail a Telegram-first reading of `ctx.reply(...)` most
   naturally gets wrong, since Telegram's `ctx.reply` really is sending the
   direct response to the update that triggered it, with no separate ack
   step at all.
5. **File-upload import has no response body at all to hang work off of.**
   Slack's Events API ack is an empty `200` — there is no "put your reply in
   the ack" option the way a slash command has. `importCatalogCsv` (which
   parses and writes rows) must run entirely after the ack, with its result
   delivered via a brand-new `sendText`/`ctx.reply` call, never as part of
   "responding to the event." A design that tried to return the import
   summary from the event handler as its acknowledgment would simply have
   nowhere for that data to go.

Net effect on the interface: every inbound handler type here is specified as
**invoked after the platform-level ack, with no return value the platform
ever sees** — results only ever leave the handler through explicit outbound
calls (`reply`, `acknowledge`, `updateMessage`, `sendText`). That's a
slightly heavier contract than Telegram strictly requires, but it's the one
shape that works unmodified on both platforms; specifying it any more
loosely would make the interface look Telegram-compatible while quietly
being unimplementable on Slack under load.
