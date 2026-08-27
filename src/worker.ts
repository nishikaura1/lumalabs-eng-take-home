import { config } from "./config.js";
import {
  claimQueuedProducts,
  createGeneration,
  getRecentRejectReasons,
  markProductStatus,
  type Product,
} from "./db/index.js";
import { generateStyledShot } from "./luma/client.js";
import { uploadGeneratedImage } from "./storage/s3.js";
import { sendCriticalAlert } from "./telegram/bot.js";

// Consecutive fully-failed ticks — distinguishes "one bad product" (normal,
// silent, visible via /status) from "something systemic is broken" (API key,
// Luma/S3 outage), which pages the chat once and stays quiet until it clears.
let consecutiveFailedTicks = 0;
let criticalAlertSent = false;

/**
 * One pass: claim queued products, generate N variants each, store them.
 * Runs continuously regardless of the clock — only *notifying* Ellie of new
 * shots is gated by work hours (see telegram/notifier.ts). This keeps shots
 * ready and waiting the moment she comes online instead of making her wait
 * on generation too.
 */
export async function runWorkerTick(): Promise<void> {
  const products = await claimQueuedProducts(
    config.worker.batchSize,
    config.worker.maxPendingReviews,
  );
  if (products.length === 0) return;

  console.log(`[worker] claimed ${products.length} product(s)`);
  const results = await Promise.all(products.map(processProduct));

  if (results.some(Boolean)) {
    consecutiveFailedTicks = 0;
    criticalAlertSent = false;
  } else {
    consecutiveFailedTicks++;
    if (
      consecutiveFailedTicks >= config.worker.criticalFailureTickThreshold &&
      !criticalAlertSent
    ) {
      criticalAlertSent = true;
      await sendCriticalAlert(
        `Generation has failed for ${consecutiveFailedTicks} batch(es) in a row ` +
          `(every product, not just one) — likely an API key, network, or storage ` +
          `problem rather than a bad Shot Idea. Check the logs.`,
      ).catch((e) => console.error("[worker] failed to send critical alert:", e));
    }
  }
}

/** Returns true on success, false on failure — feeds the critical-alert heuristic above. */
async function processProduct(product: Product): Promise<boolean> {
  try {
    // If this SKU has been through a rejected round before (i.e. this run
    // is via /redo), fold Ellie's reasons in as negative guidance instead
    // of blindly repeating the same shot — this is the feedback loop for
    // unapproved images.
    const priorRejectReasons = await getRecentRejectReasons(product.sku);
    const prompt =
      priorRejectReasons.length > 0
        ? `${product.shot_idea}. Avoid: ${priorRejectReasons.join(", ")}.`
        : product.shot_idea;

    for (let variant = 1; variant <= config.worker.variantsPerRequest; variant++) {
      const gen = await generateStyledShot({
        photoUrl: product.photo_url,
        prompt,
      });

      const imgRes = await fetch(gen.outputUrl);
      const bytes = Buffer.from(await imgRes.arrayBuffer());

      const s3Key = await uploadGeneratedImage({
        sku: product.sku,
        variantIndex: variant,
        bytes,
      });

      await createGeneration({
        sku: product.sku,
        variant_index: variant,
        luma_generation_id: gen.id,
        s3_key: s3Key,
        cost_usd: gen.costUsd,
      });
    }

    // Not 'awaiting_approval' yet — that transition happens in the notifier,
    // once these are actually posted to chat.
    await markProductStatus(product.sku, "generated");
    return true;
  } catch (e) {
    console.error(`[worker] ${product.sku} failed:`, e);
    await markProductStatus(
      product.sku,
      "error",
      e instanceof Error ? e.message : String(e),
    );
    return false;
  }
}

export function startWorkerLoop(): void {
  setInterval(() => {
    runWorkerTick().catch((e) => console.error("[worker] tick error:", e));
  }, config.worker.pollIntervalMs);
  console.log(
    `[worker] polling every ${config.worker.pollIntervalMs}ms, batch size ${config.worker.batchSize}`,
  );
}
