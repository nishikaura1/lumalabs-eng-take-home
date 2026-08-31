import { Bot, InputFile } from "grammy";
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

// ============================================================================
// Pure helpers — callback_data encode/decode, MessageRef encode/decode, and
// ShotState -> button/caption rendering. Kept free of grammy/Bot entirely so
// they're unit-testable without a live bot token; see telegram.test.ts.
// ============================================================================

export type DecisionAction = DecisionEvent["action"]; // "approve" | "reject" | "reject_reason" | "undo"

const ACTION_TO_PREFIX: Record<DecisionAction, string> = {
  approve: "appr",
  reject: "rej",
  reject_reason: "rejr",
  undo: "undo",
};

const PREFIX_TO_ACTION: Record<string, DecisionAction> = {
  appr: "approve",
  rej: "reject",
  rejr: "reject_reason",
  undo: "undo",
};

/** Telegram's hard cap on one inline button's callback_data, in UTF-8 bytes. */
export const CALLBACK_DATA_BYTE_LIMIT = 64;

/**
 * Encodes one decision action into Telegram's callback_data wire format:
 * "<prefix>:<generationId>", or "rejr:<generationId>:<reasonCode>" for the
 * reject-reason picker. Colon-joined and terse on purpose — this whole
 * scheme exists to stay under CALLBACK_DATA_BYTE_LIMIT. Throws rather than
 * silently truncating if a caller ever manages to exceed it (e.g. a reason
 * code far longer than anything in REJECT_REASONS today).
 */
export function encodeCallbackData(
  action: DecisionAction,
  generationId: number,
  reasonCode?: string,
): string {
  const prefix = ACTION_TO_PREFIX[action];
  const data =
    action === "reject_reason" ? `${prefix}:${generationId}:${reasonCode ?? ""}` : `${prefix}:${generationId}`;
  const byteLength = Buffer.byteLength(data, "utf-8");
  if (byteLength > CALLBACK_DATA_BYTE_LIMIT) {
    throw new Error(
      `callback_data exceeds Telegram's ${CALLBACK_DATA_BYTE_LIMIT}-byte limit (${byteLength} bytes): "${data}"`,
    );
  }
  return data;
}

export interface DecodedCallbackData {
  action: DecisionAction;
  generationId: number;
  reasonCode?: string;
}

/** Inverse of encodeCallbackData. Returns null for anything not recognized rather than throwing. */
export function decodeCallbackData(data: string): DecodedCallbackData | null {
  const [prefix, idStr, reasonCode] = data.split(":");
  const action = PREFIX_TO_ACTION[prefix];
  const generationId = Number(idStr);
  if (!action || idStr === undefined || Number.isNaN(generationId)) return null;
  if (action === "reject_reason") {
    if (reasonCode === undefined) return null;
    return { action, generationId, reasonCode };
  }
  return { action, generationId };
}

/**
 * MessageRef minting for this adapter. NOTE this deliberately encodes MORE
 * than just Telegram's numeric message_id — see "Interface friction" in the
 * implementation report: updateShotMessage's `context` param carries no
 * generationId, but rebuilding a message's buttons on every edit requires
 * one (to put back into fresh callback_data). Since MessageRef is opaque to
 * core ("adapters mint and interpret this however suits their platform" —
 * types.ts), this adapter packs both into the ref rather than just the
 * message_id the types.ts doc comment's example suggests.
 */
export function encodeMessageRef(messageId: number, generationId: number): MessageRef {
  return `${messageId}:${generationId}`;
}

export interface DecodedMessageRef {
  messageId: number;
  generationId: number;
}

export function decodeMessageRef(ref: MessageRef): DecodedMessageRef | null {
  const [messageIdStr, generationIdStr] = ref.split(":");
  const messageId = Number(messageIdStr);
  const generationId = Number(generationIdStr);
  if (Number.isNaN(messageId) || Number.isNaN(generationId)) return null;
  return { messageId, generationId };
}

export interface InlineButton {
  text: string;
  callback_data: string;
}
export type InlineKeyboard = InlineButton[][];

const REOPENED_REASON_LABEL_FALLBACK = "no reason given";

/**
 * Maps a ShotState to the inline keyboard that should sit under the
 * message, or undefined for "no buttons". `generationId` comes from the
 * caller (this adapter decodes it out of the MessageRef — see
 * decodeMessageRef) since ShotState itself carries no id.
 */
export function shotStateToKeyboard(generationId: number, state: ShotState): InlineKeyboard | undefined {
  switch (state.kind) {
    case "decide":
    case "reopened":
      return [
        [
          { text: "✅ Approve", callback_data: encodeCallbackData("approve", generationId) },
          { text: "❌ Reject", callback_data: encodeCallbackData("reject", generationId) },
        ],
      ];
    case "reject_reasons":
      return [
        state.reasons.map((r) => ({
          text: r.label,
          callback_data: encodeCallbackData("reject_reason", generationId, r.code),
        })),
      ];
    case "decided":
      return [[{ text: "↩️ Undo", callback_data: encodeCallbackData("undo", generationId) }]];
  }
}

/** Caption for a freshly posted shot (Approve/Reject state, image attached). */
export function buildInitialShotCaption(content: GeneratedShotContent): string {
  return [
    `${content.sku} — "${content.shotIdea}" (variant ${content.variantIndex})`,
    content.qualityNote,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Caption rebuilt on every updateShotMessage call, from the light {sku, variantIndex} context plus the new state. */
export function buildShotCaption(context: { sku: string; variantIndex: number }, state: ShotState): string {
  switch (state.kind) {
    case "decide":
    case "reject_reasons":
      return `${context.sku} — variant ${context.variantIndex}`;
    case "reopened":
      return `${context.sku} — reopened for review`;
    case "decided": {
      const badge =
        state.decision === "approved"
          ? "✅ Approved"
          : `❌ Rejected (${state.reason ?? REOPENED_REASON_LABEL_FALLBACK})`;
      return `${context.sku} — variant ${context.variantIndex}\n${badge}\n— ${state.decidedBy.displayName}`;
    }
  }
}

function chatUserFromTelegramUser(from: { id: number; username?: string; first_name: string } | undefined): ChatUser {
  return {
    id: String(from?.id ?? ""),
    displayName: from?.username ?? from?.first_name ?? "unknown",
  };
}

// ============================================================================
// TelegramChatAdapter
// ============================================================================

const COMMAND_NAMES = ["start", "status", "review", "export", "redo"] as const;

export interface TelegramChatAdapterOptions {
  botToken: string;
  /**
   * The single group chat this adapter serves. Everything else — messages,
   * commands, callback taps from any other chat the bot happens to be a
   * member of — is ignored before it ever reaches a registered handler.
   * (No `isAuthorized`/Ellie check here: per the synthesized ChatAdapter
   * contract, adapters report identity honestly via ChatUser and core does
   * the authorization comparison. This is a narrower thing — which *chat*,
   * not which *user*.)
   */
  chatId: string;
}

export class TelegramChatAdapter implements ChatAdapter {
  readonly bot: Bot;
  private readonly botToken: string;
  private readonly chatId: string;

  private commandHandler?: (event: CommandEvent) => void | Promise<void>;
  private decisionHandler?: (event: DecisionEvent) => void | Promise<void>;
  private csvHandler?: (event: CsvUploadEvent) => void | Promise<void>;

  constructor(opts: TelegramChatAdapterOptions) {
    this.botToken = opts.botToken;
    this.chatId = opts.chatId;
    this.bot = new Bot(opts.botToken);
    this.bot.catch((err) => {
      // grammy has no default error handler; an uncaught one here would take
      // the whole process down over a single bad update. Best-effort log.
      console.error("[telegram] update handling error:", err);
    });
    this.registerGrammyHandlers();
  }

  private isConfiguredChat(chatId: number | undefined): boolean {
    return chatId !== undefined && String(chatId) === this.chatId;
  }

  private registerGrammyHandlers(): void {
    for (const name of COMMAND_NAMES) {
      this.bot.command(name, async (ctx) => {
        if (!this.isConfiguredChat(ctx.chat.id) || !this.commandHandler) return;
        const event: CommandEvent = {
          name,
          args: (ctx.match ?? "").toString().trim(),
          actor: chatUserFromTelegramUser(ctx.from),
        };
        await this.commandHandler(event);
      });
    }

    // Catalog / drop ingestion: drop a .csv into the chat.
    this.bot.on("message:document", async (ctx) => {
      if (!this.isConfiguredChat(ctx.chat.id) || !this.csvHandler) return;
      const doc = ctx.message.document;
      if (!doc.file_name?.toLowerCase().endsWith(".csv")) return;

      const file = await ctx.api.getFile(doc.file_id);
      const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      const res = await fetch(url);
      const content = Buffer.from(await res.arrayBuffer());

      const event: CsvUploadEvent = {
        filename: doc.file_name,
        actor: chatUserFromTelegramUser(ctx.from),
        content,
      };
      await this.csvHandler(event);
    });

    // Approve / reject / reject-reason / undo taps on a generated shot.
    this.bot.on("callback_query:data", async (ctx) => {
      if (!this.isConfiguredChat(ctx.chat?.id)) {
        await ctx.answerCallbackQuery().catch(() => {});
        return;
      }
      const decoded = decodeCallbackData(ctx.callbackQuery.data);
      if (!decoded || !this.decisionHandler) {
        await ctx.answerCallbackQuery().catch(() => {});
        return;
      }

      const messageId = ctx.callbackQuery.message?.message_id;
      const messageRef =
        messageId !== undefined ? encodeMessageRef(messageId, decoded.generationId) : "";

      let acknowledged = false;
      const event: DecisionEvent = {
        action: decoded.action,
        generationId: decoded.generationId,
        reasonCode: decoded.reasonCode,
        actor: chatUserFromTelegramUser(ctx.from),
        messageRef,
        acknowledge: async (toast) => {
          // Idempotency guard: Telegram never redelivers a callback query,
          // but a double-call from core (or a caller not honoring "call me
          // first") would otherwise throw a "query is too old / invalid"
          // error from a second answerCallbackQuery on the same id.
          if (acknowledged) return;
          acknowledged = true;
          try {
            await ctx.answerCallbackQuery(
              toast ? { text: toast.text, show_alert: toast.isWarning === true } : undefined,
            );
          } catch (e) {
            console.error("[telegram] answerCallbackQuery failed:", e);
          }
        },
      };

      await this.decisionHandler(event);
    });
  }

  async start(): Promise<void> {
    let startedPolling = false;
    await new Promise<void>((resolve, reject) => {
      this.bot
        .start({
          onStart: () => {
            startedPolling = true;
            resolve();
          },
        })
        .catch((e) => {
          // bot.start()'s promise only resolves once stop() is called (or
          // polling dies unrecoverably) — it is NOT "resolves once ready"
          // the way this interface's start() must be. onStart fires once
          // getMe() has succeeded and polling has actually begun, which is
          // what we resolve *our* promise on; a failure before that point
          // (bad token, network) should reject start() as expected. A
          // failure *after* polling has begun is grammy's own concern
          // (long-polling error handling / retry), not something that
          // should reject an already-resolved start().
          if (!startedPolling) reject(e);
          else console.error("[telegram] polling loop ended with an error:", e);
        });
    });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  async sendGeneratedShot(content: GeneratedShotContent): Promise<MessageRef> {
    const caption = buildInitialShotCaption(content);
    const keyboard = shotStateToKeyboard(content.generationId, { kind: "decide" })!;
    // Passing the URL directly (not bytes) — Telegram's own servers fetch
    // it. See docs/chat-adapter-proposals/telegram.md for why this doesn't
    // generalize to every platform.
    const message = await this.bot.api.sendPhoto(this.chatId, content.imageUrl, {
      caption,
      reply_markup: { inline_keyboard: keyboard },
    });
    return encodeMessageRef(message.message_id, content.generationId);
  }

  async updateShotMessage(
    ref: MessageRef,
    context: { sku: string; variantIndex: number },
    state: ShotState,
  ): Promise<void> {
    const decoded = decodeMessageRef(ref);
    if (!decoded) {
      throw new Error(`TelegramChatAdapter.updateShotMessage: unrecognized MessageRef "${ref}"`);
    }
    const { messageId, generationId } = decoded;
    const caption = buildShotCaption(context, state);
    const keyboard = shotStateToKeyboard(generationId, state);
    const reply_markup = keyboard ? { inline_keyboard: keyboard } : undefined;

    try {
      await this.bot.api.editMessageCaption(this.chatId, messageId, { caption, reply_markup });
    } catch (e) {
      // Best-effort per the interface contract: fall back to a new message
      // conveying the same state rather than throwing. In practice Telegram
      // has no edit-window expiry, so this realistically only fires if the
      // original message was deleted out from under us.
      console.error(
        `[telegram] editMessageCaption failed for message ${messageId}, posting a fresh message instead:`,
        e,
      );
      await this.bot.api.sendMessage(this.chatId, caption, { reply_markup });
    }
  }

  async sendText(text: string): Promise<MessageRef> {
    const message = await this.bot.api.sendMessage(this.chatId, text);
    return String(message.message_id);
  }

  async sendDocument(opts: {
    fileName: string;
    content: Buffer;
    contentType: string;
    caption?: string;
  }): Promise<MessageRef> {
    // NOTE: `contentType` has no equivalent on Telegram's sendDocument — it
    // infers MIME purely from the filename extension. See "Interface
    // friction" in the implementation report.
    const message = await this.bot.api.sendDocument(this.chatId, new InputFile(opts.content, opts.fileName), {
      caption: opts.caption,
    });
    return String(message.message_id);
  }

  async sendCriticalAlert(text: string): Promise<MessageRef> {
    // Deliberately no work-hours (or any other) gating here — this method
    // just sends; callers decide when it's warranted, per the interface doc.
    const message = await this.bot.api.sendMessage(this.chatId, `🔴 ${text}`);
    return String(message.message_id);
  }

  onCommand(handler: (event: CommandEvent) => void | Promise<void>): void {
    this.commandHandler = handler;
  }

  onDecision(handler: (event: DecisionEvent) => void | Promise<void>): void {
    this.decisionHandler = handler;
  }

  onCsvUpload(handler: (event: CsvUploadEvent) => void | Promise<void>): void {
    this.csvHandler = handler;
  }
}
