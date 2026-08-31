/**
 * Console/local `ChatAdapter` — a reference implementation with no external
 * chat service, no credentials, and no network I/O. Two jobs:
 *
 *  1. Local dev: renders everything to stdout when `verbose` is on, so the
 *     pipeline can be exercised from a terminal with no bot token / chat id.
 *  2. Automated tests: every "send" is captured in `sentMessages`, every
 *     `updateShotMessage` call in `shotUpdates`, and the `simulateApprove` /
 *     `simulateReject` / `simulateUndo` / `simulateCommand` /
 *     `simulateCatalogUpload` methods let test code drive inbound events
 *     directly — no fake HTTP, no fake platform, no timing races.
 *
 * See docs/chat-adapter-proposals/console.md (the original proposal) and
 * docs/chat-adapter-proposals/SYNTHESIS.md (how it was reconciled into
 * src/chat/types.ts) for the reasoning behind the shape this satisfies.
 */
import type {
  ChatAdapter,
  ChatUser,
  CommandEvent,
  CsvUploadEvent,
  DecisionEvent,
  GeneratedShotContent,
  MessageRef,
  ShotState,
} from "./types.js";

/** Default actor for simulate* calls that don't care who triggered them. */
export const ELLIE_TEST_USER: ChatUser = { id: "console-ellie", displayName: "Ellie" };

/** Every outbound call this adapter has made, in order — for test assertions. */
export type SentMessage =
  | { kind: "shot"; ref: MessageRef; at: Date; content: GeneratedShotContent }
  | { kind: "text"; ref: MessageRef; at: Date; text: string }
  | {
      kind: "document";
      ref: MessageRef;
      at: Date;
      fileName: string;
      content: Buffer;
      contentType: string;
      caption?: string;
    }
  | { kind: "alert"; ref: MessageRef; at: Date; text: string };

/** One `updateShotMessage` call, in order — for test assertions. */
export interface ShotUpdate {
  ref: MessageRef;
  context: { sku: string; variantIndex: number };
  state: ShotState;
  at: Date;
}

/** One `acknowledge()` call made on a `DecisionEvent`, in order. */
export interface Acknowledgement {
  generationId: number;
  action: DecisionEvent["action"];
  toast?: { text: string; isWarning?: boolean };
  at: Date;
}

interface ShotEntry {
  ref: MessageRef;
  content: GeneratedShotContent;
  state: ShotState;
}

export class ConsoleChatAdapter implements ChatAdapter {
  /** Every outbound send call this adapter has made — inspect directly in tests. */
  readonly sentMessages: SentMessage[] = [];
  /** Every updateShotMessage call, in order. */
  readonly shotUpdates: ShotUpdate[] = [];
  /** Every DecisionEvent.acknowledge() call, in order. */
  readonly acknowledgements: Acknowledgement[] = [];

  private readonly verbose: boolean;
  private started = false;
  private nextRefId = 1;
  private readonly shots = new Map<MessageRef, ShotEntry>();
  private readonly refByGenerationId = new Map<number, MessageRef>();

  private commandHandler?: (event: CommandEvent) => void | Promise<void>;
  private decisionHandler?: (event: DecisionEvent) => void | Promise<void>;
  private csvUploadHandler?: (event: CsvUploadEvent) => void | Promise<void>;

  constructor(opts?: { verbose?: boolean }) {
    this.verbose = opts?.verbose ?? false;
  }

  // ---- ChatAdapter: lifecycle ----

  async start(): Promise<void> {
    this.started = true;
    if (this.verbose) console.log("[console-chat] started");
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.verbose) console.log("[console-chat] stopped");
  }

  // ---- ChatAdapter: outbound ----

  async sendGeneratedShot(content: GeneratedShotContent): Promise<MessageRef> {
    const ref = this.mintRef();
    this.shots.set(ref, { ref, content, state: { kind: "decide" } });
    this.refByGenerationId.set(content.generationId, ref);
    this.sentMessages.push({ kind: "shot", ref, at: new Date(), content });
    if (this.verbose) {
      console.log(
        `[console-chat] shot ${ref}: ${content.sku} variant ${content.variantIndex} — "${content.shotIdea}"` +
          (content.qualityNote ? `\n  ${content.qualityNote}` : ""),
      );
    }
    return ref;
  }

  async sendText(text: string): Promise<MessageRef> {
    const ref = this.mintRef();
    this.sentMessages.push({ kind: "text", ref, at: new Date(), text });
    if (this.verbose) console.log(`[console-chat] ${text}`);
    return ref;
  }

  async sendDocument(opts: {
    fileName: string;
    content: Buffer;
    contentType: string;
    caption?: string;
  }): Promise<MessageRef> {
    const ref = this.mintRef();
    this.sentMessages.push({ kind: "document", ref, at: new Date(), ...opts });
    if (this.verbose) {
      console.log(`[console-chat] document ${ref}: ${opts.fileName} (${opts.content.length} bytes)`);
    }
    return ref;
  }

  async sendCriticalAlert(text: string): Promise<MessageRef> {
    const ref = this.mintRef();
    this.sentMessages.push({ kind: "alert", ref, at: new Date(), text });
    if (this.verbose) console.log(`[console-chat] 🔴 ${text}`);
    return ref;
  }

  async updateShotMessage(
    ref: MessageRef,
    context: { sku: string; variantIndex: number },
    state: ShotState,
  ): Promise<void> {
    const entry = this.shots.get(ref);
    if (!entry) {
      // Console can always edit in place (it's just an in-memory map), so
      // there's no real "can't edit" case to fall back from — an unknown
      // ref here means the caller passed a ref this adapter never minted,
      // which is a caller bug worth surfacing loudly rather than silently
      // posting a new message that no test/generationId can find again.
      throw new Error(
        `ConsoleChatAdapter.updateShotMessage: unknown message ref "${ref}" ` +
          `(never returned by sendGeneratedShot on this adapter instance)`,
      );
    }
    entry.state = state;
    this.shotUpdates.push({ ref, context, state, at: new Date() });
    if (this.verbose) {
      console.log(`[console-chat] shot ${ref} (${context.sku} #${context.variantIndex}) -> ${state.kind}`);
    }
  }

  // ---- ChatAdapter: inbound registration ----

  onCommand(handler: (event: CommandEvent) => void | Promise<void>): void {
    this.commandHandler = handler;
  }

  onDecision(handler: (event: DecisionEvent) => void | Promise<void>): void {
    this.decisionHandler = handler;
  }

  onCsvUpload(handler: (event: CsvUploadEvent) => void | Promise<void>): void {
    this.csvUploadHandler = handler;
  }

  // ---- Test helpers (not part of ChatAdapter — Console-only) ----

  /** Simulate typing a slash command, e.g. simulateCommand("redo", "HG-002"). */
  async simulateCommand(name: CommandEvent["name"], args = "", actor: ChatUser = ELLIE_TEST_USER): Promise<void> {
    this.assertStarted();
    if (!this.commandHandler) throw new Error("ConsoleChatAdapter: no onCommand handler registered");
    await this.commandHandler({ name, args, actor });
  }

  /** Simulate dropping a catalog CSV into the chat. */
  async simulateCatalogUpload(
    filename: string,
    content: string | Buffer,
    actor: ChatUser = ELLIE_TEST_USER,
  ): Promise<void> {
    this.assertStarted();
    if (!this.csvUploadHandler) throw new Error("ConsoleChatAdapter: no onCsvUpload handler registered");
    const buf = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
    await this.csvUploadHandler({ filename, actor, content: buf });
  }

  /** Simulate approving a posted shot. */
  async simulateApprove(generationId: number, actor: ChatUser = ELLIE_TEST_USER): Promise<void> {
    await this.fireDecision("approve", generationId, actor);
  }

  /** Simulate tapping Undo on a decided shot. */
  async simulateUndo(generationId: number, actor: ChatUser = ELLIE_TEST_USER): Promise<void> {
    await this.fireDecision("undo", generationId, actor);
  }

  /**
   * Drive the full two-tap reject flow — but, like a real UI, only tap a
   * reason that is actually being displayed. This fires "reject" first and
   * awaits the handler; then, instead of assuming the reason picker exists,
   * it reads back this adapter's OWN live ShotState for the message (i.e.
   * whatever the handler just wrote via updateShotMessage) and only fires
   * "reject_reason" if `reasonCode` is genuinely among the reasons offered
   * there. This is what catches a handler that forgets to transition into
   * reject_reasons, or a test that asks for a reason that was never shown.
   */
  async simulateReject(
    generationId: number,
    reasonCode: string,
    actor: ChatUser = ELLIE_TEST_USER,
  ): Promise<void> {
    this.assertStarted();
    await this.fireDecision("reject", generationId, actor);

    const ref = this.refByGenerationId.get(generationId);
    if (!ref) throw new Error(`ConsoleChatAdapter.simulateReject: no message ever sent for generation ${generationId}`);
    const entry = this.shots.get(ref);
    if (!entry) throw new Error(`ConsoleChatAdapter.simulateReject: message ref "${ref}" missing from live state`);
    if (entry.state.kind !== "reject_reasons") {
      throw new Error(
        `ConsoleChatAdapter.simulateReject: after the reject tap, live ShotState for generation ` +
          `${generationId} is "${entry.state.kind}", not "reject_reasons" — the handler did not present a reason picker`,
      );
    }
    const offered = entry.state.reasons.find((r) => r.code === reasonCode);
    if (!offered) {
      throw new Error(
        `ConsoleChatAdapter.simulateReject: "${reasonCode}" is not among the reasons currently offered ` +
          `(${entry.state.reasons.map((r) => r.code).join(", ") || "none"})`,
      );
    }

    await this.fireDecision("reject_reason", generationId, actor, reasonCode);
  }

  /** Current live ShotState for a generation, or undefined if nothing was ever sent for it. */
  getShotState(generationId: number): ShotState | undefined {
    const ref = this.refByGenerationId.get(generationId);
    return ref ? this.shots.get(ref)?.state : undefined;
  }

  /** The MessageRef minted for a generation's shot message, if one was sent. */
  getRefForGeneration(generationId: number): MessageRef | undefined {
    return this.refByGenerationId.get(generationId);
  }

  // ---- internals ----

  private mintRef(): MessageRef {
    return `console-${this.nextRefId++}`;
  }

  private async fireDecision(
    action: DecisionEvent["action"],
    generationId: number,
    actor: ChatUser,
    reasonCode?: string,
  ): Promise<void> {
    this.assertStarted();
    if (!this.decisionHandler) throw new Error("ConsoleChatAdapter: no onDecision handler registered");
    const ref = this.refByGenerationId.get(generationId);
    if (!ref) {
      throw new Error(
        `ConsoleChatAdapter: no message ever sent for generation ${generationId} — call sendGeneratedShot first`,
      );
    }
    const event: DecisionEvent = {
      action,
      generationId,
      reasonCode,
      actor,
      messageRef: ref,
      acknowledge: async (toast) => {
        this.acknowledgements.push({ generationId, action, toast, at: new Date() });
        if (this.verbose && toast) console.log(`[console-chat] toast: ${toast.text}`);
      },
    };
    await this.decisionHandler(event);
  }

  private assertStarted(): void {
    if (!this.started) {
      throw new Error("ConsoleChatAdapter: call start() before simulating inbound events");
    }
  }
}
