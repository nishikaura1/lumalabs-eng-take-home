import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

export const pool = new Pool({ connectionString: config.db.url, ssl: config.db.ssl });

export async function migrate(): Promise<void> {
  const schemaPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "schema.sql",
  );
  const sql = readFileSync(schemaPath, "utf-8");
  await pool.query(sql);
}

/**
 * 'generating' only ever means "a live worker process claimed this and is
 * actively working through it right now" — nothing sets it except
 * claimQueuedProducts, and nothing should ever observe it at the moment a
 * fresh process boots. If a row is sitting in 'generating' at startup, the
 * process that claimed it is gone (crashed, redeployed, killed) and the
 * work was lost mid-flight — found live on a real Railway redeploy, where
 * products stuck here just sat frozen forever with no automatic recovery.
 *
 * FOUND VIA CODE REVIEW, FIXED HERE: the original version just requeued the
 * product and claimed "worst case is a redundant Luma call, never data
 * loss" — that was false. processProduct always regenerates starting at
 * variant 1 with no check for generations already inserted before the
 * crash, so a product that got 2 of 3 variants done before dying would
 * come back with 5 generation rows, not 3: real duplicate Luma spend, and
 * a swollen review pool that can push approvedCount past APPROVALS_NEEDED.
 * Since a 'generating' product has never reached 'generated' — nothing
 * has been posted to chat yet (posted_to_chat_at IS NULL for all of its
 * rows) — any generations already inserted for it are safe to delete
 * outright. Their Luma spend stays recorded independently in
 * luma_spend_log regardless, so nothing about the cost story is lost,
 * only the orphaned half-finished candidates are.
 */
export async function reclaimStuckGenerating(): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ sku: string }>(
      `SELECT sku FROM products WHERE status = 'generating'`,
    );
    if (rows.length > 0) {
      const skus = rows.map((r) => r.sku);
      await client.query(
        `DELETE FROM generations WHERE sku = ANY($1) AND posted_to_chat_at IS NULL`,
        [skus],
      );
      await client.query(
        `UPDATE products SET status = 'queued', updated_at = now() WHERE sku = ANY($1)`,
        [skus],
      );
    }
    await client.query("COMMIT");
    return rows.length;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export type ProductStatus =
  | "no_shot_idea"
  | "queued"
  | "generating"
  | "generated" // images made, held for the next work-hours window
  | "awaiting_approval"
  | "approved"
  | "needs_redo"
  | "error";

export interface Product {
  sku: string;
  name: string;
  category: string | null;
  color: string | null;
  material: string | null;
  price: string | null;
  photo_url: string;
  shot_idea: string;
  notes: string | null;
  status: ProductStatus;
  error_message: string | null;
  photo_validated_ok: boolean | null;
}

export interface Generation {
  id: number;
  sku: string;
  variant_index: number;
  luma_generation_id: string | null;
  s3_key: string | null;
  chat_message_ref: string | null;
  posted_to_chat_at: Date | null;
  decision: "pending" | "approved" | "rejected";
  reject_reason: string | null;
  decided_by_user_id: number | null;
  decided_by_username: string | null;
  exported_at: Date | null;
  quality_passed: boolean | null;
  quality_reason: string | null;
  cost_usd: string | null;
  created_at: Date;
}

// README: "Done" = 2-3 approved images. We take the ceiling — cheaper to
// generate one extra variant up front (see config.worker.variantsPerRequest)
// than to round-trip a /redo for the third shot.
export const APPROVALS_NEEDED = 3;

/** Cheap lookup so the importer can decide whether Photo URL re-validation is even needed. */
export async function getExistingProductForImport(
  sku: string,
): Promise<{ photo_url: string; photo_validated_ok: boolean | null } | null> {
  const { rows } = await pool.query<{ photo_url: string; photo_validated_ok: boolean | null }>(
    `SELECT photo_url, photo_validated_ok FROM products WHERE sku = $1`,
    [sku],
  );
  return rows[0] ?? null;
}

/**
 * Upsert a row from a CSV import. `sku` must already be normalized
 * (trim + uppercase) by the caller — that's what makes SKU identity stable
 * across drops even if someone's export varies casing/whitespace.
 *
 * `photoValidatedOk`/`photoInvalidReason`: the caller (ingest/csv.ts) has
 * already resolved the photo verdict — either freshly checked, or reused
 * from photo_validated_ok when the URL hasn't changed since last import
 * (see getExistingProductForImport). A false verdict parks the row in
 * 'error' rather than queued, so we don't spend a Luma call on a link we
 * already know is broken.
 */
export async function upsertProductFromImport(row: {
  sku: string;
  name: string;
  category: string | null;
  color: string | null;
  material: string | null;
  price: string | null;
  photo_url: string;
  shot_idea: string;
  notes: string | null;
  photoValidatedOk: boolean;
  photoInvalidReason?: string;
}): Promise<{ enqueued: boolean }> {
  const existing = await pool.query<Product>(
    `SELECT * FROM products WHERE sku = $1`,
    [row.sku],
  );

  const hasShotIdea = row.shot_idea.trim().length > 0;
  const prev = existing.rows[0];
  const shotIdeaChanged = !prev || prev.shot_idea !== row.shot_idea;
  // photo_url is the actual reference image handed to Luma's image_edit --
  // a corrected/replacement photo is exactly as generation-relevant as a
  // changed Shot Idea, even if the wording is unchanged. Found live: a
  // re-import that only swapped Photo was silently skipped as "up to date"
  // because only shot_idea was ever checked here.
  const photoUrlChanged = !prev || prev.photo_url !== row.photo_url;

  // Don't re-enqueue (and re-spend) on a row we've already processed unless
  // something that actually feeds the generation changed -- the Shot Idea
  // text, the reference photo, or it never had a Shot Idea before. Price,
  // Name, Category, Color, Material, and Notes are saved (see the UPDATE
  // below) but deliberately don't trigger a re-spend on their own: none of
  // them reach the Luma prompt or the reference image (see worker.ts), so
  // re-generating on a price bump would just be wasted spend. The import
  // summary message must stay honest about this split -- see handleCsvUpload.
  const somethingGenerationRelevantChanged = shotIdeaChanged || photoUrlChanged;
  const wouldEnqueue = hasShotIdea && somethingGenerationRelevantChanged;
  const shouldEnqueue = wouldEnqueue && row.photoValidatedOk;
  const status: ProductStatus = !row.photoValidatedOk
    ? "error"
    : shouldEnqueue
      ? "queued"
      : !hasShotIdea
        ? "no_shot_idea"
        : (prev?.status ?? "queued");

  await pool.query(
    `INSERT INTO products (sku, name, category, color, material, price, photo_url, shot_idea, notes, status, error_message, photo_validated_ok, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     ON CONFLICT (sku) DO UPDATE SET
       name = EXCLUDED.name,
       category = EXCLUDED.category,
       color = EXCLUDED.color,
       material = EXCLUDED.material,
       price = EXCLUDED.price,
       photo_url = EXCLUDED.photo_url,
       shot_idea = EXCLUDED.shot_idea,
       notes = EXCLUDED.notes,
       status = EXCLUDED.status,
       error_message = EXCLUDED.error_message,
       photo_validated_ok = EXCLUDED.photo_validated_ok,
       updated_at = now()`,
    [
      row.sku,
      row.name,
      row.category,
      row.color,
      row.material,
      row.price,
      row.photo_url,
      row.shot_idea,
      row.notes,
      status,
      row.photoInvalidReason ?? null,
      row.photoValidatedOk,
    ],
  );

  return { enqueued: shouldEnqueue };
}

/**
 * Atomically claim up to `limit` queued products so two worker ticks never
 * double-process — but throttled by `maxPendingReviews`: if Ellie already has
 * that many awaiting_approval, we stop pulling more work rather than
 * generating (and spending) further ahead of what she can review. This is
 * the actual backlog control — a big CSV drop drains at review pace, not
 * at API throughput, and nothing generates that nobody's looked at yet.
 *
 * "Outstanding" counts both 'generated' (made, waiting for work hours to be
 * posted) and 'awaiting_approval' (already posted, waiting on a decision) —
 * generation keeps running overnight, but it still shouldn't run infinitely
 * far ahead of what Ellie can actually get through once she's online.
 */
export async function claimQueuedProducts(
  limit: number,
  maxPendingReviews: number,
): Promise<Product[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: pendingRows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM products WHERE status IN ('generated', 'awaiting_approval')`,
    );
    const currentlyPending = Number(pendingRows[0].count);
    const room = Math.max(0, maxPendingReviews - currentlyPending);
    const effectiveLimit = Math.min(limit, room);

    if (effectiveLimit === 0) {
      await client.query("COMMIT");
      return [];
    }

    const { rows } = await client.query<Product>(
      `SELECT * FROM products WHERE status = 'queued'
       ORDER BY updated_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [effectiveLimit],
    );
    if (rows.length > 0) {
      await client.query(
        `UPDATE products SET status = 'generating', updated_at = now() WHERE sku = ANY($1)`,
        [rows.map((r) => r.sku)],
      );
    }
    await client.query("COMMIT");
    return rows;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function markProductStatus(
  sku: string,
  status: ProductStatus,
  errorMessage?: string,
): Promise<void> {
  await pool.query(
    `UPDATE products SET status = $2, error_message = $3, updated_at = now() WHERE sku = $1`,
    [sku, status, errorMessage ?? null],
  );
}

export async function createGeneration(g: {
  sku: string;
  variant_index: number;
  luma_generation_id: string;
  s3_key: string;
  cost_usd: number;
  quality_passed: boolean | null;
  quality_reason: string | null;
}): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO generations (sku, variant_index, luma_generation_id, s3_key, cost_usd, quality_passed, quality_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      g.sku,
      g.variant_index,
      g.luma_generation_id,
      g.s3_key,
      g.cost_usd,
      g.quality_passed,
      g.quality_reason,
    ],
  );
  return rows[0].id;
}

/** Logged the instant a Luma call succeeds -- before upload/screening, which can still fail after the money's already spent. */
export async function logLumaSpend(entry: {
  sku: string;
  variantIndex: number;
  lumaGenerationId: string;
  costUsd: number;
}): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO luma_spend_log (sku, variant_index, luma_generation_id, cost_usd)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [entry.sku, entry.variantIndex, entry.lumaGenerationId, entry.costUsd],
  );
  return rows[0].id;
}

export type LumaSpendOutcome = "stored" | "discarded_retry" | "storage_failed";

export async function markLumaSpendOutcome(
  id: number,
  outcome: LumaSpendOutcome,
): Promise<void> {
  await pool.query(`UPDATE luma_spend_log SET outcome = $2 WHERE id = $1`, [id, outcome]);
}

export async function getGeneration(id: number): Promise<Generation | null> {
  const { rows } = await pool.query<Generation>(
    `SELECT * FROM generations WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Record a decision, and roll the parent product to approved once enough
 * variants are in.
 *
 * Idempotency is enforced HERE, atomically, via `WHERE decision = 'pending'`
 * — not just by the caller checking first (bot.ts does that too, as a fast
 * UX path, but a check-then-write in the caller is a race under redelivery).
 * This surfaced as a real gap during the multi-platform ChatAdapter design:
 * Telegram never redelivers a callback, so the caller-side check alone
 * happened to be enough; Slack retries an interaction it didn't get a fast
 * ack for, so two concurrent deliveries of the same tap must not both apply.
 * `applied: false` tells the caller this call was a no-op (already decided
 * by a prior delivery) so it can skip re-announcing the outcome.
 */
export async function decideGeneration(
  id: number,
  decision: "approved" | "rejected",
  decidedBy: { userId: number; username: string },
  rejectReason?: string,
): Promise<{ sku: string; approvedCount: number; applied: boolean }> {
  const { rows } = await pool.query<{ sku: string }>(
    `UPDATE generations
     SET decision = $2, decided_at = now(), reject_reason = $3,
         decided_by_user_id = $4, decided_by_username = $5
     WHERE id = $1 AND decision = 'pending'
     RETURNING sku`,
    [id, decision, rejectReason ?? null, decidedBy.userId, decidedBy.username],
  );

  if (rows.length === 0) {
    const existing = await getGeneration(id);
    if (!existing) throw new Error(`decideGeneration: generation ${id} not found`);
    const { rows: countRows } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM generations WHERE sku = $1 AND decision = 'approved'`,
      [existing.sku],
    );
    return { sku: existing.sku, approvedCount: Number(countRows[0].count), applied: false };
  }

  const sku = rows[0].sku;
  await recomputeProductStatus(sku);

  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT count(*) FROM generations WHERE sku = $1 AND decision = 'approved'`,
    [sku],
  );
  return { sku, approvedCount: Number(countRows[0].count), applied: true };
}

export type UndecideResult =
  | { ok: true; sku: string }
  | { ok: false; reason: "not_found" | "already_exported" };

/**
 * Undo a mis-tap. Resets the generation to pending and re-derives the
 * product's status from scratch — covers both "undo an approve" (may drop
 * the product back out of 'approved') and "undo a reject" (reopens a
 * 'needs_redo' product back to awaiting review) with the same logic.
 *
 * Refused once exported_at is set — see schema.sql. The CSV may already be
 * with the web team; undoing after that point would silently desync it.
 */
export async function undecideGeneration(id: number): Promise<UndecideResult> {
  const gen = await getGeneration(id);
  if (!gen || gen.decision === "pending") return { ok: false, reason: "not_found" };
  if (gen.exported_at) return { ok: false, reason: "already_exported" };

  // Same atomic-guard reasoning as decideGeneration: WHERE decision != 'pending'
  // here, not just the pre-check above, so a duplicate/concurrent Undo tap
  // can't race a second one back to pending after the first already succeeded.
  const { rows } = await pool.query<{ sku: string }>(
    `UPDATE generations
     SET decision = 'pending', decided_at = NULL, reject_reason = NULL,
         decided_by_user_id = NULL, decided_by_username = NULL
     WHERE id = $1 AND decision != 'pending'
     RETURNING sku`,
    [id],
  );
  if (rows.length === 0) return { ok: false, reason: "not_found" };

  const sku = rows[0].sku;
  await recomputeProductStatus(sku);
  return { ok: true, sku };
}

async function recomputeProductStatus(sku: string): Promise<void> {
  const { rows } = await pool.query<{ decision: string; count: string }>(
    `SELECT decision, count(*) FROM generations WHERE sku = $1 GROUP BY decision`,
    [sku],
  );
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.decision] = Number(r.count);
  const approved = counts.approved ?? 0;
  const pending = counts.pending ?? 0;

  if (approved >= APPROVALS_NEEDED) {
    await markProductStatus(sku, "approved");
  } else if (pending > 0) {
    await markProductStatus(sku, "awaiting_approval");
  } else {
    // Everything's decided and we still don't have enough approvals — a
    // human explicitly re-queues via /redo rather than us auto-regenerating.
    await markProductStatus(sku, "needs_redo");
  }
}

/** Distinct reject reasons from this product's last round, for prompt guidance on /redo. */
export async function getRecentRejectReasons(sku: string): Promise<string[]> {
  const { rows } = await pool.query<{ reject_reason: string }>(
    `SELECT DISTINCT reject_reason FROM generations
     WHERE sku = $1 AND decision = 'rejected' AND reject_reason IS NOT NULL
     ORDER BY reject_reason`,
    [sku],
  );
  return rows.map((r) => r.reject_reason);
}

export async function requeueProduct(sku: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE products SET status = 'queued', error_message = NULL, updated_at = now()
     WHERE sku = $1 AND status IN ('needs_redo', 'error')`,
    [sku],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Bulk recovery for a systemic failure that errors out many products at
 * once (found live: a rate-limit issue took out 6 of 16 products in one
 * import) -- redoing each individually doesn't scale to a real 40-product
 * drop. Returns the SKUs actually requeued, for the reply message.
 */
export async function requeueAllFailed(): Promise<string[]> {
  const { rows } = await pool.query<{ sku: string }>(
    `UPDATE products SET status = 'queued', error_message = NULL, updated_at = now()
     WHERE status IN ('needs_redo', 'error')
     RETURNING sku`,
  );
  return rows.map((r) => r.sku).sort();
}

export interface PendingReviewItem {
  id: number;
  sku: string;
  name: string;
  variant_index: number;
  created_at: Date;
  chat_message_ref: string | null;
}

/**
 * Everything actually *posted* and still un-decided — the answer to "what's
 * waiting on me" without scrolling chat history. Oldest first. Deliberately
 * excludes 'generated'-but-unposted items (nothing to scroll up to yet);
 * countQueuedForNextWindow() covers those separately.
 */
export async function getPendingReviewList(): Promise<PendingReviewItem[]> {
  const { rows } = await pool.query<PendingReviewItem>(
    `SELECT g.id, g.sku, p.name, g.variant_index, g.created_at, g.chat_message_ref
     FROM generations g
     JOIN products p ON p.sku = g.sku
     WHERE g.decision = 'pending' AND g.posted_to_chat_at IS NOT NULL
     ORDER BY g.created_at ASC`,
  );
  return rows;
}

/** Products sitting ready, held back until the next work-hours window opens. */
export async function countQueuedForNextWindow(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*) FROM products WHERE status = 'generated'`,
  );
  return Number(rows[0].count);
}

export interface UnpostedGeneration {
  id: number;
  sku: string;
  name: string;
  shot_idea: string;
  variant_index: number;
  s3_key: string;
  quality_passed: boolean | null;
  quality_reason: string | null;
}

/**
 * The next PRODUCT's full set of unposted candidates, oldest product first
 * — never a mix of variants from different products. A flat "oldest N
 * generations" query would interleave candidates from whichever products
 * happened to finish generating around the same time, which reads as a
 * jumble in chat rather than "here's HG-002's shots, then HG-005's." The
 * notifier calls this in a loop, posting one product's group at a time,
 * so the trickle Ellie sees lines up with how she actually reviews: one
 * shot idea at a time.
 *
 * FOUND VIA CODE REVIEW, FIXED HERE: the original version selected on
 * generations state alone (decision/posted_to_chat_at/s3_key), with no
 * check that the PRODUCT had actually finished generating. worker.ts
 * inserts each variant's row the moment that single variant completes,
 * but only flips the product to 'generated' after all of them do — a gap
 * that routinely exceeds one notifier poll interval. A tick landing in
 * that gap would post whatever variants happened to be done so far as
 * "the group," then post the rest under a second header once they
 * finished — the exact fragmentation this function's whole point is to
 * prevent. Requiring products.status = 'generated' means a product is
 * only ever selected once every one of its variants is actually ready.
 */
export async function getNextUnpostedProductGroup(): Promise<UnpostedGeneration[]> {
  const { rows: skuRows } = await pool.query<{ sku: string }>(
    `SELECT g.sku, min(g.created_at) as oldest
     FROM generations g
     JOIN products p ON p.sku = g.sku
     WHERE g.decision = 'pending' AND g.posted_to_chat_at IS NULL AND g.s3_key IS NOT NULL
       AND p.status = 'generated'
     GROUP BY g.sku
     ORDER BY oldest ASC
     LIMIT 1`,
  );
  const sku = skuRows[0]?.sku;
  if (!sku) return [];

  const { rows } = await pool.query<UnpostedGeneration>(
    `SELECT g.id, g.sku, p.name, p.shot_idea, g.variant_index, g.s3_key,
            g.quality_passed, g.quality_reason
     FROM generations g
     JOIN products p ON p.sku = g.sku
     WHERE g.sku = $1 AND g.decision = 'pending' AND g.posted_to_chat_at IS NULL AND g.s3_key IS NOT NULL
       AND p.status = 'generated'
     ORDER BY g.variant_index ASC`,
    [sku],
  );
  return rows;
}

/** Marks a generation as delivered; once every variant for its SKU is posted, the product moves to awaiting_approval. */
export async function markPosted(
  id: number,
  chatMessageRef: string,
): Promise<void> {
  const { rows } = await pool.query<{ sku: string }>(
    `UPDATE generations SET posted_to_chat_at = now(), chat_message_ref = $2
     WHERE id = $1 RETURNING sku`,
    [id, chatMessageRef],
  );
  const sku = rows[0].sku;

  const { rows: remaining } = await pool.query<{ count: string }>(
    `SELECT count(*) FROM generations WHERE sku = $1 AND posted_to_chat_at IS NULL`,
    [sku],
  );
  if (Number(remaining[0].count) === 0) {
    await pool.query(
      `UPDATE products SET status = 'awaiting_approval', updated_at = now()
       WHERE sku = $1 AND status = 'generated'`,
      [sku],
    );
  }
}

export async function statusCounts(): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ status: ProductStatus; count: string }>(
    `SELECT status, count(*) FROM products GROUP BY status`,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = Number(r.count);
  return out;
}

export interface Metrics {
  totalGenerated: number;
  approved: number;
  rejected: number;
  pending: number;
  approvalRate: number | null; // of decided (approved+rejected), not pending
  totalSpendUsd: number;
  /** Spend on generations that never became a deliverable candidate -- a
   *  storage failure, most notably -- a subset of totalSpendUsd, surfaced
   *  separately since it's real money with nothing to show for it. */
  wastedSpendUsd: number;
  costPerApprovedUsd: number | null;
  topRejectReasons: { reason: string; count: number }[];
  qualityFlagged: number;
  // Reject rate among decided items, split by whether the pre-screen
  // flagged them — the read on whether the gate is actually doing anything
  // (flagged items should reject at a noticeably higher rate than clean
  // ones; if not, the pre-screen isn't earning its keep).
  flaggedRejectRate: number | null;
  cleanRejectRate: number | null;
}

/**
 * This is our answer to "how do we test the gate that decides what gets
 * shown" — we don't have a pre-screen model, so the approve/reject stream
 * itself *is* the eval, and this is how we read it: approval rate and $/approved
 * as the headline numbers, reject reasons to see *why* the gate is missing.
 * Surfaced via /status. See APPROACH.md for the pilot-batch process this feeds.
 */
export async function getMetrics(): Promise<Metrics> {
  const { rows } = await pool.query<{ decision: string; count: string }>(
    `SELECT decision, count(*) FROM generations GROUP BY decision`,
  );

  let approved = 0;
  let rejected = 0;
  let pending = 0;
  for (const r of rows) {
    const n = Number(r.count);
    if (r.decision === "approved") approved = n;
    else if (r.decision === "rejected") rejected = n;
    else pending = n;
  }
  const decided = approved + rejected;

  // luma_spend_log, not generations.cost_usd, is the real source of truth
  // for spend -- it's logged the instant a Luma call succeeds, before
  // upload/screening can still fail with the money already spent (see
  // schema.sql comment; found live during storage testing).
  const { rows: spendRows } = await pool.query<{ outcome: string; cost_sum: string | null }>(
    `SELECT outcome, sum(cost_usd) as cost_sum FROM luma_spend_log GROUP BY outcome`,
  );
  let totalSpendUsd = 0;
  let wastedSpendUsd = 0;
  for (const r of spendRows) {
    const sum = Number(r.cost_sum ?? 0);
    totalSpendUsd += sum;
    if (r.outcome === "storage_failed") wastedSpendUsd += sum;
  }

  const { rows: reasonRows } = await pool.query<{
    reject_reason: string;
    count: string;
  }>(
    `SELECT reject_reason, count(*) FROM generations
     WHERE decision = 'rejected' AND reject_reason IS NOT NULL
     GROUP BY reject_reason ORDER BY count(*) DESC LIMIT 5`,
  );

  const { rows: qualityRows } = await pool.query<{
    quality_passed: boolean | null;
    decision: string;
    count: string;
  }>(
    `SELECT quality_passed, decision, count(*) FROM generations
     WHERE decision IN ('approved', 'rejected')
     GROUP BY quality_passed, decision`,
  );
  let flaggedDecided = 0,
    flaggedRejected = 0,
    cleanDecided = 0,
    cleanRejected = 0,
    qualityFlagged = 0;
  for (const r of qualityRows) {
    const n = Number(r.count);
    if (r.quality_passed === false) {
      flaggedDecided += n;
      if (r.decision === "rejected") flaggedRejected += n;
    } else if (r.quality_passed === true) {
      cleanDecided += n;
      if (r.decision === "rejected") cleanRejected += n;
    }
  }
  const { rows: flaggedTotalRows } = await pool.query<{ count: string }>(
    `SELECT count(*) FROM generations WHERE quality_passed = false`,
  );
  qualityFlagged = Number(flaggedTotalRows[0].count);

  return {
    totalGenerated: approved + rejected + pending,
    approved,
    rejected,
    pending,
    approvalRate: decided > 0 ? approved / decided : null,
    totalSpendUsd,
    wastedSpendUsd,
    costPerApprovedUsd: approved > 0 ? totalSpendUsd / approved : null,
    qualityFlagged,
    flaggedRejectRate: flaggedDecided > 0 ? flaggedRejected / flaggedDecided : null,
    cleanRejectRate: cleanDecided > 0 ? cleanRejected / cleanDecided : null,
    topRejectReasons: reasonRows.map((r) => ({
      reason: r.reject_reason,
      count: Number(r.count),
    })),
  };
}

export interface ApprovedGenerationRef {
  id: number;
  s3_key: string;
}

export async function allProductsForExport(): Promise<
  (Product & { approved: ApprovedGenerationRef[] })[]
> {
  const { rows } = await pool.query<Product & { approved: ApprovedGenerationRef[] }>(
    `SELECT p.*, coalesce(
       jsonb_agg(jsonb_build_object('id', g.id, 's3_key', g.s3_key))
         FILTER (WHERE g.decision = 'approved'),
       '[]'
     ) AS approved
     FROM products p
     LEFT JOIN generations g ON g.sku = p.sku
     GROUP BY p.sku
     ORDER BY p.sku`,
  );
  return rows;
}

/** Lock these generations against undo — called once their links go out in a built export. */
export async function markExported(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `UPDATE generations SET exported_at = now() WHERE id = ANY($1) AND exported_at IS NULL`,
    [ids],
  );
}
