import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

export const pool = new Pool({ connectionString: config.db.url });

export async function migrate(): Promise<void> {
  const schemaPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "schema.sql",
  );
  const sql = readFileSync(schemaPath, "utf-8");
  await pool.query(sql);
}

export type ProductStatus =
  | "no_shot_idea"
  | "queued"
  | "generating"
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
}

export interface Generation {
  id: number;
  sku: string;
  variant_index: number;
  luma_generation_id: string | null;
  s3_key: string | null;
  telegram_message_id: number | null;
  decision: "pending" | "approved" | "rejected";
  cost_usd: string | null;
}

const APPROVALS_NEEDED = 2;

/** Upsert a row from a CSV import. Returns true if this row needs (re)generation. */
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
}): Promise<{ enqueued: boolean }> {
  const existing = await pool.query<Product>(
    `SELECT * FROM products WHERE sku = $1`,
    [row.sku],
  );

  const hasShotIdea = row.shot_idea.trim().length > 0;
  const prev = existing.rows[0];
  const shotIdeaChanged = !prev || prev.shot_idea !== row.shot_idea;

  // Don't re-enqueue (and re-spend) on a row we've already processed unless
  // the Shot Idea text itself changed, or it never had one before.
  const shouldEnqueue = hasShotIdea && shotIdeaChanged;
  const status: ProductStatus = shouldEnqueue
    ? "queued"
    : !hasShotIdea
      ? "no_shot_idea"
      : (prev?.status ?? "queued");

  await pool.query(
    `INSERT INTO products (sku, name, category, color, material, price, photo_url, shot_idea, notes, status, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
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
    ],
  );

  return { enqueued: shouldEnqueue };
}

/** Atomically claim up to `limit` queued products so two worker ticks never double-process. */
export async function claimQueuedProducts(limit: number): Promise<Product[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<Product>(
      `SELECT * FROM products WHERE status = 'queued'
       ORDER BY updated_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit],
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

/**
 * Created before the Telegram send, since the message's callback_data needs
 * this row's id. attachTelegramMessage fills in the message id right after.
 */
export async function createGeneration(g: {
  sku: string;
  variant_index: number;
  luma_generation_id: string;
  s3_key: string;
  cost_usd: number;
}): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO generations (sku, variant_index, luma_generation_id, s3_key, cost_usd)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [g.sku, g.variant_index, g.luma_generation_id, g.s3_key, g.cost_usd],
  );
  return rows[0].id;
}

export async function attachTelegramMessage(
  id: number,
  telegramMessageId: number,
): Promise<void> {
  await pool.query(`UPDATE generations SET telegram_message_id = $2 WHERE id = $1`, [
    id,
    telegramMessageId,
  ]);
}

export async function getGeneration(id: number): Promise<Generation | null> {
  const { rows } = await pool.query<Generation>(
    `SELECT * FROM generations WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Record a decision, and roll the parent product to approved once enough variants are in. */
export async function decideGeneration(
  id: number,
  decision: "approved" | "rejected",
): Promise<{ sku: string; approvedCount: number }> {
  const { rows } = await pool.query<{ sku: string }>(
    `UPDATE generations SET decision = $2, decided_at = now() WHERE id = $1 RETURNING sku`,
    [id, decision],
  );
  const sku = rows[0].sku;

  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT count(*) FROM generations WHERE sku = $1 AND decision = 'approved'`,
    [sku],
  );
  const approvedCount = Number(countRows[0].count);

  if (approvedCount >= APPROVALS_NEEDED) {
    await markProductStatus(sku, "approved");
  } else if (decision === "rejected") {
    // Leave as awaiting_approval if other variants are still pending; a human
    // explicitly re-queues via /redo rather than us auto-regenerating.
    const { rows: pendingRows } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM generations WHERE sku = $1 AND decision = 'pending'`,
      [sku],
    );
    if (Number(pendingRows[0].count) === 0) {
      await markProductStatus(sku, "needs_redo");
    }
  }

  return { sku, approvedCount };
}

export async function requeueProduct(sku: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE products SET status = 'queued', error_message = NULL, updated_at = now()
     WHERE sku = $1 AND status IN ('needs_redo', 'error')`,
    [sku],
  );
  return (rowCount ?? 0) > 0;
}

export async function statusCounts(): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ status: ProductStatus; count: string }>(
    `SELECT status, count(*) FROM products GROUP BY status`,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = Number(r.count);
  return out;
}

export async function allProductsForExport(): Promise<
  (Product & { approved_urls: string[] })[]
> {
  const { rows } = await pool.query<Product & { approved_urls: string[] }>(
    `SELECT p.*, coalesce(
       array_agg(g.s3_key) FILTER (WHERE g.decision = 'approved'), '{}'
     ) AS approved_urls
     FROM products p
     LEFT JOIN generations g ON g.sku = p.sku
     GROUP BY p.sku
     ORDER BY p.sku`,
  );
  return rows;
}
