import { Bot, InputFile } from "grammy";
import { config } from "../config.js";
import { importCatalogCsv } from "../ingest/csv.js";
import { buildExportCsv } from "../ingest/export.js";
import {
  APPROVALS_NEEDED,
  countQueuedForNextWindow,
  decideGeneration,
  getGeneration,
  getMetrics,
  getPendingReviewList,
  requeueProduct,
  statusCounts,
  undecideGeneration,
} from "../db/index.js";
import { relativeTime } from "../util/time.js";

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

/** Ellie is the only writer; everyone else in the chat is read-only. See config.ts. */
function isEllie(userId: number | undefined): boolean {
  return userId === config.telegram.ellieUserId;
}

const READ_ONLY_NOTICE =
  "Only Ellie can do that here. Everyone else has read-only access — /status, /review, and /export work for anyone.";

bot.command("start", async (ctx) => {
  await ctx.reply(
    "Styled Shots bot online.\n\n" +
      "• Send me a catalog .csv to import new products / a new drop.\n" +
      "• I'll post generated shots here for approve/reject.\n" +
      "• /status — where things stand right now.\n" +
      "• /review — everything still waiting on a decision, oldest first.\n" +
      "• /export — get an updated catalog CSV with statuses + approved links.\n" +
      "• /redo SKU — re-queue a product whose shots were all rejected.",
  );
});

bot.command("review", async (ctx) => {
  const [items, queuedNext] = await Promise.all([
    getPendingReviewList(),
    countQueuedForNextWindow(),
  ]);

  const queuedNote =
    queuedNext > 0
      ? `\n\n+ ${queuedNext} more ready and waiting for the next work-hours window (${config.workHours.startHour}:00–${config.workHours.endHour}:00, ${config.teamTimezone}).`
      : "";

  if (items.length === 0) {
    await ctx.reply(`Nothing waiting on you right now. 🎉${queuedNote}`);
    return;
  }
  const lines = items.map(
    (it) =>
      `• ${it.sku} (${it.name}) — variant ${it.variant_index}, waiting ${relativeTime(it.created_at)}`,
  );
  await ctx.reply(
    `📋 ${items.length} awaiting your decision (oldest first):\n\n${lines.join("\n")}\n\nScroll up for the photos + buttons, or they'll come up again next time I post new ones.${queuedNote}`,
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
      line("Ready, queued for work hours", "generated"),
      line("Awaiting your approval", "awaiting_approval"),
      line("✅ Approved", "approved"),
      line("Needs redo (all rejected)", "needs_redo"),
      line("Errors", "error"),
      "",
      `💵 Spend so far: $${metrics.totalSpendUsd.toFixed(2)} (${metrics.totalGenerated} images)`,
      `Approval rate: ${pct(metrics.approvalRate)} · Cost per approved shot: ${usd(metrics.costPerApprovedUsd)}`,
      reasonLines ? `Top reject reasons:\n${reasonLines}` : "",
      metrics.qualityFlagged > 0
        ? `🔎 Auto-check flagged ${metrics.qualityFlagged} shot(s) before you saw them. ` +
          `Reject rate — flagged: ${pct(metrics.flaggedRejectRate)}, clean: ${pct(metrics.cleanRejectRate)}.`
        : "",
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
  if (!isEllie(ctx.from?.id)) {
    await ctx.reply(READ_ONLY_NOTICE);
    return;
  }
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
  if (!isEllie(ctx.from?.id)) {
    await ctx.reply(READ_ONLY_NOTICE);
    return;
  }

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
        result.photoInvalid
          ? `⚠️ ${result.photoInvalid} row(s) have a broken/non-image Photo link — parked as errors, not queued (no spend). Fix the link and re-send the CSV to retry.`
          : "",
        result.duplicateSkus.length
          ? `⚠️ Duplicate SKU(s) in this file, last row wins: ${result.duplicateSkus.join(", ")}`
          : "",
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
// reason. "✅ Approve" needs no second step. Either way, the finished message
// gets a single "↩️ Undo" button in place of the original ones — no stale
// buttons that silently no-op, and mis-taps are recoverable.
bot.on("callback_query:data", async (ctx) => {
  const [action, idStr, reasonCode] = ctx.callbackQuery.data.split(":");
  const id = Number(idStr);
  if (!["appr", "rej", "rejr", "undo"].includes(action) || Number.isNaN(id)) {
    await ctx.answerCallbackQuery();
    return;
  }
  if (!isEllie(ctx.from.id)) {
    await ctx.answerCallbackQuery({ text: READ_ONLY_NOTICE, show_alert: true });
    return;
  }

  if (action === "undo") {
    const result = await undecideGeneration(id);
    if (!result.ok) {
      await ctx.answerCallbackQuery({
        text:
          result.reason === "already_exported"
            ? "Can't undo — this already went out in an export to the web team."
            : "Nothing to undo.",
        show_alert: result.reason === "already_exported",
      });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Undone — back to pending." });
    await ctx.editMessageCaption({
      caption: `${result.sku} — reopened for review`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: `appr:${id}` },
            { text: "❌ Reject", callback_data: `rej:${id}` },
          ],
        ],
      },
    });
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
  const decidedBy = {
    userId: ctx.from.id,
    username: ctx.from.username ?? ctx.from.first_name,
  };
  const { sku, approvedCount } = await decideGeneration(id, decision, decidedBy, reason);

  await ctx.answerCallbackQuery({
    text: decision === "approved" ? "Approved ✅" : "Rejected ❌",
  });

  const badge =
    decision === "approved" ? "✅ Approved" : `❌ Rejected (${reason})`;
  await ctx.editMessageCaption({
    caption: `${sku} — variant ${gen.variant_index}\n${badge}\n— ${decidedBy.username}`,
    reply_markup: {
      inline_keyboard: [[{ text: "↩️ Undo", callback_data: `undo:${id}` }]],
    },
  });

  if (decision === "approved" && approvedCount === APPROVALS_NEEDED) {
    await ctx.reply(`🎉 ${sku} has enough approved shots — done!`);
  }
});

/** Called by the notifier (work-hours gated) — sends via a signed S3 URL, not raw bytes. */
export function sendGeneratedShot(opts: {
  imageUrl: string;
  sku: string;
  variantIndex: number;
  generationId: number;
  shotIdea: string;
  qualityNote?: string;
}) {
  const caption = [
    `${opts.sku} — "${opts.shotIdea}" (variant ${opts.variantIndex})`,
    opts.qualityNote,
  ]
    .filter(Boolean)
    .join("\n");
  return bot.api.sendPhoto(config.telegram.chatId, opts.imageUrl, {
    caption,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `appr:${opts.generationId}` },
          { text: "❌ Reject", callback_data: `rej:${opts.generationId}` },
        ],
      ],
    },
  });
}

/**
 * Bypasses the work-hours gate deliberately — this is an operational alert
 * (systemic failure: bad API key, Luma/S3 outage), not a review ping, so it
 * doesn't wait for the notifier's window. Per direction: no proactive budget
 * alerts, but critical failures are a different category.
 */
export function sendCriticalAlert(text: string) {
  return bot.api.sendMessage(config.telegram.chatId, `🔴 ${text}`);
}

/** A short heads-up line before a batch of new shots lands, not one per photo. */
export function sendNotifierHeader(count: number) {
  return bot.api.sendMessage(
    config.telegram.chatId,
    `🔔 ${count} new shot${count === 1 ? "" : "s"} ready for review:`,
  );
}
