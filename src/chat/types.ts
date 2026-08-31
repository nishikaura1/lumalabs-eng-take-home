/**
 * Platform-agnostic chat interface for Styled Shots.
 *
 * Synthesized from four independent platform-lens proposals (Console/test,
 * Telegram, Slack, Discord — see docs/chat-adapter-proposals/) specifically
 * so no single platform's API shape leaked into this shared contract. See
 * docs/chat-adapter-proposals/SYNTHESIS.md for the reasoning behind every
 * decision below and which proposal drove it.
 */

/** Whoever triggered an inbound event, normalized across platforms. */
export interface ChatUser {
  /** Stable, platform-scoped id, always as a string. Compared against a
   *  configured "Ellie" id by CORE code — adapters never decide
   *  authorization, they only report identity honestly. */
  id: string;
  /** Best-effort display name, for attribution/logging only. Not guaranteed
   *  unique, stable, or even present. */
  displayName: string;
}

/**
 * Opaque handle to a previously-sent message. Adapters mint and interpret
 * this however suits their platform (Telegram: its numeric message_id,
 * stringified; Slack: `${channel}:${ts}`; Discord: `${channelId}:${messageId}`)
 * — core code only ever stores and replays the exact string it was given.
 * A plain string, not a structured object, so the persisted column
 * (`generations.chat_message_ref`) stays a single TEXT field.
 */
export type MessageRef = string;

/** One reject reason Ellie can pick from. Defined by CORE, not the adapter —
 *  see REJECT_REASONS in the old telegram/bot.ts. */
export interface RejectReason {
  code: string;
  label: string;
}

/** Everything needed to render one generated shot for review. */
export interface GeneratedShotContent {
  generationId: number;
  sku: string;
  variantIndex: number;
  shotIdea: string;
  /** Auto-quality-check warning shown inline, never blocking. */
  qualityNote?: string;
  /** Signed, time-limited URL (S3). Never raw bytes — every platform
   *  considered can render/fetch an image by URL directly. */
  imageUrl: string;
}

/**
 * The state a shot-review message's controls/text should reflect. A closed
 * union, not a raw button list — so each adapter (not core) decides how
 * much can be packed into a native button payload (Telegram: 64-byte
 * callback_data; Discord: 100-char custom_id; Slack: a block action value).
 */
export type ShotState =
  | { kind: "decide" } // initial Approve / Reject
  | { kind: "reject_reasons"; reasons: RejectReason[] } // reject tap 1
  | {
      kind: "decided";
      decision: "approved" | "rejected";
      reason?: string;
      decidedBy: ChatUser;
    } // + a single Undo control
  | { kind: "reopened" }; // after Undo — same controls as "decide", distinct label for UI copy/logs

/** One tap on a generated-shot message's controls. */
export interface DecisionEvent {
  action: "approve" | "reject" | "reject_reason" | "undo";
  generationId: number;
  /** Present only when action === "reject_reason". */
  reasonCode?: string;
  actor: ChatUser;
  /** The message that was acted on — pass straight back into updateShotMessage. */
  messageRef: MessageRef;
  /**
   * MUST be called first, before any slow work (DB writes, network calls).
   * Discord/Slack enforce a hard ~3s ack deadline; Telegram has none but
   * the same call maps to answerCallbackQuery. Shows a small transient
   * confirmation/error to the actor only — it does NOT change what's shown
   * on the message. Call updateShotMessage separately for that, whenever
   * the real work finishes (which may be well after this resolves).
   */
  acknowledge(toast?: { text: string; isWarning?: boolean }): Promise<void>;
}

export interface CommandEvent {
  name: "start" | "status" | "review" | "export" | "redo";
  /** Raw remainder after the command name, e.g. "HG-002" for "/redo HG-002". */
  args: string;
  actor: ChatUser;
}

export interface CsvUploadEvent {
  filename: string;
  actor: ChatUser;
  /** Already-fetched file bytes — the adapter hides however its platform
   *  gets them (Telegram: getFile + fetch; Slack: authenticated GET of
   *  url_private; Discord: CDN GET). Core never touches download mechanics. */
  content: Buffer;
}

/**
 * Platform-agnostic chat surface for Styled Shots. One adapter instance
 * talks to exactly one review channel/chat (today's single Telegram group)
 * — which channel is adapter *construction* config, not part of this
 * interface, matching every one of the four source proposals.
 *
 * HARD RULE (see docs/chat-adapter-proposals/SYNTHESIS.md, "the one real
 * disagreement"): every handler registered via onCommand/onDecision/
 * onCsvUpload is invoked strictly AFTER the platform-level ack/response has
 * already happened, and its return value is never what tells the platform
 * "request handled." Results only ever leave a handler through explicit
 * outbound calls (sendText, updateShotMessage, event.acknowledge). This is
 * a Slack hard requirement — Slack times out and retries otherwise — but it
 * costs nothing on Telegram/Discord/Console, so it's specified universally
 * rather than as a Slack-only special case.
 *
 * COROLLARY: because Slack (and potentially others) can redeliver the same
 * tap/command more than once, every handler must be safe to run twice for
 * one logical action. This is enforced at the DB layer — see
 * decideGeneration's atomic `WHERE decision = 'pending'` guard in
 * src/db/index.ts — not trusted to any adapter's own deduping.
 */
export interface ChatAdapter {
  /** Begin receiving events. Must resolve once every onX handler registered before this call is live. */
  start(): Promise<void>;
  /** Stop receiving events and release any connection/resources from start(). */
  stop(): Promise<void>;

  /** Post a newly generated shot with its initial Approve/Reject controls. Returns a ref for later updateShotMessage calls. */
  sendGeneratedShot(content: GeneratedShotContent): Promise<MessageRef>;
  /** Post a plain text message — status replies, headers, import summaries, the "done!" nudge. */
  sendText(text: string): Promise<MessageRef>;
  /** Post a file attachment (currently just the /export CSV). */
  sendDocument(opts: {
    fileName: string;
    content: Buffer;
    contentType: string;
    caption?: string;
  }): Promise<MessageRef>;
  /**
   * Post an operational alert. Bypasses whatever gating the CALLER applies
   * elsewhere (e.g. work-hours) — this method itself has no gating logic;
   * callers decide when to invoke it.
   */
  sendCriticalAlert(text: string): Promise<MessageRef>;

  /**
   * Replace a shot-review message's visible state. Always the complete new
   * state (see ShotState), never a delta/patch. Best-effort: an
   * implementation that cannot truly edit a sent message in place (no edit
   * API, or an expired edit window) should fall back to posting a new
   * message conveying the same state rather than throwing — core has no
   * fallback of its own for a failed update. `context` is intentionally
   * light (no imageUrl/shotIdea) since an edit never re-attaches the image.
   */
  updateShotMessage(
    ref: MessageRef,
    context: { sku: string; variantIndex: number },
    state: ShotState,
  ): Promise<void>;

  /** Register the handler for named commands. Call before start() — platforms needing command pre-registration (Discord) sync the accumulated set inside start(). */
  onCommand(handler: (event: CommandEvent) => void | Promise<void>): void;
  /** Register the handler for every shot-review control tap (approve/reject/reject_reason/undo). */
  onDecision(handler: (event: DecisionEvent) => void | Promise<void>): void;
  /** Register the handler for an inbound catalog CSV upload. */
  onCsvUpload(handler: (event: CsvUploadEvent) => void | Promise<void>): void;
}
