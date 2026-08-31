/**
 * Slack implementation of ChatAdapter (src/chat/types.ts), using @slack/bolt.
 *
 * Package assumed but NOT installed by this file (see report to
 * coordinator): "@slack/bolt": "^3.21.4".
 *
 * HARD RULE this file exists to satisfy (types.ts, top doc comment): every
 * onCommand/onDecision/onCsvUpload handler runs strictly AFTER the
 * platform-level ack. Concretely here: every Bolt `command`/`action`
 * listener below calls `await ack()` as its first statement, before
 * touching this adapter's registered handler at all. Bolt's Events API
 * listeners (used for CSV upload) have no explicit ack — Bolt itself sends
 * the Events API's empty 200 before invoking the listener, so the same
 * ordering holds there for free.
 *
 * This module has NO static import of "@slack/bolt" — only a dynamic
 * `import()` inside createRealBoltApp, reached only when start() runs
 * without an injected `app`. That keeps this module (and everything that
 * imports it, including tests) loadable even before the dependency is
 * added; slack-blocks.ts already carries all the genuinely dependency-free
 * logic, so what's left here is Bolt wiring.
 */
import type {
  ChatAdapter,
  CommandEvent,
  CsvUploadEvent,
  DecisionEvent,
  GeneratedShotContent,
  MessageRef,
  ShotState,
} from "./types.js";
import {
  buildGeneratedShotBlocks,
  buildMessageRef,
  decodeDecisionValue,
  parseMessageRef,
  shotFallbackText,
  shotStateToBlocks,
  SHOT_ACTION_ID,
} from "./slack-blocks.js";

const COMMAND_NAMES = ["start", "status", "review", "export", "redo"] as const;

// ---------------------------------------------------------------------------
// Minimal shape of the @slack/bolt surface this adapter needs. Defined
// locally (not imported from @slack/bolt) so:
//   (a) this file's own types don't force a real dependency resolution just
//       to type-check the parts that don't need one, and
//   (b) tests can inject a plain object satisfying this shape instead of a
//       real Bolt App — Bolt itself isn't practically mockable in isolation
//       (it wants a live HTTP receiver), but this interface is.
// Loosely typed (many `unknown`/optional fields) because it's tracking
// Bolt's actual runtime shape, not re-deriving its full type surface.
// ---------------------------------------------------------------------------

export interface BoltAckFn {
  (response?: unknown): Promise<void>;
}

export interface BoltRespondFn {
  (message: { text: string; response_type?: "ephemeral" | "in_channel" }): Promise<void>;
}

export interface BoltCommandArgs {
  ack: BoltAckFn;
  respond: BoltRespondFn;
  command: {
    text: string;
    user_id: string;
    user_name?: string;
    channel_id: string;
  };
}

export interface BoltActionArgs {
  ack: BoltAckFn;
  respond: BoltRespondFn;
  body: {
    user: { id: string; username?: string; name?: string };
    actions: Array<{ action_id: string; value?: string }>;
    channel?: { id: string };
    message?: { ts: string };
    container?: { channel_id?: string; message_ts?: string };
  };
}

export interface BoltEventArgs {
  event: {
    type: string;
    file_id?: string;
    user_id?: string;
    channel_id?: string;
    [key: string]: unknown;
  };
}

export interface SlackChatPostMessageResult {
  ts?: string;
  channel?: string;
}

export interface SlackFileInfoResult {
  file: {
    name?: string;
    url_private?: string;
    mimetype?: string;
  };
}

export interface SlackWebClientLike {
  chat: {
    postMessage(args: Record<string, unknown>): Promise<SlackChatPostMessageResult>;
    update(args: Record<string, unknown>): Promise<unknown>;
  };
  files: {
    uploadV2(args: Record<string, unknown>): Promise<unknown>;
    info(args: { file: string }): Promise<SlackFileInfoResult>;
  };
}

/** The subset of a real @slack/bolt `App` this adapter drives. A real App satisfies this structurally with no adapter needed on the production side. */
export interface BoltAppLike {
  client: SlackWebClientLike;
  command(commandName: string, fn: (args: BoltCommandArgs) => Promise<void>): void;
  action(actionId: string, fn: (args: BoltActionArgs) => Promise<void>): void;
  event(eventName: string, fn: (args: BoltEventArgs) => Promise<void>): void;
  start(port?: number): Promise<unknown>;
  stop(): Promise<void>;
}

export interface SlackChatAdapterOptions {
  /** Bot token (`xoxb-...`), scopes: chat:write, files:write, files:read, users:read. */
  botToken: string;
  /** Signing secret, used by Bolt's default receiver to verify inbound requests. */
  signingSecret: string;
  /** The single review channel this adapter posts to / listens in (e.g. "C0123ABC456") — construction config, not part of ChatAdapter itself, matching every source proposal. */
  channel: string;
  /** Port for Bolt's default HTTP receiver (slash commands + interactivity + events all land here). Defaults to 3000. */
  port?: number;
  /**
   * Test-only escape hatch: inject a Bolt-shaped app instead of letting
   * start() construct a real @slack/bolt App. Production callers should
   * never set this.
   */
  app?: BoltAppLike;
}

export class SlackChatAdapter implements ChatAdapter {
  private readonly botToken: string;
  private readonly signingSecret: string;
  private readonly channel: string;
  private readonly port: number;
  private app?: BoltAppLike;

  private commandHandler?: (event: CommandEvent) => void | Promise<void>;
  private decisionHandler?: (event: DecisionEvent) => void | Promise<void>;
  private csvHandler?: (event: CsvUploadEvent) => void | Promise<void>;

  constructor(opts: SlackChatAdapterOptions) {
    this.botToken = opts.botToken;
    this.signingSecret = opts.signingSecret;
    this.channel = opts.channel;
    this.port = opts.port ?? 3000;
    this.app = opts.app;
  }

  // ---- lifecycle ----

  async start(): Promise<void> {
    if (!this.app) {
      this.app = await createRealBoltApp({
        token: this.botToken,
        signingSecret: this.signingSecret,
        port: this.port,
      });
    }
    this.wireListeners(this.app);
    await this.app.start(this.port);
  }

  async stop(): Promise<void> {
    await this.app?.stop();
  }

  // ---- outbound ----

  async sendGeneratedShot(content: GeneratedShotContent): Promise<MessageRef> {
    const blocks = buildGeneratedShotBlocks(content);
    const res = await this.requireApp().client.chat.postMessage({
      channel: this.channel,
      text: `${content.sku} — "${content.shotIdea}" (variant ${content.variantIndex})`,
      blocks,
    });
    return buildMessageRef(this.requireTs(res).channel, this.requireTs(res).ts, content.generationId);
  }

  async sendText(text: string): Promise<MessageRef> {
    const res = await this.requireApp().client.chat.postMessage({ channel: this.channel, text });
    const { channel, ts } = this.requireTs(res);
    return buildMessageRef(channel, ts);
  }

  async sendCriticalAlert(text: string): Promise<MessageRef> {
    const res = await this.requireApp().client.chat.postMessage({
      channel: this.channel,
      text: `:rotating_light: ${text}`,
    });
    const { channel, ts } = this.requireTs(res);
    return buildMessageRef(channel, ts);
  }

  async sendDocument(opts: {
    fileName: string;
    content: Buffer;
    contentType: string;
    caption?: string;
  }): Promise<MessageRef> {
    const client = this.requireApp().client;
    // files.uploadV2's response shape (which message, if any, it lands as)
    // varies across @slack/web-api versions and isn't load-bearing here —
    // this method's returned ref is never replayed into updateShotMessage
    // (only sendGeneratedShot's is, per types.ts), so a best-effort/
    // non-editable ref is acceptable if the upload result doesn't surface
    // a channel/ts.
    await client.files.uploadV2({
      channel_id: this.channel,
      filename: opts.fileName,
      file: opts.content,
      initial_comment: opts.caption,
    });
    return buildMessageRef(this.channel, `upload-${Date.now()}`);
  }

  async updateShotMessage(
    ref: MessageRef,
    context: { sku: string; variantIndex: number },
    state: ShotState,
  ): Promise<void> {
    const parsed = parseMessageRef(ref);
    if (!parsed || parsed.generationId === undefined) {
      throw new Error(`SlackChatAdapter.updateShotMessage: not a shot-message ref: ${ref}`);
    }
    const blocks = shotStateToBlocks(parsed.generationId, context, state);
    const text = shotFallbackText(context);
    const client = this.requireApp().client;
    try {
      await client.chat.update({ channel: parsed.channel, ts: parsed.ts, text, blocks });
    } catch (e) {
      // Best-effort per types.ts: an expired edit window / deleted message
      // shouldn't throw — fall back to a new message conveying the same
      // state. Core has no fallback of its own for a failed update.
      console.error(
        `[slack] chat.update failed for ${ref}, falling back to a new message:`,
        e,
      );
      await client.chat.postMessage({ channel: parsed.channel, text, blocks });
    }
  }

  // ---- inbound registration (must be called before start()) ----

  onCommand(handler: (event: CommandEvent) => void | Promise<void>): void {
    this.commandHandler = handler;
  }

  onDecision(handler: (event: DecisionEvent) => void | Promise<void>): void {
    this.decisionHandler = handler;
  }

  onCsvUpload(handler: (event: CsvUploadEvent) => void | Promise<void>): void {
    this.csvHandler = handler;
  }

  // ---- Bolt wiring ----

  private wireListeners(app: BoltAppLike): void {
    for (const name of COMMAND_NAMES) {
      app.command(`/${name}`, async ({ ack, command }) => {
        // MUST be first: Slack requires this within 3s, before any slow
        // work — see the HARD RULE in this file's header comment.
        await ack();

        const handler = this.commandHandler;
        if (!handler) return;
        const event: CommandEvent = {
          name,
          args: command.text?.trim() ?? "",
          actor: {
            id: command.user_id,
            displayName: command.user_name ?? command.user_id,
          },
        };
        try {
          await handler(event);
        } catch (e) {
          console.error(`[slack] command handler for /${name} failed:`, e);
        }
      });
    }

    app.action(SHOT_ACTION_ID, async ({ ack, respond, body }) => {
      // Same ordering requirement as above.
      await ack();

      const handler = this.decisionHandler;
      const actionPayload = body.actions?.[0];
      if (!handler || !actionPayload?.value) return;

      const decoded = decodeDecisionValue(actionPayload.value);
      if (!decoded) {
        console.error(`[slack] unrecognized decision button value: ${actionPayload.value}`);
        return;
      }

      const channel = body.container?.channel_id ?? body.channel?.id;
      const ts = body.container?.message_ts ?? body.message?.ts;
      if (!channel || !ts) {
        console.error("[slack] decision action payload missing channel/ts");
        return;
      }

      const event: DecisionEvent = {
        action: decoded.action,
        generationId: decoded.generationId,
        reasonCode: decoded.reasonCode,
        actor: {
          id: body.user.id,
          displayName: body.user.username ?? body.user.name ?? body.user.id,
        },
        messageRef: buildMessageRef(channel, ts, decoded.generationId),
        acknowledge: async (toast) => {
          if (!toast) return;
          try {
            await respond({
              text: toast.isWarning ? `⚠️ ${toast.text}` : toast.text,
              response_type: "ephemeral",
            });
          } catch (e) {
            console.error("[slack] acknowledge respond failed:", e);
          }
        },
      };

      try {
        await handler(event);
      } catch (e) {
        console.error("[slack] decision handler failed:", e);
      }
    });

    // Events API: Bolt itself sends the (empty) 200 ack before invoking this
    // listener — there is no explicit ack() argument for `event()` handlers,
    // unlike `command()`/`action()`. The ordering requirement is therefore
    // already satisfied by Bolt before any of the code below runs.
    app.event("file_shared", async ({ event }) => {
      const handler = this.csvHandler;
      if (!handler) return;
      if (event.channel_id && event.channel_id !== this.channel) return;

      try {
        const fileId = event.file_id;
        if (!fileId) return;

        const info = await this.requireApp().client.files.info({ file: fileId });
        const name = info.file.name ?? "";
        if (!name.toLowerCase().endsWith(".csv")) return;

        const url = info.file.url_private;
        if (!url) return;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${this.botToken}` },
        });
        const content = Buffer.from(await res.arrayBuffer());

        const userId = event.user_id ?? "unknown";
        await handler({
          filename: name,
          actor: { id: userId, displayName: userId },
          content,
        });
      } catch (e) {
        console.error("[slack] CSV upload handling failed:", e);
      }
    });
  }

  private requireApp(): BoltAppLike {
    if (!this.app) {
      throw new Error("SlackChatAdapter: start() must be called before sending messages");
    }
    return this.app;
  }

  private requireTs(res: SlackChatPostMessageResult): { channel: string; ts: string } {
    if (!res.ts || !res.channel) {
      throw new Error("SlackChatAdapter: chat.postMessage did not return a channel/ts");
    }
    return { channel: res.channel, ts: res.ts };
  }
}

async function createRealBoltApp(opts: {
  token: string;
  signingSecret: string;
  port: number;
}): Promise<BoltAppLike> {
  // Dynamic, not static: this is the only line in the module that touches
  // "@slack/bolt", and it only runs when start() is called without an
  // injected app — see the file header comment.
  const bolt = await import("@slack/bolt");
  const app = new bolt.App({
    token: opts.token,
    signingSecret: opts.signingSecret,
    port: opts.port,
  });
  return app as unknown as BoltAppLike;
}
