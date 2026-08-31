# ChatAdapter proposal: Discord

Author's lens: designing/evaluating `ChatAdapter` against a discord.js
(Interactions API) implementation, using `src/telegram/bot.ts` and
`src/telegram/notifier.ts` as the behavioral reference (not a template).
Nothing below adds features beyond what those two files already do:

- **Outbound:** post a generated shot with Approve/Reject buttons tied to a
  `generationId`; post a plain status/text message; post a CSV file (the
  `/export` deliverable); post a critical-failure alert that bypasses
  work-hours gating; edit a message after a decision (Approved / Rejected /
  Undo state, buttons swapped accordingly).
- **Inbound:** `/start`, `/status`, `/review`, `/export`, `/redo <sku>`; a
  two-step reject flow (Reject → pick a reason → recorded); an Undo action;
  a CSV upload (catalog import); a single-writer ("Ellie") permission check
  with everyone else read-only.

---

## 1. Proposed `ChatAdapter` interface

```ts
/**
 * A chat-platform user, normalized to the fields core logic actually reads
 * (permission checks and "decided by" attribution). `id` is always the
 * platform's native user id, stringified, so it can be compared against a
 * configured writer id regardless of whether the underlying platform uses
 * numbers (Telegram) or snowflakes (Discord).
 */
export interface ChatUser {
  id: string;
  displayName: string;
}

/**
 * A durable, platform-native pointer to a previously-sent message — good
 * for the lifetime of the message itself, independent of whatever request
 * or interaction (if any) caused it to be sent or last edited. This is the
 * value that gets persisted in the DB (replacing today's single
 * `telegram_message_id` column with an equally durable pair) so a decision
 * recorded hours or days after the photo was posted can still locate and
 * edit the right message. See section 3 for why this shape matters.
 */
export interface ChatMessageRef {
  channelId: string;
  messageId: string;
}

/** The four things a tap on a generated-shot message's buttons can mean. */
export type DecisionAction = "approve" | "reject" | "reject_reason" | "undo";

/**
 * One button tap on a previously-posted generated-shot message. Emitted by
 * `onDecisionButton`. Carries only what the current Telegram handler reads
 * off `callback_query.data` (action, generation id, reason code) plus the
 * actor and a stable ref to the message that was tapped — everything else
 * (the generation's sku/variant/current decision) is looked up from the DB
 * by core logic, same as today.
 */
export interface DecisionButtonEvent {
  action: DecisionAction;
  generationId: number;
  /** Present only when action === "reject_reason". */
  reasonCode?: string;
  actor: ChatUser;
  messageRef: ChatMessageRef;
  /**
   * MUST be called first, before any slow work (DB writes, network calls),
   * and inside the platform's acknowledgement window (Discord: 3 seconds
   * from receipt; Telegram has no hard deadline but the same call maps to
   * `answerCallbackQuery`). Shows a small transient confirmation to the
   * tapper only — it does NOT edit the original message's visible content.
   * Business logic still calls `editDecisionResult` separately (and can
   * take as long as it needs to before doing so) to actually update what's
   * shown. Keeping these two calls distinct is the whole point — see
   * section 3.
   */
  acknowledge(transientText?: string, opts?: { alert?: boolean }): Promise<void>;
}

/** What a generated-shot message should look like after a decision. */
export type DecisionResultState =
  | {
      /** Reject tap 1: swap Approve/Reject for the reason picker, same message. */
      kind: "reason_picker";
      reasons: { code: string; label: string }[];
    }
  | {
      /** A decision was recorded: show the outcome badge + a single Undo button. */
      kind: "decided";
      decision: "approved" | "rejected";
      reason?: string;
      decidedBy: ChatUser;
      sku: string;
      variantIndex: number;
    }
  | {
      /** Undo: back to the original Approve/Reject pair. */
      kind: "reopened";
      sku: string;
    };

export interface CommandContext {
  /** Raw remainder after the command name, e.g. "HG-002" for "/redo HG-002". */
  args: string;
  actor: ChatUser;
  reply(text: string): Promise<void>;
}

export interface CsvUploadContext {
  filename: string;
  actor: ChatUser;
  /** Fetches the uploaded file's raw text, hiding whatever platform-specific
   *  dance is needed to get the bytes (Telegram: getFile + bot-token URL;
   *  Discord: GET the attachment's CDN url). */
  fetchText(): Promise<string>;
  reply(text: string): Promise<void>;
}

export interface ChatAdapter {
  // ---- lifecycle ---------------------------------------------------------

  /**
   * One-time setup, called once before the adapter starts delivering
   * events, after every `onCommand` call. Telegram implementations can
   * treat this as a no-op; Discord implementations use it to register (or
   * diff-and-sync) slash commands with Discord's Interactions API — Discord
   * commands must be pre-declared server-side, they are not parsed ad hoc
   * from free text the way Telegram's `bot.command(...)` is.
   */
  start(): Promise<void>;

  // ---- outbound: proactive pushes (never in response to a user action) --

  /**
   * Post a newly generated shot with Approve/Reject controls tied to
   * `generationId`. Called by the notifier tick — never in response to a
   * command or button, so there is no "interaction" of any kind backing
   * this call on any platform. Returns the durable ref to persist (in place
   * of today's `telegram_message_id`) and pass to `editDecisionResult`
   * whenever a decision eventually comes in.
   */
  postGeneratedShot(opts: {
    imageUrl: string;
    sku: string;
    variantIndex: number;
    generationId: number;
    shotIdea: string;
    qualityNote?: string;
  }): Promise<ChatMessageRef>;

  /**
   * Post a plain text message. Covers /status, /review, /start, the
   * notifier's "N new shots ready" header, the CSV-import result summary,
   * and the "enough approved shots — done!" nudge.
   */
  postMessage(text: string): Promise<ChatMessageRef>;

  /** Post the /export CSV as a downloadable file attachment. */
  postFile(opts: {
    filename: string;
    content: Buffer | string;
    mimeType?: string;
  }): Promise<ChatMessageRef>;

  /**
   * Post an operational alert. Deliberately bypasses the work-hours gate —
   * this is a systemic-failure signal (bad API key, Luma/S3 outage), not a
   * review ping, so it must go out immediately regardless of time of day.
   */
  postCriticalAlert(text: string): Promise<ChatMessageRef>;

  // ---- outbound: editing a message that was posted at any point in the --
  // ---- past, possibly with no interaction involved at any step ----------

  /**
   * Update a previously-posted generated-shot message to reflect the reason
   * picker, a recorded decision, or a reopen-via-undo, swapping its buttons
   * accordingly. Takes the stable `ChatMessageRef` returned by
   * `postGeneratedShot` (or by a prior `editDecisionResult` call) rather
   * than any live interaction/request context — this must work correctly
   * no matter how long ago the message was posted, how long ago (if ever)
   * a button on it was last tapped, or how long the business logic in
   * between took to run. See section 3 for why this is the load-bearing
   * design decision in this interface.
   */
  editDecisionResult(ref: ChatMessageRef, state: DecisionResultState): Promise<void>;

  // ---- inbound: commands --------------------------------------------------

  /**
   * Register a slash-style command and its handler. Must be called before
   * `start()` — on Discord, the accumulated set drives command registration
   * with the Interactions API (name/description/options are declared up
   * front); on Telegram it's just populating an in-memory dispatch table.
   * `argsHint` documents the expected argument (e.g. "SKU") for platforms
   * that need it declared as a typed option (Discord) or shown in a command
   * picker.
   */
  onCommand(
    name: "start" | "status" | "review" | "export" | "redo",
    handler: (ctx: CommandContext) => Promise<void>,
    opts?: { argsHint?: string },
  ): void;

  /**
   * Fires on a tap of Approve / Reject / a reject-reason choice / Undo, for
   * any generated-shot message previously posted via `postGeneratedShot` or
   * updated via `editDecisionResult`. The handler must call
   * `event.acknowledge()` first — before touching the DB — and only then do
   * the real work, finishing with a separate `editDecisionResult` call.
   */
  onDecisionButton(handler: (event: DecisionButtonEvent) => Promise<void>): void;

  /** Fires when a .csv file is uploaded to the chat (catalog import). */
  onCsvUpload(handler: (ctx: CsvUploadContext) => Promise<void>): void;

  // ---- authorization ------------------------------------------------------

  /**
   * True if `user` is the one permitted writer ("Ellie"). Command and
   * decision-button handlers call this themselves and reply with the
   * read-only notice when false — the adapter only answers the identity
   * question, it doesn't enforce the policy or own the notice copy, since
   * both are core business rules, not transport concerns.
   */
  isAuthorizedWriter(user: ChatUser): boolean;
}
```

Two things deliberately left out of the interface, and why:

- **Chat/channel scoping** (`isAuthorizedChat` in the Telegram code) isn't a
  method here because it's a per-adapter deployment concern, not a runtime
  decision core logic needs to make per-message — a Discord adapter is
  instantiated already bound to one configured channel id, same as the
  Telegram adapter is bound to one `chatId`.
- **Reject reason labels/codes** (`REJECT_REASONS`) stay in core logic and
  are passed into `editDecisionResult`'s `reason_picker` state, rather than
  being hardcoded in the adapter — they're a product decision, not a
  transport one.

---

## 2. Discord-specific constraints/idioms accounted for

- **Slash commands are pre-registered, not free-text parsed.** Telegram's
  `bot.command("redo", ...)` matches on message text at runtime; Discord
  requires declaring `/redo` (and its `sku` string option) with the
  Interactions API ahead of time. `onCommand` collects the full set and
  `start()` is the single point where a Discord implementation syncs them —
  global command updates can take up to ~1 hour to propagate, so a
  guild-scoped registration (this is a single fixed channel/workspace
  deployment) is the right choice, not global commands.
- **Every interaction must get a response, or Discord shows the user a
  visible "This interaction failed."** Telegram lets you silently ignore a
  `callback_query` with no user-visible consequence (though answering it is
  best practice). This is part of why `acknowledge()` is a mandatory first
  call in `onDecisionButton`, not an optional nicety.
- **Component (button) layout limits.** Discord caps action rows at 5
  buttons and 5 rows per message. `REJECT_REASONS` currently has exactly 5
  entries — it fits in one row today but has zero headroom before a second
  row is needed if a reason is ever added.
- **`custom_id` is the only per-click payload**, capped at 100 characters —
  the existing `"rejr:<id>:<code>"` scheme fits comfortably, but it's the
  only place to smuggle state through a click, same constraint as Telegram's
  `callback_data`.
- **File attachments are a different mechanism.** Telegram sends documents
  via `InputFile`/`sendDocument`; Discord attaches files as multipart parts
  on the message create call and hands back a CDN `url` for reads (no
  bot-token-embedded URL dance like Telegram's `getFile`). `postFile` and
  `CsvUploadContext.fetchText()` exist specifically to absorb that
  difference so core logic never sees it.
- **The 3-second ack / 15-minute follow-up token window** — detailed in
  section 3, the most consequential constraint of the four.

---

## 3. The interaction-token-expiry issue

### The mechanism

Every Discord interaction (a slash command invocation or a button click)
comes with its own single-use webhook token. Two hard deadlines apply to it:

1. You must **acknowledge within 3 seconds** of receipt (`deferUpdate`,
   `update`, or a deferred reply) or Discord shows the user a failed
   interaction and discord.js/the gateway drops it.
2. Once acknowledged, that specific token can be used to send follow-ups
   (`interaction.editReply()`, `interaction.followUp()`) for **15 minutes
   total from when the interaction was created** — after that the token is
   dead, permanently, no retry will revive it.

Separately, and importantly: a **bot's own credentials** (its bot token)
can `PATCH` any message the bot has sent, at any channel+message id, at any
time, with no expiry at all —
`PATCH /channels/{channel.id}/messages/{message.id}`. This is the Discord
analogue of Telegram's `editMessageCaption`/`editMessageReplyMarkup`, which
similarly only need `chat_id` + `message_id`, not any request-scoped token.

### Where a Telegram-shaped interface would quietly break

A design that mirrors the Telegram code's data flow too literally treats
"post the shot" and "edit it later with the decision" as two ends of one
continuous request — e.g. an interface where `postGeneratedShot` hands back
something like a live interaction/response handle, and `editDecisionResult`
is expected to reuse it. On Telegram that reads as fine because grammy's
`ctx.editMessageCaption` is *not actually* tied to the callback query's
lifetime — it's calling the general, non-expiring Bot API edit method under
the hood. The illusion of "just edit the message later through the same
context" costs nothing there, so nothing exposes the assumption as false.

On Discord that same shape breaks in two concrete ways:

1. **`postGeneratedShot` has no interaction to begin with.** It's called
   from the notifier tick — a proactive push, never a response to a slash
   command or button. There is no token to capture at that point on any
   platform, but an interface that implicitly expects one for later reuse
   has nothing to hand `editDecisionResult` for the *first* decision made
   on that message.
2. **Even when a button click *does* produce a fresh token, that token
   cannot be assumed to outlive the business logic run in response to it.**
   `decideGeneration` does a DB write, and this codebase already retries
   and backs off around flaky externals (see the Luma 429 retry/backoff
   work) — a slow write, a retry, or a queued/backlogged tick is enough to
   burn past 15 minutes in an unlucky case. Undo makes the failure mode
   obvious even without any of that: it can be tapped anywhere from seconds
   to days after the Approve/Reject edit it's undoing, which itself may have
   been minutes after the original post. There is no single interaction
   token whose 15-minute window spans "post → decide → undo" — by
   construction, nothing token-based can.

### How the proposed interface accounts for it

`editDecisionResult` takes a `ChatMessageRef` (`channelId` + `messageId`) —
a stable pointer that exists independently of whatever request produced or
last touched the message — never an interaction/response object. Concretely:

- `postGeneratedShot` returns a `ChatMessageRef` built from the bot's own
  send call (`channel.send()`'s resulting message id), not from any
  interaction — because there isn't one.
- That ref is what gets persisted (replacing `telegram_message_id` in the
  `generations` table with the same durability guarantee, just channel-
  qualified) so it survives arbitrarily long between posting and a decision.
- `onDecisionButton`'s `event.acknowledge()` is the *only* thing that
  touches the click's own interaction token, and it is used for exactly one
  purpose — satisfying the 3-second ack and optionally showing a transient
  toast (`deferUpdate` under the hood) — never for mutating the message.
- The actual mutation always goes through `editDecisionResult(ref, ...)`,
  implemented on Discord as a bot-token `PATCH` on `channelId`/`messageId`.
  Because that call has no expiry, it is correct whether it runs 50ms after
  the tap or after a retried job runs an hour later, and it is the same
  call whether the edit follows a button tap, an Undo days later, or (in
  principle) a re-render triggered by something other than a click at all.

In short: the interface treats "durable message identity" and "this
particular click's short-lived request" as two different things with two
different methods, because Discord enforces that distinction with a hard
clock and Telegram happens not to — designing to the stricter platform
here is what keeps the same interface correct on the looser one too.
