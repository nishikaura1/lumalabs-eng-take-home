/**
 * Discord implementation of ChatAdapter (src/chat/types.ts), via discord.js
 * (Interactions API + gateway).
 *
 * Assumed dependency (not yet added to package.json — see the take-home
 * coordinator note): "discord.js": "^14.16.3".
 *
 * All wire-format logic (MessageRef packing, button custom_id encode/decode,
 * ShotState -> components/text rendering) lives in ./discord-protocol.ts and
 * has no discord.js dependency at all, so it's covered by discord.test.ts
 * without needing a live bot or the package installed. This file is the
 * thin networked layer that wires that logic to a real discord.js Client.
 */
import {
  AttachmentBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type Interaction,
  type Message,
  type TextChannel,
} from "discord.js";
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
import {
  decodeCustomId,
  formatShotCaption,
  parseMessageRef,
  serializeMessageRef,
  shotStateToComponents,
} from "./discord-protocol.js";

const COMMAND_NAMES = ["start", "status", "review", "export", "redo"] as const;
type KnownCommandName = (typeof COMMAND_NAMES)[number];

function isKnownCommandName(name: string): name is KnownCommandName {
  return (COMMAND_NAMES as readonly string[]).includes(name);
}

export interface DiscordChatAdapterConfig {
  /** Bot token. Read from env by the caller — never hardcoded. */
  token: string;
  /** The single review channel this adapter instance talks to (matches the
   *  interface's "one adapter, one channel" contract — see types.ts). */
  channelId: string;
  /** Guild to register slash commands in. Guild-scoped rather than global:
   *  guild commands propagate near-instantly, global ones can take up to
   *  ~1h — global registration buys nothing for this single-workspace
   *  deployment and only slows down iterating on commands. */
  guildId: string;
}

function toChatUser(user: { id: string; username: string; globalName?: string | null }): ChatUser {
  return { id: user.id, displayName: user.globalName ?? user.username };
}

export class DiscordChatAdapter implements ChatAdapter {
  private readonly client: Client;
  private readonly cfg: DiscordChatAdapterConfig;
  private commandHandler: ((event: CommandEvent) => void | Promise<void>) | null = null;
  private decisionHandler: ((event: DecisionEvent) => void | Promise<void>) | null = null;
  private csvUploadHandler: ((event: CsvUploadEvent) => void | Promise<void>) | null = null;

  constructor(cfg: DiscordChatAdapterConfig) {
    this.cfg = cfg;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
  }

  onCommand(handler: (event: CommandEvent) => void | Promise<void>): void {
    this.commandHandler = handler;
  }

  onDecision(handler: (event: DecisionEvent) => void | Promise<void>): void {
    this.decisionHandler = handler;
  }

  onCsvUpload(handler: (event: CsvUploadEvent) => void | Promise<void>): void {
    this.csvUploadHandler = handler;
  }

  async start(): Promise<void> {
    this.client.on(Events.InteractionCreate, (interaction) => {
      this.handleInteraction(interaction).catch((e) =>
        console.error("[discord] interaction handler error:", e),
      );
    });
    this.client.on(Events.MessageCreate, (message) => {
      this.handleMessage(message).catch((e) =>
        console.error("[discord] message handler error:", e),
      );
    });

    await this.client.login(this.cfg.token);
    if (!this.client.isReady()) {
      await new Promise<void>((resolve) => this.client.once(Events.ClientReady, () => resolve()));
    }
    await this.registerCommands();
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  /** Slash command registration — see the guildId doc comment on why this is guild-scoped, not global. */
  private async registerCommands(): Promise<void> {
    const appId = this.client.application?.id;
    if (!appId) {
      throw new Error("[discord] no application id available after login — cannot register commands");
    }

    const commands = [
      new SlashCommandBuilder().setName("start").setDescription("Show what this bot does"),
      new SlashCommandBuilder().setName("status").setDescription("Where things stand right now"),
      new SlashCommandBuilder()
        .setName("review")
        .setDescription("Everything still waiting on a decision, oldest first"),
      new SlashCommandBuilder()
        .setName("export")
        .setDescription("Get an updated catalog CSV with statuses + approved links"),
      new SlashCommandBuilder()
        .setName("redo")
        .setDescription("Re-queue a product whose shots were all rejected")
        .addStringOption((opt) =>
          opt.setName("sku").setDescription("SKU to re-queue, e.g. HG-002").setRequired(true),
        ),
    ].map((c) => c.toJSON());

    const rest = new REST({ version: "10" }).setToken(this.cfg.token);
    await rest.put(Routes.applicationGuildCommands(appId, this.cfg.guildId), { body: commands });
  }

  private async channel(): Promise<TextChannel> {
    return this.resolveTextChannel(this.cfg.channelId);
  }

  private async resolveTextChannel(channelId: string): Promise<TextChannel> {
    const ch = await this.client.channels.fetch(channelId);
    if (!ch || ch.type !== ChannelType.GuildText) {
      throw new Error(`[discord] channel ${channelId} is not a resolvable text channel`);
    }
    return ch;
  }

  async sendGeneratedShot(content: GeneratedShotContent): Promise<MessageRef> {
    const ch = await this.channel();
    const text = formatShotCaption(
      { sku: content.sku, variantIndex: content.variantIndex },
      { kind: "decide" },
      { shotIdea: content.shotIdea, qualityNote: content.qualityNote },
    );
    // Signed S3 URL, embedded (not downloaded/re-uploaded) — matches
    // GeneratedShotContent's contract that every platform can render an
    // image straight from imageUrl.
    const embed = new EmbedBuilder().setImage(content.imageUrl);
    const message = await ch.send({
      content: text,
      embeds: [embed],
      components: shotStateToComponents({ kind: "decide" }, content.generationId),
    });
    return serializeMessageRef(ch.id, message.id);
  }

  async sendText(text: string): Promise<MessageRef> {
    const ch = await this.channel();
    const message = await ch.send({ content: text });
    return serializeMessageRef(ch.id, message.id);
  }

  async sendDocument(opts: {
    fileName: string;
    content: Buffer;
    contentType: string;
    caption?: string;
  }): Promise<MessageRef> {
    const ch = await this.channel();
    const attachment = new AttachmentBuilder(opts.content, { name: opts.fileName });
    const message = await ch.send({ content: opts.caption, files: [attachment] });
    return serializeMessageRef(ch.id, message.id);
  }

  async sendCriticalAlert(text: string): Promise<MessageRef> {
    const ch = await this.channel();
    const message = await ch.send({ content: `🔴 ${text}` });
    return serializeMessageRef(ch.id, message.id);
  }

  /**
   * Edits the message directly via the bot's own token — `channel.messages
   * .edit()`, which is a plain authenticated REST PATCH keyed only on
   * channelId/messageId — and NEVER via any interaction follow-up webhook.
   *
   * This is the load-bearing decision flagged in
   * docs/chat-adapter-proposals/discord.md: a follow-up webhook token is
   * only valid for 15 minutes from whichever interaction minted it, but
   * Undo can fire arbitrarily long after that (and the original
   * sendGeneratedShot post has no interaction behind it at all — it's a
   * proactive notifier push). The bot-token PATCH path has no such expiry,
   * so it's correct regardless of how much time has passed since anything.
   *
   * Interface friction: updateShotMessage's `context` deliberately doesn't
   * carry `generationId` (only sku/variantIndex — see types.ts's doc on
   * why). But every button rendered for `state` needs the generationId
   * baked into its custom_id so a future tap can be routed back to the
   * right generation. Recovered here from the message's OWN current
   * buttons (every message this adapter ever renders always has at least
   * one button whose custom_id already encodes it, from the very first
   * sendGeneratedShot call) rather than requiring an interface change.
   */
  async updateShotMessage(
    ref: MessageRef,
    context: { sku: string; variantIndex: number },
    state: ShotState,
  ): Promise<void> {
    const { channelId, messageId } = parseMessageRef(ref);
    let ch: TextChannel;
    try {
      ch = await this.resolveTextChannel(channelId);
    } catch (e) {
      console.error(`[discord] updateShotMessage: cannot resolve channel for ${ref}:`, e);
      return;
    }

    try {
      const message = await ch.messages.fetch(messageId);
      const generationId = this.recoverGenerationId(message);
      await message.edit({
        content: formatShotCaption(context, state),
        components: shotStateToComponents(state, generationId),
      });
    } catch (e) {
      // Best-effort per the interface contract (types.ts): fall back to a
      // new message conveying the same state rather than throwing. The
      // fallback message is necessarily non-interactive — there is no
      // in-place message left to attach working buttons to.
      console.error(
        `[discord] updateShotMessage: in-place edit failed for ${ref}, posting a fallback message:`,
        e,
      );
      await ch.send({ content: formatShotCaption(context, state) });
    }
  }

  private recoverGenerationId(message: Message): number {
    for (const row of message.components) {
      for (const comp of row.components) {
        if ("customId" in comp && comp.customId) {
          const decoded = decodeCustomId(comp.customId);
          if (decoded) return decoded.generationId;
        }
      }
    }
    throw new Error(
      `[discord] could not recover generationId from message ${message.id}'s existing buttons`,
    );
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isChatInputCommand()) {
      await this.handleCommandInteraction(interaction);
      return;
    }
    if (interaction.isButton()) {
      await this.handleButtonInteraction(interaction);
    }
  }

  private async handleCommandInteraction(
    interaction: Extract<Interaction, { isChatInputCommand: () => true }>,
  ): Promise<void> {
    // Ack within Discord's 3s budget. The real response is a normal channel
    // post via sendText() (matching Telegram's plain, publicly-visible
    // reply) issued later by core, so there's nothing useful to put in this
    // interaction's own reply — acknowledge quietly and clean up.
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    interaction.deleteReply().catch(() => {});

    const name = interaction.commandName;
    if (!isKnownCommandName(name)) return;
    const args = name === "redo" ? interaction.options.getString("sku") ?? "" : "";

    await this.commandHandler?.({
      name,
      args,
      actor: toChatUser(interaction.user),
    });
  }

  private async handleButtonInteraction(
    interaction: Extract<Interaction, { isButton: () => true }>,
  ): Promise<void> {
    const decoded = decodeCustomId(interaction.customId);
    if (!decoded) {
      // Stale/foreign button (e.g. a message re-rendered by a later deploy
      // with a changed scheme). Ack silently rather than leaving the
      // tapper's client showing "This interaction failed."
      await interaction.deferUpdate().catch(() => {});
      console.warn(`[discord] unrecognized custom_id: ${interaction.customId}`);
      return;
    }

    const event: DecisionEvent = {
      action: decoded.action,
      generationId: decoded.generationId,
      reasonCode: decoded.reasonCode,
      actor: toChatUser(interaction.user),
      messageRef: serializeMessageRef(interaction.channelId, interaction.message.id),
      acknowledge: async (toast) => {
        if (toast) {
          await interaction.reply({
            content: `${toast.isWarning ? "⚠️ " : ""}${toast.text}`,
            ephemeral: true,
          });
        } else {
          await interaction.deferUpdate();
        }
      },
    };

    await this.decisionHandler?.(event);
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (message.channelId !== this.cfg.channelId) return;
    if (!this.csvUploadHandler) return;

    const attachment = [...message.attachments.values()].find((a) =>
      a.name?.toLowerCase().endsWith(".csv"),
    );
    if (!attachment) return;

    // No platform ack applies here — unlike interactions/slash-commands,
    // gateway MessageCreate events have no response deadline, so it's safe
    // to run the handler directly.
    const res = await fetch(attachment.url);
    const content = Buffer.from(await res.arrayBuffer());
    await this.csvUploadHandler({
      filename: attachment.name ?? "upload.csv",
      actor: toChatUser(message.author),
      content,
    });
  }
}
