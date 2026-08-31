# ChatAdapter proposal — Console/local adapter lens

Author: proposing a platform-agnostic `ChatAdapter` interface, evaluated from the
perspective of a **Console adapter**: no external chat service, no credentials,
no network, no webhook — stdin/stdout (or an in-process test harness) standing
in for Ellie's phone. Used for local dev and automated tests of the pipeline in
`src/worker.ts` / `src/db/index.ts` without ever touching Telegram.

This is a proposal only. Nothing outside this file is modified.

## Source behavior this interface has to cover

Read in full from `src/telegram/bot.ts` and `src/telegram/notifier.ts`:

- **Outbound**
  - Post a generated shot (image + caption) with Approve/Reject buttons tied to a `generationId`.
  - Post a plain status/text message (`/start`, `/status`, `/review`, import results, the "N more ready" header).
  - Post a CSV document (the `/export` deliverable).
  - Post a critical-failure alert that bypasses work-hours gating (`sendCriticalAlert`).
  - Edit a previously-sent shot message after a decision: swap in a reason picker (reject step 1), then swap in a final Approved/Rejected/Undo badge + button.
- **Inbound**
  - Slash-style commands: `/start`, `/status`, `/review`, `/export`, `/redo <sku>`.
  - Two-step reject flow: tap Reject → pick a reason from a fixed list → decision recorded with that reason.
  - Undo action on a decided generation.
  - A CSV file upload (catalog import).
  - A permission check: all mutating actions (`/redo`, CSV import, Approve/Reject/Undo) restricted to one identified person ("Ellie"); everyone else is read-only for `/status`, `/review`, `/export`.

## Proposed interface

```ts
/**
 * Platform-agnostic identifier for a person in the chat. Adapters map this
 * to whatever their platform uses internally (Telegram numeric user id,
 * a local username, etc). Business logic never inspects the shape of this
 * string — it only compares it for equality against a configured "Ellie" id
 * and threads it through to `decidedBy` for display/audit purposes.
 */
export type ChatUserId = string;

/** A person in the chat, as reported by the adapter for an inbound event. */
export interface ChatUser {
  id: ChatUserId;
  /** Display name only — never used for auth. */
  displayName: string;
}

/**
 * Opaque handle to a previously-sent message, returned by every "post"
 * method and passed back into `editMessage`. Adapters define their own
 * internal shape; core code only ever stores and replays this value — it
 * never parses, formats, or persists it beyond what `MessageRef` promises
 * (see JSON-serializable constraint below).
 */
export type MessageRef = string;

/** The two live states of a shot's inline controls, expressed platform-agnostically. */
export type ShotControls =
  | { kind: "decide"; generationId: number }
  | { kind: "reject-reasons"; generationId: number; reasons: { code: string; label: string }[] }
  | { kind: "decided"; generationId: number; decision: "approved" | "rejected"; reasonLabel?: string; decidedByName: string; undoable: boolean };

/**
 * Platform-agnostic chat surface for Styled Shots. One adapter instance
 * talks to exactly one review channel (the equivalent of today's single
 * Telegram group chat). All methods are async so a real network-backed
 * adapter can do I/O; a local/console adapter may resolve them synchronously
 * under the hood.
 */
export interface ChatAdapter {
  /**
   * Post a generated shot for review: an image (referenced by URL — never
   * raw bytes, matching the existing signed-S3-URL approach) plus a caption
   * and Approve/Reject controls bound to `generationId`. Returns a
   * `MessageRef` the caller must keep (in `getUnpostedGenerations` /
   * `markPosted` terms) so a later decision can edit this exact message.
   */
  postShot(opts: {
    generationId: number;
    imageUrl: string;
    sku: string;
    variantIndex: number;
    shotIdea: string;
    /** e.g. an auto-quality-check warning shown inline, never blocking. */
    qualityNote?: string;
  }): Promise<MessageRef>;

  /**
   * Post a plain text message with no interactive controls — status
   * replies, the /review listing, import results, the "N new shots ready"
   * header. `replyTo`, when given, threads the message as a reply to an
   * inbound command (adapters that have no threading concept may ignore it).
   */
  postText(text: string, opts?: { replyTo?: MessageRef }): Promise<MessageRef>;

  /**
   * Post a document (the CSV export) as a downloadable file, not inline
   * text. `filename` is a hint for adapters that expose one (e.g.
   * Telegram's document name); a console adapter may just write it to disk
   * and print the path instead of literally "sending" bytes anywhere.
   */
  postDocument(opts: { filename: string; contents: string | Buffer; mimeType: string }): Promise<MessageRef>;

  /**
   * Post an operational alert that bypasses whatever scheduling/gating
   * wraps `postShot`/`postText` (e.g. work-hours). Kept as its own method,
   * not a flag on postText, so an adapter can route it differently (a
   * separate on-call channel) without the caller knowing.
   */
  postCriticalAlert(text: string): Promise<MessageRef>;

  /**
   * Replace the controls (and, where the platform supports it, the caption)
   * on a message previously returned by `postShot`. Used for all three
   * transitions: decide-buttons → reject-reason-buttons, either → decided
   * badge + Undo, decided → decide-buttons again (undo). `caption`, when
   * given, replaces the visible text; omit to leave it and change only the
   * controls.
   */
  editShotControls(ref: MessageRef, controls: ShotControls, caption?: string): Promise<void>;

  /**
   * Register the handler(s) that receive every inbound event this platform
   * can produce (commands, button taps, file uploads). One call, made once
   * at startup — mirrors grammy's own `bot.command(...)` / `bot.on(...)`
   * registration but collapsed into a single `ChatAdapter`-level surface so
   * core code depends on one shape regardless of platform. The adapter is
   * responsible for translating its native event format into these.
   */
  onEvent(handler: (event: ChatEvent) => void | Promise<void>): void;

  /**
   * Acknowledge receipt of an interactive event (e.g. Telegram's
   * "answerCallbackQuery", which must fire within ~30s or the client shows
   * a stuck spinner). `toast`, when given, is shown as a transient
   * confirmation/error to the user. Adapters with no such requirement
   * (console) can make this a no-op that still honors `toast` by printing
   * it. Kept separate from `editShotControls` because the two can fire
   * independently (e.g. permission-denied: toast only, no edit).
   */
  acknowledge(event: ChatEvent, toast?: { text: string; isWarning?: boolean }): Promise<void>;
}

/** Union of everything an adapter can hand to the registered event handler. */
export type ChatEvent =
  | { type: "command"; name: "start" | "status" | "review" | "export"; user: ChatUser; ref: MessageRef }
  | { type: "command"; name: "redo"; args: string; user: ChatUser; ref: MessageRef }
  | { type: "decision"; action: "approve" | "reject" | "undo"; generationId: number; shotRef: MessageRef; user: ChatUser }
  | { type: "reject-reason"; generationId: number; reasonCode: string; shotRef: MessageRef; user: ChatUser }
  | { type: "catalog-upload"; filename: string; contents: string; user: ChatUser };
```

Notes on a couple of choices, since they're the ones most likely to get pushback:

- `REJECT_REASONS` itself (the fixed reason list + labels) stays in core code,
  not the adapter — the adapter only needs to *render* whatever list
  `postShot`'s caller feeds it via `ShotControls.reject-reasons.reasons`, so a
  future platform-specific reason set doesn't require a `ChatAdapter` change.
- Permission checking (`isEllie` / read-only notice) is deliberately **not**
  part of this interface. It stays core-side, operating on `event.user.id`
  against a configured "Ellie" id, so the identity rule is enforced once
  regardless of adapter and no adapter can accidentally skip it. The adapter's
  only job is to honestly report who sent an event.

## Testability / credential-free constraints accounted for

- **No network round-trip in the type signatures.** Every method returns a
  `Promise`, but nothing in the interface *requires* an adapter to hit a
  network — a Console adapter resolves `postShot` etc. synchronously
  (wrapped in `Promise.resolve`), so tests run at in-process speed with no
  sockets, no rate limits, no flakiness from an external API.
- **No platform-issued IDs baked into the contract.** `MessageRef` is an
  opaque string the adapter itself mints (Console can use an incrementing
  counter or a UUID) — nothing requires it to look like a Telegram
  `message_id` (a number) or be issued by a remote service. Core code
  (`markPosted`, `getUnpostedGenerations`) already stores whatever value it's
  given as an opaque reference, so this doesn't need a schema change there.
- **No webhook / inbound HTTP endpoint assumed.** `onEvent` is a plain
  in-process callback registration. A real Telegram/Slack adapter can satisfy
  it via long-polling or (their own) webhook internally — but the interface
  itself never mentions HTTP, ports, or signature verification, so Console
  can just call the registered handler directly from test code.
- **A test can drive the whole pipeline with plain function calls.** No
  simulated keypresses, no fake HTTP requests, no timing races against a
  poll loop. See "Simulating input" below.
- **No credentials anywhere in the interface.** No bot token, chat id, or API
  key appears in any method signature — those are adapter *construction*
  concerns (env vars, DI), not part of the shape core code depends on. A
  `new ConsoleChatAdapter()` needs zero configuration to be fully functional.
- **Deterministic, inspectable output.** Everything Console "sends" is just a
  value held in memory (see `sentMessages` below) that a test can assert on
  directly, rather than needing to scrape rendered chat markup or parse a
  transcript.
- **Two-step reject flow must be replayable without real button state.**
  Telegram's flow depends on the actual message's *current* keyboard (tap
  Reject → server mutates that message's markup → tap a reason). Console
  can't rely on any real button existing, so `simulateReject` (below) drives
  both taps itself — first the "reject" event, then, once the handler has
  called `editShotControls` to swap in the reason picker, the
  "reject-reason" event for the chosen code — checking the recorded
  `ShotControls` state in between exactly as a real UI would, but without any
  actual rendering or user interaction.

## Where a naive "obvious" design leans on a real network-backed platform

1. **Message IDs as numbers.** Telegram's `message_id` is a number and it's
   tempting to type `MessageRef` (or worse, bake the raw id) as `number`
   everywhere, matching `markPosted(id: number, telegramMessageId: number)`
   in `db/index.ts` today. A Console adapter is fine with numbers too, but a
   *hosted* adapter (Slack `ts` is a decimal-string timestamp, a future web
   adapter might use a UUID) is not. Typing it as an opaque string sidesteps
   this without losing anything Console needs.
2. **`editMessageCaption` vs `editMessageReplyMarkup` as two separate,
   platform-shaped calls.** grammy exposes these as two distinct Bot API
   methods because that's how Telegram's wire protocol is split. A naive
   interface would mirror that split 1:1 into `ChatAdapter`, forcing every
   adapter (including Console, which has no such distinction — it's just
   "redraw this line") to implement two methods that differ only in which
   fields are set. Collapsing them into one `editShotControls(ref, controls,
   caption?)` removes an artifact of Telegram's specific API shape from the
   contract.
2b. **Requiring `acknowledge` to be a real round-trip.** Telegram's
   `answerCallbackQuery` exists purely because Telegram's client shows a
   loading spinner until the server responds within ~30 seconds — a
   platform-specific UX affordance, not a universal chat concept. A naive
   design might *omit* this method entirely (assuming every platform needs
   it) or, worse, make it mandatory with a strict timeout baked into the
   type. Keeping it as a cheap no-op-capable method (and documenting that
   Console can satisfy it trivially) avoids forcing a real-time deadline
   into the contract.
3. **File upload as "adapter fetches the file from the platform's CDN."**
   The current Telegram code (`ctx.api.getFile` → build a
   `https://api.telegram.org/file/...` URL → `fetch` it) bakes "the platform
   hosts the file and hands you a URL to re-download it" into the import
   flow. A naive `ChatAdapter.onCatalogUpload` might mirror that by handing
   core code a URL or file-id and expecting it to fetch. Console has no CDN
   — a locally "uploaded" CSV is just a string already in memory. The
   proposed `catalog-upload` event carries `contents: string` directly, so
   the *adapter* is responsible for however it obtains that string (network
   fetch for Telegram, `fs.readFile` or a literal string for Console); core
   code never fetches anything itself.
4. **Requiring outbound calls to prove delivery before returning.** A
   webhook/API-backed platform naturally makes `postShot` a promise that
   only resolves after the platform's server has accepted the message —
   which is fine, but it's tempting to also assume the *return value* must
   carry a platform delivery receipt (e.g. requiring a numeric id proving a
   server round-trip happened). Console has no server to round-trip to, so
   the contract only requires that `MessageRef` be stable and reusable, not
   that its minting prove any network activity occurred.
5. **Assuming one global "chat" configured via a channel/room id at
   construction time is the only addressing concept.** This matches
   Telegram's `chatId` today and Console can trivially satisfy "one
   channel = stdout," so this one *isn't* a real problem for Console
   specifically — but it's worth flagging that the interface intentionally
   does **not** add a `channelId` parameter to every method (unlike a
   Slack-shaped design might), since the brief's whole surface is "one
   review channel," and adding multi-channel addressing now would be
   speculative for every adapter, Console included.
6. **Buttons as an unavoidable part of every outbound message.** A
   Telegram-first design might assume every "shot" message *must* carry an
   inline keyboard object in a Telegram-specific shape (`inline_keyboard:
   [[{text, callback_data}]]`). The proposed `ShotControls` union expresses
   the three states abstractly (decide / reject-reasons / decided) so a
   Console adapter can render them as plain numbered menu options in stdout
   instead of buttons, and a hypothetical read-only or SMS-like adapter
   could render `decide` as "reply APPROVE or REJECT <id>" — the interface
   doesn't presume tappable UI exists at all.

## Simulating input for automated tests (no real chat platform)

The Console adapter should expose test-only methods *beyond* the
`ChatAdapter` interface (they're implementation, not part of the contract
other adapters must satisfy) that construct the same `ChatEvent` values a
real adapter would produce from user taps/messages, and hand them to
whatever handler was registered via `onEvent`:

```ts
export class ConsoleChatAdapter implements ChatAdapter {
  // ...postShot/postText/etc as above...

  /** Every message this adapter has "sent," for tests to assert against. */
  readonly sentMessages: Array<{ ref: MessageRef; kind: "shot" | "text" | "document" | "alert"; /* ...contents */ }>;

  /** Last known controls for each shot message ref, needed to drive the two-step reject flow honestly. */
  private shotState: Map<MessageRef, ShotControls>;

  /** Simulate Ellie (or any user) approving a posted shot. */
  simulateApprove(generationId: number, user?: ChatUser): Promise<void>;

  /**
   * Simulate the full two-tap reject flow in one call: emits the
   * "reject" tap (which the real handler will answer by re-rendering
   * reason buttons via editShotControls), then immediately emits the
   * "reject-reason" tap for `reasonCode` against the resulting state —
   * exactly what a scripted UI test would do, without any real UI.
   */
  simulateReject(generationId: number, reasonCode: string, user?: ChatUser): Promise<void>;

  /** Simulate tapping Undo on a decided shot. */
  simulateUndo(generationId: number, user?: ChatUser): Promise<void>;

  /** Simulate typing a slash command, e.g. simulateCommand("redo", "HG-002"). */
  simulateCommand(name: string, args?: string, user?: ChatUser): Promise<void>;

  /** Simulate dropping a catalog CSV into the chat. */
  simulateCatalogUpload(filename: string, contents: string, user?: ChatUser): Promise<void>;
}
```

`user` defaults to a fixed `ELLIE_TEST_USER` constant so most test call sites
don't need to think about identity; passing a different `ChatUser` is how a
test exercises the read-only-for-everyone-else path (expects the mutating
handler to see the event, check `event.user.id` itself against configured
Ellie id, and no-op / send the read-only notice — matching how permissioning
is intentionally kept out of the adapter, per above).

This means an end-to-end test of the whole pipeline —
import → generate → notifier posts → `simulateApprove` → assert DB decision
recorded and `sentMessages` shows the "Undo" badge — runs with zero mocks of
`fetch`, zero fake servers, and zero platform credentials, purely against
`ChatAdapter` and the real `db/index.ts` / `worker.ts` / `notifier.ts` core
logic.
