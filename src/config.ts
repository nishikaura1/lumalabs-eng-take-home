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
    // Ellie is the only writer: approve/reject/undo/redo and CSV import all
    // require this user id. Everyone else in the chat is read-only
    // (/status, /review, /export). Matches the brief verbatim — "her pick
    // is the decision; there is no other approval step" — extended to the
    // rest of the write surface for one consistent, simple rule.
    ellieUserId: Number(required("TELEGRAM_ELLIE_USER_ID")),
  },
  luma: {
    apiKey: required("LUMA_AGENTS_API_KEY"),
    baseUrl: process.env.LUMA_BASE_URL ?? "https://agents.lumalabs.ai/v1",
    model: process.env.LUMA_MODEL ?? "uni-1",
  },
  db: {
    url: required("DATABASE_URL"),
    // Most hosted Postgres (Railway, Neon, Render) requires SSL with a
    // self-signed/intermediate cert that Node's default TLS validation
    // rejects — a common first-deploy failure. Off by default for local/
    // plain Postgres; set DATABASE_SSL=require once pointed at a real host.
    ssl:
      process.env.DATABASE_SSL === "require" ? { rejectUnauthorized: false } : undefined,
  },
  s3: {
    bucket: required("S3_BUCKET_NAME"),
    region: process.env.AWS_REGION ?? "us-west-2",
    // Unset in production (real AWS S3). Set to an S3-compatible endpoint
    // (e.g. http://localhost:9000) for local dev against MinIO -- forcePathStyle
    // is required by MinIO/most S3-compatible services (virtual-hosted-style
    // buckets need real DNS, which a local endpoint doesn't have).
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: process.env.S3_ENDPOINT !== undefined,
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
    // Consecutive fully-failed ticks before we treat it as systemic (bad
    // API key, Luma/S3 outage) rather than one bad product, and push a
    // critical alert. See worker.ts.
    criticalFailureTickThreshold: Number(
      process.env.CRITICAL_FAILURE_TICK_THRESHOLD ?? 2,
    ),
  },
  port: Number(process.env.PORT ?? 3000),
  // Unverified assumption (brief never states their timezone/hours) — see
  // ASSUMPTIONS.md. Drives both display (util/time.ts) and the notifier gate
  // (util/workhours.ts): generation queues 24/7, but Ellie is only pinged
  // inside this window; the rest sits ready as a queue until it opens.
  teamTimezone: process.env.TEAM_TIMEZONE ?? "America/Los_Angeles",
  workHours: {
    startHour: Number(process.env.WORK_HOURS_START ?? 9), // 24h, local to teamTimezone
    endHour: Number(process.env.WORK_HOURS_END ?? 18),
    workDays: (process.env.WORK_DAYS ?? "1,2,3,4,5")
      .split(",")
      .map(Number), // 0=Sun..6=Sat
  },
  quality: {
    // Optional on purpose: if unset, screenImage() no-ops as a pass rather
    // than blocking the pipeline. Key is already provisioned per
    // .env.example ("we have accounts... will supply real keys").
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.QUALITY_SCREEN_MODEL ?? "claude-haiku-4-5-20251001",
  },
  notifier: {
    pollIntervalMs: Number(process.env.NOTIFIER_POLL_INTERVAL_MS ?? 20_000),
    // Trickle, don't dump — Telegram soft-limits ~20 msgs/min to one group,
    // and a wall of 45 photos the second work hours open is a worse
    // experience than a steady stream. See notifier.ts.
    batchSize: Number(process.env.NOTIFIER_BATCH_SIZE ?? 5),
  },
};
