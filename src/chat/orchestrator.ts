import { config } from "../config.js";
import { buildExportCsv } from "../ingest/export.js";
import { importCatalogCsv } from "../ingest/csv.js";
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
import type {
  ChatAdapter,
  CommandEvent,
  CsvUploadEvent,
  DecisionEvent,
  RejectReason,
} from "./types.js";

/** Quick-tap reasons instead of free text — matches "chat, on my phone," two
 *  taps beats typing. Owned by core, not any adapter — see types.ts. */
export const REJECT_REASONS: RejectReason[] = [
  { code: "staged", label: "too staged" },
  { code: "light", label: "lighting/mood off" },
  { code: "prod", label: "product not recognizable" },
  { code: "scene", label: "wrong scene/setting" },
  { code: "other", label: "other" },
];

const READ_ONLY_NOTICE =
  "Only Ellie can do that here. Everyone else has read-only access — /status, /review, and /export work for anyone.";

/** Ellie is the only writer; everyone else in the chat is read-only. See config.ts. */
function isEllie(actorId: string): boolean {
  return actorId === String(config.telegram.ellieUserId);
}

/**
 * Wires the platform-agnostic business logic (commands, decisions, CSV
 * import) onto any ChatAdapter. This is the code that used to live directly
 * inside telegram/bot.ts's grammy handlers — now expressed against the
 * ChatAdapter interface so it's the same regardless of which adapter
 * index.ts constructs.
 */
export function wireChatAdapter(adapter: ChatAdapter): void {
  adapter.onCommand((event) => {
    console.log(`[chat] command /${event.name} "${event.args}" from ${event.actor.displayName} (${event.actor.id})`);
    return handleCommand(adapter, event);
  });
  adapter.onDecision((event) => {
    console.log(
      `[chat] decision ${event.action} gen=${event.generationId} from ${event.actor.displayName} (${event.actor.id})`,
    );
    return handleDecision(adapter, event);
  });
  adapter.onCsvUpload((event) => {
    console.log(`[chat] csv upload "${event.filename}" from ${event.actor.displayName} (${event.actor.id})`);
    return handleCsvUpload(adapter, event);
  });
}

async function handleCommand(adapter: ChatAdapter, event: CommandEvent): Promise<void> {
  switch (event.name) {
    case "start":
      await adapter.sendText(
        "Styled Shots bot online.\n\n" +
          "• Send me a catalog .csv to import new products / a new drop.\n" +
          "• I'll post generated shots here for approve/reject — in sections, one shot idea at a time, so it's clear which photos go together.\n" +
          "• /status — where things stand right now.\n" +
          "• /review — everything still waiting on a decision, oldest first.\n" +
          "• /export — get an updated catalog CSV with statuses + approved links.\n" +
          "• /redo SKU — re-queue a product whose shots were all rejected.",
      );
      return;

    case "review": {
      const [items, queuedNext] = await Promise.all([
        getPendingReviewList(),
        countQueuedForNextWindow(),
      ]);
      const queuedNote =
        queuedNext > 0
          ? `\n\n+ ${queuedNext} more ready and waiting for the next work-hours window (${config.workHours.startHour}:00–${config.workHours.endHour}:00, ${config.teamTimezone}).`
          : "";
      if (items.length === 0) {
        await adapter.sendText(`Nothing waiting on you right now. 🎉${queuedNote}`);
        return;
      }
      const lines = items.map(
        (it) =>
          `• ${it.sku} (${it.name}) — variant ${it.variant_index}, waiting ${relativeTime(it.created_at)}`,
      );
      await adapter.sendText(
        `📋 ${items.length} awaiting your decision (oldest first):\n\n${lines.join("\n")}\n\nScroll up for the photos + buttons, or they'll come up again next time I post new ones.${queuedNote}`,
      );
      return;
    }

    case "status": {
      const [counts, metrics] = await Promise.all([statusCounts(), getMetrics()]);
      const line = (label: string, key: string) => `${label}: ${counts[key] ?? 0}`;
      const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);
      const usd = (n: number | null) => (n === null ? "—" : `$${n.toFixed(3)}`);
      const reasonLines = metrics.topRejectReasons
        .map((r) => `    • ${r.reason} (${r.count})`)
        .join("\n");
      await adapter.sendText(
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
          `💵 Spend so far: $${metrics.totalSpendUsd.toFixed(2)} (${metrics.totalGenerated} images)` +
            (metrics.wastedSpendUsd > 0
              ? ` — includes $${metrics.wastedSpendUsd.toFixed(2)} lost to storage failures`
              : ""),
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
      return;
    }

    case "export": {
      await adapter.sendText("Building export…");
      const csv = await buildExportCsv();
      await adapter.sendDocument({
        fileName: `catalog-export-${Date.now()}.csv`,
        content: Buffer.from(csv, "utf-8"),
        contentType: "text/csv",
      });
      return;
    }

    case "redo": {
      if (!isEllie(event.actor.id)) {
        await adapter.sendText(READ_ONLY_NOTICE);
        return;
      }
      const sku = event.args.trim().toUpperCase();
      if (!sku) {
        await adapter.sendText("Usage: /redo SKU (e.g. /redo HG-002)");
        return;
      }
      const ok = await requeueProduct(sku);
      await adapter.sendText(
        ok
          ? `${sku} re-queued for generation.`
          : `${sku} isn't in a redo-able state (must be needs_redo or error).`,
      );
      return;
    }
  }
}

// Approve / reject buttons on a generated shot.
// Flow: "❌ Reject" tap 1 swaps in reason buttons (still same message, no
// typing needed); tap 2 (reject_reason) records the decision + reason.
// "approve" needs no second step. Either way, the finished message gets a
// single Undo control in place of the original ones — no stale buttons
// that silently no-op, and mis-taps are recoverable (until exported).
async function handleDecision(adapter: ChatAdapter, event: DecisionEvent): Promise<void> {
  if (!isEllie(event.actor.id)) {
    await event.acknowledge({ text: READ_ONLY_NOTICE, isWarning: true });
    return;
  }

  const gen = await getGeneration(event.generationId);
  if (!gen) {
    await event.acknowledge({ text: "Not found (already handled?)" });
    return;
  }

  if (event.action === "undo") {
    const result = await undecideGeneration(event.generationId);
    if (!result.ok) {
      await event.acknowledge({
        text:
          result.reason === "already_exported"
            ? "Can't undo — this already went out in an export to the web team."
            : "Nothing to undo.",
        isWarning: result.reason === "already_exported",
      });
      return;
    }
    await event.acknowledge({ text: "Undone — back to pending." });
    await adapter.updateShotMessage(
      event.messageRef,
      { sku: result.sku, variantIndex: gen.variant_index },
      { kind: "reopened" },
    );
    return;
  }

  if (gen.decision !== "pending") {
    await event.acknowledge({ text: `Already ${gen.decision}` });
    return;
  }

  if (event.action === "reject") {
    // Step 1: show reason picker in place of approve/reject.
    await event.acknowledge();
    await adapter.updateShotMessage(
      event.messageRef,
      { sku: gen.sku, variantIndex: gen.variant_index },
      { kind: "reject_reasons", reasons: REJECT_REASONS },
    );
    return;
  }

  const decision = event.action === "approve" ? "approved" : "rejected";
  const reasonLabel =
    event.action === "reject_reason"
      ? (REJECT_REASONS.find((r) => r.code === event.reasonCode)?.label ?? event.reasonCode)
      : undefined;
  const decidedBy = { userId: Number(event.actor.id), username: event.actor.displayName };
  const { sku, approvedCount, applied } = await decideGeneration(
    event.generationId,
    decision,
    decidedBy,
    reasonLabel,
  );

  await event.acknowledge({
    text: decision === "approved" ? "Approved ✅" : "Rejected ❌",
  });

  // Already decided by a concurrent/duplicate delivery -- see the atomic
  // WHERE-guard in decideGeneration. Don't re-render or re-announce.
  if (!applied) return;

  await adapter.updateShotMessage(
    event.messageRef,
    { sku, variantIndex: gen.variant_index },
    { kind: "decided", decision, reason: reasonLabel, decidedBy: event.actor },
  );

  if (decision === "approved" && approvedCount === APPROVALS_NEEDED) {
    await adapter.sendText(`🎉 ${sku} has enough approved shots — done!`);
  }
}

async function handleCsvUpload(adapter: ChatAdapter, event: CsvUploadEvent): Promise<void> {
  if (!isEllie(event.actor.id)) {
    await adapter.sendText(READ_ONLY_NOTICE);
    return;
  }

  await adapter.sendText(`Importing ${event.filename}…`);
  try {
    const result = await importCatalogCsv(event.content.toString("utf-8"));
    await adapter.sendText(
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
    await adapter.sendText(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
