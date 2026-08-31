# ChatAdapter proposal — Telegram

Author's lens: Telegram (grammy), reasoning from `src/telegram/bot.ts` and
`src/telegram/notifier.ts` as the reference implementation. This is a proposal
only — no other files were changed.

## 1. Proposed interface

```ts
// ============================================================
// Supporting types
// ============================================================

/**
 * Opaque handle to a message the adapter has already sent, returned so it can
 * be referenced later (e.g. to edit it after a decision). Deliberately a
 * `string`, not the numeric id grammy/Telegram happens to use — see
 * "Where Telegram leaked in" below for why `number` would be a mistake here.
 */
export type MessageRef = string;

/** A person interacting with the bot, normalized to a platform-neutral shape. */
export interface ChatSender {
  /** Stable per-platform user id, always as a string (Telegram's id is numeric,
   *  Slack's is "U0123...", WhatsApp's is a phone number — all fit as strings). */
  id: string;
  /** Best available display name (username, first name, contact name, ...). */
  displayName: string;
}

/** One entry in the fixed reject-reason list Ellie picks from. */
export interface RejectReason {
  /** Short, stable machine key (e.g. "staged"). Never shown to the user. */
  code: string;
  /** Human-readable label shown on the picker (e.g. "too staged"). */
  label: string;
}

/** Everything needed to render one generated shot for review. */
export interface GeneratedShotContent {
  generationId: number;
  sku: string;
  variantIndex: number;
  shotIdea: string;
  /** Optional pre-screen warning (e.g. auto-quality-check flag) shown alongside the shot. */
  qualityNote?: string;
  /** Fetchable URL to the image (currently a signed, time-limited S3 URL). */
  imageUrl: string;
}

/**
 * The button state a shot-review message can be in. Modeled as a closed set
 * of states (rather than a raw list of {label, action} pairs) so the adapter
 * — not core — owns how much can actually be packed into a native button
 * payload on its platform.
 */
export type ShotButtons =
  | { kind: "decide"; generationId: number } // Approve / Reject
  | { kind: "reject-reasons"; generationId: number; reasons: RejectReason[] } // reason picker (reject, step 1)
  | { kind: "undo"; generationId: number } // single Undo button
  | { kind: "none" }; // no buttons (terminal / unrecoverable state)

/** One inbound tap on a shot-review message's buttons. */
export type ShotAction =
  | { type: "approve"; generationId: number; messageRef: MessageRef; sender: ChatSender }
  | { type: "reject-start"; generationId: number; messageRef: MessageRef; sender: ChatSender } // reject tap 1: show reasons
  | {
      type: "reject-confirm"; // reject tap 2: reason chosen
      generationId: number;
      reasonCode: string;
      messageRef: MessageRef;
      sender: ChatSender;
    }
  | { type: "undo"; generationId: number; messageRef: MessageRef; sender: ChatSender };

/** Context handed to a registered command handler for one invocation. */
export interface ChatCommandContext {
  /** Command name without the leading slash, e.g. "redo". */
  name: string;
  /** Raw remainder of the message after the command, e.g. "HG-002" for "/redo HG-002". */
  args: string;
  sender: ChatSender;
  /** Reply in the same thread/chat the command came from. */
  reply(text: string): Promise<MessageRef>;
  /** Reply with a file attachment (used by /export). */
  replyWithDocument(filename: string, content: Buffer | string, mimeType: string): Promise<MessageRef>;
}

/** A file a user has sent the bot (catalog CSV import). */
export interface IncomingFile {
  filename: string;
  sender: ChatSender;
  /** Fetches and decodes the file's contents. Async because on most platforms
   *  the upload notification and the bytes are retrieved in separate steps. */
  getText(): Promise<string>;
  reply(text: string): Promise<MessageRef>;
}

// ============================================================
// ChatAdapter
// ============================================================

export interface ChatAdapter {
  /**
   * Begin receiving messages (long-poll, open a socket, register a webhook
   * route — whatever the platform needs). Must resolve once inbound
   * handlers registered via `registerCommand` / `registerFileUpload` /
   * `registerShotAction` are live.
   */
  start(): Promise<void>;

  /** Stop receiving messages and release any connection/resources from `start()`. */
  stop(): Promise<void>;

  /**
   * Post a newly generated shot for review, with Approve/Reject controls
   * attached to `content.generationId`. Returns a ref to the sent message so
   * it can be updated later via `updateShotMessage`.
   */
  postGeneratedShot(content: GeneratedShotContent): Promise<MessageRef>;

  /**
   * Update a previously-sent shot-review message to reflect a new caption
   * and button state — used after Approve/Reject/reason-pick/Undo so the
   * message shows the current decision instead of stale controls.
   *
   * Implementations that cannot truly edit a sent message in place (no edit
   * API, or the platform's edit window has expired) should fall back to
   * posting a new message conveying the same state, rather than rejecting —
   * core has no fallback path of its own for a failed update.
   */
  updateShotMessage(ref: MessageRef, caption: string, buttons: ShotButtons): Promise<void>;

  /** Post a plain informational message (command replies, status, headers, etc.). */
  postText(text: string): Promise<MessageRef>;

  /** Post a file attachment proactively (currently just the /export CSV). */
  postDocument(filename: string, content: Buffer | string, mimeType: string): Promise<MessageRef>;

  /**
   * Post an operational alert that must reach Ellie immediately, independent
   * of any review/notification schedule (e.g. work-hours gating). Callers
   * are expected to invoke this directly rather than through whatever
   * batching/gating logic wraps `postGeneratedShot`.
   */
  sendCriticalAlert(text: string): Promise<MessageRef>;

  /**
   * Give lightweight, best-effort feedback in response to a tapped action —
   * e.g. dismiss a loading indicator, or show a brief "Approved" /
   * "Only Ellie can do that" toast. `blocking` requests a more insistent
   * form (e.g. a modal/alert) for messages the user must not miss, such as
   * the permission-denied notice. Adapters for platforms with no such
   * mechanism may no-op this — it is not the only place that information is
   * delivered (see `updateShotMessage` for the durable state on the message
   * itself).
   */
  acknowledgeAction(action: ShotAction, feedback?: { text: string; blocking?: boolean }): Promise<void>;

  /**
   * Register a handler for a slash-style command (name without the slash,
   * e.g. "status", "redo"). Core owns what each command does; the adapter
   * just recognizes the invocation and supplies args + a way to reply.
   */
  registerCommand(name: string, handler: (ctx: ChatCommandContext) => Promise<void>): void;

  /** Register a handler invoked when a user sends a file (catalog CSV import). */
  registerFileUpload(handler: (file: IncomingFile) => Promise<void>): void;

  /** Register a handler invoked for every inbound shot-review button tap. */
  registerShotAction(handler: (action: ShotAction) => Promise<void>): void;

  /**
   * Whether `sender` is Ellie — the one identity allowed to perform mutating
   * actions (decide/undo, redo, CSV import). Everyone else is read-only.
   * Owned by the adapter because what counts as "the same person" is a
   * platform-specific id comparison (config supplies the platform-specific
   * Ellie id).
   */
  isAuthorized(sender: ChatSender): boolean;
}
```

## 2. Telegram-specific constraints/idioms accounted for

- **`callback_data` ≤ 64 bytes.** Every button payload has to fit in that
  budget, which is why the current code encodes `"appr:<id>"` /
  `"rej:<id>"` / `"rejr:<id>:<reasonCode>"` / `"undo:<id>"` as terse
  colon-joined strings and why `REJECT_REASONS` uses short machine codes
  (`staged`, `light`, `prod`, `scene`, `other`) instead of free text. The
  proposed interface pushes this encoding entirely into the adapter
  (`ShotButtons` / `ShotAction` carry structured fields, not pre-joined
  strings) so a tighter- or looser-budget platform doesn't have to touch core.
- **`sendPhoto` takes a URL and Telegram fetches it server-side.** No
  re-upload of image bytes is needed, so `postGeneratedShot` was written to
  accept `imageUrl: string` rather than a `Buffer`. This is a real assumption
  the interface bakes in (see below) — not every platform can do this.
- **`editMessageCaption` / `editMessageReplyMarkup` work on any message the
  bot sent, indefinitely.** There's no separate "commit" step and no
  observed expiry, which is why `decideGeneration`/`undecideGeneration` can
  always be reflected by editing the original message rather than posting a
  follow-up. `updateShotMessage`'s doc comment calls out that this is an
  assumption other adapters may not get to keep.
- **Long polling (`bot.start()`).** No public HTTPS endpoint or webhook
  registration is required to receive updates. This doesn't affect the
  interface shape (`start()`/`stop()` stay opaque to how connection happens)
  but it is worth flagging as a reason the current single-process deployment
  works with zero extra infrastructure — a webhook-based platform will need
  an HTTP route wired in wherever `start()` is called.
- **Callback queries need an explicit ack (`answerCallbackQuery`).** Tapping
  an inline button leaves a spinner on the client until the bot acknowledges
  it, and the same call doubles as a small toast or a blocking alert dialog
  (`show_alert`). `acknowledgeAction` models this, but it's explicitly
  best-effort in the doc comment since not every platform has an equivalent.
- **One group chat, `chatId` fixed in config.** The bot only acts on
  messages from `config.telegram.chatId` (`isAuthorizedChat`); everything
  else is ignored before it ever reaches command/permission logic. This is
  handled as adapter-internal filtering (config-driven), not exposed as an
  interface method, since which channel(s) an adapter listens on is a
  deployment concern, not something per-call code should have to reason about.

## 3. Where Telegram's shape leaked into the current implementation

- **`MessageRef` as `number`.** `markPosted(item.id, message.message_id)`
  stores Telegram's numeric `message_id` straight into the DB, and every
  `editMessageCaption`/`editMessageReplyMarkup` call implicitly keys off it.
  That's fine for Telegram, but it's not universal: Slack's message
  identifier (`ts`) is a decimal-looking *string*, Discord's is a snowflake
  *string*, and some platforms (SMS/MMS) have no stable server-assigned id
  to edit against at all. The proposal types this as an opaque `MessageRef =
  string` precisely so the DB/notifier layer doesn't quietly assume "message
  ids are numbers" the way the current code does.
- **"Edit forever, no expiry" as a hard assumption.** The whole
  approve/reject/undo flow is built on the premise that
  `editMessageCaption` will just work no matter how much time has passed.
  Telegram genuinely has no edit-window limit for bot messages, but WhatsApp
  Business API messages can't be edited after sending at all, and SMS/MMS
  has no edit primitive whatsoever. `updateShotMessage` had to be given an
  explicit "fall back to posting a new message" escape hatch in its doc
  comment for this reason — without it, the interface would silently assume
  every adapter can do what Telegram can.
- **Passing a bare `imageUrl` and expecting native inline-photo rendering.**
  `sendGeneratedShot` hands Telegram a signed S3 URL and trusts it to fetch,
  embed, and later let the caption on *that same embedded photo* be edited.
  That combination (fetch-by-URL *and* treat the result as an editable
  captioned object) is closer to Telegram/Discord-style unfurling than a
  universal capability — WhatsApp Cloud API requires media to be uploaded to
  Meta's media endpoint first and referenced by a returned media id (no
  arbitrary external fetch), and a URL dropped into a plain SMS just becomes
  a link, not an editable rich object. `postGeneratedShot` keeps
  `imageUrl: string` in the proposal because it's the least-common-denominator
  shape that's easy for every adapter to consume (download it if you must),
  but the "and I can edit it later" half of the current behavior is really a
  Telegram-shaped bonus, not something core should assume always holds.
- **The two-step reject flow is UI convenience, not a protocol.** "Tap
  Reject → reason buttons appear in place → tap a reason" is a nice fit for
  Telegram's inline keyboards (no typing, same message mutates in front of
  you). It's *not* how a reason would naturally get picked over SMS (there's
  no tap target — it'd have to be "reply with a number 1-5") or on a
  platform whose message-editing story is weaker. The proposal keeps the two
  states (`reject-start` / `reject-confirm`) as separate `ShotAction`
  variants specifically so other adapters can implement "pick a reason" any
  way they like (a second text prompt, a modal, a numbered reply) without
  the two-tap shape being baked into core.
- **The "one shared group chat, N read-only viewers, 1 writer (Ellie)"
  model.** `isAuthorizedChat` + `isEllie` together assume a group chat where
  multiple people can watch the same stream of messages and only one has
  write access. That maps naturally onto Telegram/Slack/Discord-style
  channels, but doesn't onto an inherently 1:1 medium like SMS or a WhatsApp
  personal number — there, "read-only viewers" would mean fanning the same
  content out to several separate threads, which is a materially different
  adapter responsibility than filtering taps in one shared thread. The
  proposed interface doesn't solve this (it's out of scope for a Telegram
  proposal), but it's worth flagging before another adapter's design
  assumes a shared channel exists at all.

## Summary

The proposal is a `ChatAdapter` interface (`start`/`stop`,
`postGeneratedShot`, `updateShotMessage`, `postText`, `postDocument`,
`sendCriticalAlert`, `acknowledgeAction`, `registerCommand`,
`registerFileUpload`, `registerShotAction`, `isAuthorized`) plus supporting
types (`MessageRef`, `ChatSender`, `RejectReason`, `GeneratedShotContent`,
`ShotButtons`, `ShotAction`, `ChatCommandContext`, `IncomingFile`) that cover
every outbound and inbound behavior currently in `src/telegram/bot.ts` and
`src/telegram/notifier.ts`, while deliberately keeping Telegram's
`callback_data` string-encoding and numeric message ids out of the type
shapes.

The single most important "Telegram-specific, not universal" flag: the
approve/reject/undo flow depends on being able to edit a sent message's
caption and buttons *indefinitely*, with no commit step or expiry. Telegram
happens to offer that for free, but plenty of chat platforms (WhatsApp
Business API, plain SMS/MMS) can't edit a sent message at all — so
`updateShotMessage` in the proposal is documented as best-effort with a
"post a new message instead" fallback, rather than assuming true in-place
editing is always available the way the current Telegram-only code does.
