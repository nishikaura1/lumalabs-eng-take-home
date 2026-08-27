import { Bot, InputFile } from "grammy";
import { config } from "../config.js";
import { importCatalogCsv } from "../ingest/csv.js";
import { buildExportCsv } from "../ingest/export.js";
import {
  APPROVALS_NEEDED,
  decideGeneration,
  getGeneration,
  getMetrics,
  requeueProduct,
  statusCounts,
} from "../db/index.js";

// Quick-tap reasons instead of free text — matches "chat, on my phone,"
// two taps beats typing. Keys are what travels in callback_data; keep short.
const REJECT_REASONS: Record<string, string> = {
  staged: "too staged",
  light: "lighting/mood off",
  prod: "product not recognizable",
  scene: "wrong scene/setting",
  other: "other",
};

export const bot = new Bot(config.telegram.botToken);

function isAuthorizedChat(chatId: number): boolean {
  return String(chatId) === config.telegram.chatId;
}

bot.command("start", async (ctx) => {
  await ctx.reply(
    "Styled Shots bot online.\n\n" +
      "• Send me a catalog .csv to import new products / a new drop.\n" +
      "• I'll post generated shots here for approve/reject.\n" +
      "• /status — where things stand right now.\n" +
      "• /export — get an updated catalog CSV with statuses + approved links.\n" +
      "• /redo SKU — re-queue a product whose shots were all rejected.",
  );
});

bot.command("status", async (ctx) => {
  const [counts, metrics] = await Promise.all([statusCounts(), getMetrics()]);
  const line = (label: string, key: string) =>
    `${label}: ${counts[key] ?? 0}`;

  const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);
  const usd = (n: number | null) => (n === null ? "—" : `$${n.toFixed(3)}`);

  const reasonLines = metrics.topRejectReasons
    .map((r) => `    • ${r.reason} (${r.count})`)
    .join("\n");

  await ctx.reply(
    [
      "📊 Status",
      line("Awaiting a Shot Idea", "no_shot_idea"),
      line("Queued", "queued"),
      line("Generating", "generating"),
      line("Awaiting your approval", "awaiting_approval"),
      line("✅ Approved", "approved"),
      line("Needs redo (all rejected)", "needs_redo"),
      line("Errors", "error"),
      "",
      `💵 Spend so far: $${metrics.totalSpendUsd.toFixed(2)} (${metrics.totalGenerated} images)`,
      `Approval rate: ${pct(metrics.approvalRate)} · Cost per approved shot: ${usd(metrics.costPerApprovedUsd)}`,
      reasonLines ? `Top reject reasons:\n${reasonLines}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
});

bot.command("export", async (ctx) => {
  await ctx.reply("Building export…");
  const csv = await buildExportCsv();
  await ctx.replyWithDocument(
    new InputFile(Buffer.from(csv, "utf-8"), `catalog-export-${Date.now()}.csv`),
  );
});

bot.command("redo", async (ctx) => {
  const sku = ctx.match?.toString().trim().toUpperCase();
  if (!sku) {
    await ctx.reply("Usage: /redo SKU (e.g. /redo HG-002)");
    return;
  }
  const ok = await requeueProduct(sku);
  await ctx.reply(
    ok
      ? `${sku} re-queued for generation.`
      : `${sku} isn't in a redo-able state (must be needs_redo or error).`,
  );
});

// Catalog / drop ingestion: drop a .csv into the chat.
bot.on("message:document", async (ctx) => {
  if (!isAuthorizedChat(ctx.chat.id)) return;
  const doc = ctx.message.document;
  if (!doc.file_name?.toLowerCase().endsWith(".csv")) return;

  await ctx.reply(`Importing ${doc.file_name}…`);
  try {
    const file = await ctx.api.getFile(doc.file_id);
    const url = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
    const res = await fetch(url);
    const text = await res.text();
    const result = await importCatalogCsv(text);
    await ctx.reply(
      [
        `Import done: ${result.totalRows} rows.`,
        `${result.newOrChanged} new/changed → queued for generation.`,
        `${result.skipped} already up to date, skipped.`,
        result.errors.length
          ? `${result.errors.length} row(s) had problems:\n` +
            result.errors
              .slice(0, 5)
              .map((e) => `  row ${e.row} (${e.sku ?? "?"}): ${e.message}`)
              .join("\n")
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (e) {
    await ctx.reply(
      `Import failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
});

// Approve / reject buttons on a generated shot.
// Flow: "❌ Reject" tap 1 swaps in reason buttons (still same message, no
// typing needed); tap 2 ("rejr:<id>:<reasonCode>") records the decision +
// reason. "✅ Approve" needs no second step.
bot.on("callback_query:data", async (ctx) => {
  const [action, idStr, reasonCode] = ctx.callbackQuery.data.split(":");
  const id = Number(idStr);
  if (!["appr", "rej", "rejr"].includes(action) || Number.isNaN(id)) {
    await ctx.answerCallbackQuery();
    return;
  }

  const gen = await getGeneration(id);
  if (!gen) {
    await ctx.answerCallbackQuery({ text: "Not found (already handled?)" });
    return;
  }
  if (gen.decision !== "pending") {
    await ctx.answerCallbackQuery({ text: `Already ${gen.decision}` });
    return;
  }

  if (action === "rej") {
    // Step 1: show reason picker in place of approve/reject.
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({
      reply_markup: {
        inline_keyboard: [
          Object.entries(REJECT_REASONS).map(([code, label]) => ({
            text: label,
            callback_data: `rejr:${id}:${code}`,
          })),
        ],
      },
    });
    return;
  }

  const decision = action === "appr" ? "approved" : "rejected";
  const reason = action === "rejr" ? REJECT_REASONS[reasonCode] ?? reasonCode : undefined;
  const { sku, approvedCount } = await decideGeneration(id, decision, reason);

  await ctx.answerCallbackQuery({
    text: decision === "approved" ? "Approved ✅" : "Rejected ❌",
  });

  const badge =
    decision === "approved" ? "✅ Approved" : `❌ Rejected (${reason})`;
  await ctx.editMessageCaption({
    caption: `${sku} — variant ${gen.variant_index}\n${badge}`,
  });

  if (decision === "approved" && approvedCount === APPROVALS_NEEDED) {
    await ctx.reply(`🎉 ${sku} has enough approved shots — done!`);
  }
});

export function sendGeneratedShot(opts: {
  bytes: Buffer;
  sku: string;
  variantIndex: number;
  generationId: number;
  shotIdea: string;
}) {
  return bot.api.sendPhoto(
    config.telegram.chatId,
    new InputFile(opts.bytes, `${opts.sku}-v${opts.variantIndex}.jpg`),
    {
      caption: `${opts.sku} — "${opts.shotIdea}" (variant ${opts.variantIndex})`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: `appr:${opts.generationId}` },
            { text: "❌ Reject", callback_data: `rej:${opts.generationId}` },
          ],
        ],
      },
    },
  );
}
