import { config } from "./config.js";
import {
  claimQueuedProducts,
  createGeneration,
  getRecentRejectReasons,
  logLumaSpend,
  markLumaSpendOutcome,
  markProductStatus,
  type Product,
} from "./db/index.js";
import type { ChatAdapter } from "./chat/types.js";
import { generateStyledShot } from "./luma/client.js";
import { screenImage } from "./quality/screen.js";
import { signedUrlFor, uploadGeneratedImage } from "./storage/s3.js";

// Consecutive fully-failed ticks — distinguishes "one bad product" (normal,
// silent, visible via /status) from "something systemic is broken" (API key,
// Luma/S3 outage), which pages the chat once and stays quiet until it clears.
let consecutiveFailedTicks = 0;
let criticalAlertSent = false;

/**
 * One pass: claim queued products, generate N variants each, store them.
 * Runs continuously regardless of the clock — only *notifying* Ellie of new
 * shots is gated by work hours (see chat/notifier.ts). This keeps shots
 * ready and waiting the moment she comes online instead of making her wait
 * on generation too.
 */
export async function runWorkerTick(adapter: ChatAdapter): Promise<void> {
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
      await adapter
        .sendCriticalAlert(
          `Generation has failed for ${consecutiveFailedTicks} batch(es) in a row ` +
            `(every product, not just one) — likely an API key, network, or storage ` +
            `problem rather than a bad Shot Idea. Check the logs.`,
        )
        .catch((e) => console.error("[worker] failed to send critical alert:", e));
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
      await generateAndScreenVariant(product, variant, prompt);
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

/**
 * Generate one variant, run it past the quality pre-screen, and — on a
 * fail — retry exactly once with a nudged prompt before giving up. Never
 * more than one retry: this stays inside the same cost-discipline pattern
 * as everything else (a human decides further spend, not a loop). If the
 * retry still fails, the variant is still stored and shown, just flagged,
 * so a paid-for attempt is never silently thrown away.
 */
async function generateAndScreenVariant(
  product: Product,
  variant: number,
  basePrompt: string,
): Promise<void> {
  let prompt = basePrompt;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const gen = await generateStyledShot({ photoUrl: product.photo_url, prompt });

    // Logged the instant the Luma call succeeds — money is spent at this
    // point regardless of what happens next. Found live: a storage failure
    // used to throw before any record of the spend existed anywhere.
    const spendLogId = await logLumaSpend({
      sku: product.sku,
      variantIndex: variant,
      lumaGenerationId: gen.id,
      costUsd: gen.costUsd,
    });

    try {
      const imgRes = await fetch(gen.outputUrl);
      const bytes = Buffer.from(await imgRes.arrayBuffer());

      const s3Key = await uploadGeneratedImage({
        sku: product.sku,
        variantIndex: variant,
        bytes,
      });

      const screenUrl = await signedUrlFor(s3Key, 300); // just long enough for the screening call to fetch it
      const verdict = await screenImage({
        referencePhotoUrl: product.photo_url,
        generatedImageUrl: screenUrl,
      });

      const isFinalAttempt = attempt === 2 || verdict.passed;
      if (isFinalAttempt) {
        await createGeneration({
          sku: product.sku,
          variant_index: variant,
          luma_generation_id: gen.id,
          s3_key: s3Key,
          cost_usd: gen.costUsd,
          quality_passed: verdict.passed,
          quality_reason: verdict.reason,
        });
        await markLumaSpendOutcome(spendLogId, "stored");
        return;
      }

      await markLumaSpendOutcome(spendLogId, "discarded_retry");
      console.log(`[worker] ${product.sku} v${variant} flagged (${verdict.reason}), retrying once`);
      prompt = `${basePrompt}. Make sure the product itself keeps the same shape, color, and material as the reference photo, and the image is clean and in focus.`;
    } catch (e) {
      // Money already spent (see logLumaSpend above); the image itself is
      // lost. Record that honestly rather than letting it vanish, then
      // propagate — processProduct's catch still marks the product 'error'.
      await markLumaSpendOutcome(spendLogId, "storage_failed").catch((logErr) =>
        console.error(`[worker] failed to mark spend outcome for ${spendLogId}:`, logErr),
      );
      throw e;
    }
  }
}

/**
 * Deliberately setTimeout-chained, not setInterval — a tick only gets
 * scheduled `pollIntervalMs` after the PREVIOUS one fully finishes.
 *
 * Found live: with setInterval, a tick fires every pollIntervalMs
 * regardless of whether the last one finished, and product generation
 * (three sequential Luma calls, ~10-30s each) routinely takes longer than
 * that. Overlapping ticks each claim up to batchSize more products on top
 * of whatever's still in flight from prior ticks, so true concurrent Luma
 * load grew well past the intended batchSize=3 ceiling — straight into
 * Luma's account-wide 10-concurrent-generation limit, which is what
 * actually produced the 429s a 16-product import hit in practice. This
 * chain guarantees at most one tick (and so at most `batchSize` concurrent
 * Luma calls from this process) in flight at any time.
 */
export function startWorkerLoop(adapter: ChatAdapter): void {
  const loop = () => {
    runWorkerTick(adapter)
      .catch((e) => console.error("[worker] tick error:", e))
      .finally(() => {
        setTimeout(loop, config.worker.pollIntervalMs);
      });
  };
  setTimeout(loop, config.worker.pollIntervalMs);
  console.log(
    `[worker] polling every ${config.worker.pollIntervalMs}ms, batch size ${config.worker.batchSize}`,
  );
}
