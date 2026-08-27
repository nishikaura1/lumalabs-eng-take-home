import { config } from "../config.js";
import { getUnpostedGenerations, markPosted } from "../db/index.js";
import { signedUrlFor } from "../storage/s3.js";
import { isWorkHours } from "../util/workhours.js";
import { sendGeneratedShot, sendNotifierHeader } from "./bot.js";

/**
 * This is the work-hours gate: generation (worker.ts) runs continuously,
 * but Ellie is only ever pinged inside config.workHours. Outside that
 * window this is a no-op and ready shots simply queue as status='generated'
 * — nothing is lost, it just waits for the next tick where isWorkHours()
 * is true.
 */
export async function runNotifierTick(): Promise<void> {
  if (!isWorkHours()) return;

  const items = await getUnpostedGenerations(config.notifier.batchSize);
  if (items.length === 0) return;

  await sendNotifierHeader(items.length);

  for (const item of items) {
    try {
      const imageUrl = await signedUrlFor(item.s3_key, 3600);
      const message = await sendGeneratedShot({
        imageUrl,
        sku: item.sku,
        variantIndex: item.variant_index,
        generationId: item.id,
        shotIdea: item.shot_idea,
      });
      await markPosted(item.id, message.message_id);
    } catch (e) {
      // Leave it unposted — it'll be retried on the next tick rather than
      // silently lost.
      console.error(`[notifier] failed to post generation ${item.id}:`, e);
    }
  }
}

export function startNotifierLoop(): void {
  setInterval(() => {
    runNotifierTick().catch((e) => console.error("[notifier] tick error:", e));
  }, config.notifier.pollIntervalMs);
  console.log(
    `[notifier] polling every ${config.notifier.pollIntervalMs}ms, ` +
      `work hours ${config.workHours.startHour}:00-${config.workHours.endHour}:00 ` +
      `${config.teamTimezone}, days [${config.workHours.workDays.join(",")}]`,
  );
}
