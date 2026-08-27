import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  telegram: {
    botToken: required("TELEGRAM_BOT_TOKEN"),
    // The single group chat both Ellie and Maya are in. See ASSUMPTIONS.md —
    // membership in this chat *is* the auth boundary for a 6-person team.
    chatId: required("TELEGRAM_CHAT_ID"),
  },
  luma: {
    apiKey: required("LUMA_AGENTS_API_KEY"),
    baseUrl: process.env.LUMA_BASE_URL ?? "https://agents.lumalabs.ai/v1",
    model: process.env.LUMA_MODEL ?? "uni-1",
  },
  db: {
    url: required("DATABASE_URL"),
  },
  s3: {
    bucket: required("S3_BUCKET_NAME"),
    region: process.env.AWS_REGION ?? "us-west-2",
  },
  worker: {
    pollIntervalMs: Number(process.env.WORKER_POLL_INTERVAL_MS ?? 15_000),
    batchSize: Number(process.env.WORKER_BATCH_SIZE ?? 3),
    // Matches APPROVALS_NEEDED (3) so a clean pass can finish a product
    // without a /redo round-trip; still ~$0.13/product on uni-1.
    variantsPerRequest: Number(process.env.VARIANTS_PER_REQUEST ?? 3),
    // Backlog control: stop pulling new work once this many products are
    // sitting awaiting_approval. Protects budget from outrunning Ellie's
    // review pace on a big drop (e.g. the 40-product test) — see
    // claimQueuedProducts in db/index.ts.
    maxPendingReviews: Number(process.env.WORKER_MAX_PENDING_REVIEWS ?? 15),
  },
  port: Number(process.env.PORT ?? 3000),
};
