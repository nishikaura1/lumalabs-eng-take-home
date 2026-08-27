import { config } from "./config.js";
import {
  attachTelegramMessage,
  claimQueuedProducts,
  createGeneration,
  markProductStatus,
  type Product,
} from "./db/index.js";
import { generateStyledShot } from "./luma/client.js";
import { uploadGeneratedImage } from "./storage/s3.js";
import { sendGeneratedShot } from "./telegram/bot.js";

/** One pass: claim queued products, generate N variants each, post for approval. */
export async function runWorkerTick(): Promise<void> {
  const products = await claimQueuedProducts(config.worker.batchSize);
  if (products.length === 0) return;

  console.log(`[worker] claimed ${products.length} product(s)`);
  await Promise.all(products.map(processProduct));
}

async function processProduct(product: Product): Promise<void> {
  try {
    for (let variant = 1; variant <= config.worker.variantsPerRequest; variant++) {
      const gen = await generateStyledShot({
        photoUrl: product.photo_url,
        prompt: product.shot_idea,
      });

      const imgRes = await fetch(gen.outputUrl);
      const bytes = Buffer.from(await imgRes.arrayBuffer());

      const s3Key = await uploadGeneratedImage({
        sku: product.sku,
        variantIndex: variant,
        bytes,
      });

      const generationId = await createGeneration({
        sku: product.sku,
        variant_index: variant,
        luma_generation_id: gen.id,
        s3_key: s3Key,
        cost_usd: gen.costUsd,
      });

      const message = await sendGeneratedShot({
        bytes,
        sku: product.sku,
        variantIndex: variant,
        generationId,
        shotIdea: product.shot_idea,
      });

      await attachTelegramMessage(generationId, message.message_id);
    }

    await markProductStatus(product.sku, "awaiting_approval");
  } catch (e) {
    console.error(`[worker] ${product.sku} failed:`, e);
    await markProductStatus(
      product.sku,
      "error",
      e instanceof Error ? e.message : String(e),
    );
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
