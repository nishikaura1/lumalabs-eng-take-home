import { config } from "../config.js";
import { getNextUnpostedProductGroup, markPosted } from "../db/index.js";
import { signedUrlFor } from "../storage/s3.js";
import { isWorkHours } from "../util/workhours.js";
import type { ChatAdapter } from "./types.js";

/**
 * This is the work-hours gate: generation (worker.ts) runs continuously,
 * but Ellie is only ever pinged inside config.workHours. Outside that
 * window this is a no-op and ready shots simply queue as status='generated'
 * — nothing is lost, it just waits for the next tick where isWorkHours()
 * is true. Platform-agnostic: takes whatever ChatAdapter index.ts wires up.
 *
 * Posts one PRODUCT's full candidate set at a time, oldest product first —
 * never interleaved with another product's variants — up to
 * notifier.batchSize images per tick. A group is always posted whole even
 * if that pushes slightly past batchSize; the budget caps how many groups
 * a tick *starts*, not how a group is split, since splitting one product's
 * candidates across two batches/headers is the exact interleaving problem
 * this is meant to avoid.
 */
export async function runNotifierTick(adapter: ChatAdapter): Promise<void> {
  if (!isWorkHours()) return;

  let posted = 0;
  while (posted < config.notifier.batchSize) {
    const group = await getNextUnpostedProductGroup();
    if (group.length === 0) break;

    const first = group[0];
    await adapter.sendText(
      `🔔 ${first.sku} — "${first.shot_idea}" (${group.length} shot${group.length === 1 ? "" : "s"} ready for review):`,
    );

    for (const item of group) {
      try {
        const imageUrl = await signedUrlFor(item.s3_key, 3600);
        const ref = await adapter.sendGeneratedShot({
          generationId: item.id,
          sku: item.sku,
          variantIndex: item.variant_index,
          shotIdea: item.shot_idea,
          imageUrl,
          // Shown anyway after a failed retry (see worker.ts) — not hidden,
          // but Ellie gets the heads-up instead of finding out cold.
          qualityNote:
            item.quality_passed === false ? `⚠️ auto-check: ${item.quality_reason}` : undefined,
        });
        await markPosted(item.id, ref);
        posted++;
      } catch (e) {
        // Leave it unposted — it'll be retried on the next tick (still as
        // part of this same product's group, since the group query only
        // ever excludes rows that are actually posted_to_chat_at) rather
        // than silently lost.
        console.error(`[notifier] failed to post generation ${item.id}:`, e);
      }
    }
  }
}

/**
 * setTimeout-chained, not setInterval — see the identical fix and reasoning
 * in worker.ts's startWorkerLoop. Same class of bug, lower-stakes here
 * (notifier ticks are faster), but worth being consistent rather than
 * leaving a second copy of a bug already found and fixed once.
 */
export function startNotifierLoop(adapter: ChatAdapter): void {
  const loop = () => {
    runNotifierTick(adapter)
      .catch((e) => console.error("[notifier] tick error:", e))
      .finally(() => {
        setTimeout(loop, config.notifier.pollIntervalMs);
      });
  };
  setTimeout(loop, config.notifier.pollIntervalMs);
  console.log(
    `[notifier] polling every ${config.notifier.pollIntervalMs}ms, ` +
      `work hours ${config.workHours.startHour}:00-${config.workHours.endHour}:00 ` +
      `${config.teamTimezone}, days [${config.workHours.workDays.join(",")}]`,
  );
}
