import { parse } from "csv-parse/sync";
import { upsertProductFromImport } from "../db/index.js";
import { validatePhotoUrl } from "./validate.js";

// Matches data/catalog.csv (and Maya's "same columns, new products, new
// photo URLs" description of future drops).
interface CsvRow {
  SKU: string;
  "Product Name": string;
  Category?: string;
  "Color / Finish"?: string;
  Material?: string;
  Price?: string;
  Photo: string;
  "Shot Idea"?: string;
  Notes?: string;
}

export interface ImportResult {
  totalRows: number;
  newOrChanged: number;
  skipped: number;
  photoInvalid: number;
  duplicateSkus: string[];
  errors: { row: number; sku?: string; message: string }[];
}

/**
 * SKU is the identity key across drops (upsertProductFromImport keys on it),
 * so it has to be stable across exports even if someone's spreadsheet casing
 * or whitespace drifts. Normalizing here — not trusting the source file — is
 * what makes "same SKU" actually mean the same SKU.
 */
function normalizeSku(raw: string): string {
  return raw.trim().toUpperCase();
}

export async function importCatalogCsv(csvText: string): Promise<ImportResult> {
  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as CsvRow[];

  const result: ImportResult = {
    totalRows: records.length,
    newOrChanged: 0,
    skipped: 0,
    photoInvalid: 0,
    duplicateSkus: [],
    errors: [],
  };

  // Detect duplicate SKUs within this one file before touching the DB —
  // last-row-wins on upsert would otherwise silently mask the problem.
  const seenSkus = new Map<string, number>(); // normalized sku -> first row #
  const dupeSkus = new Set<string>();
  records.forEach((row, i) => {
    if (!row.SKU) return;
    const sku = normalizeSku(row.SKU);
    if (seenSkus.has(sku)) dupeSkus.add(sku);
    else seenSkus.set(sku, i + 2);
  });
  result.duplicateSkus = [...dupeSkus];

  for (const [i, row] of records.entries()) {
    try {
      if (!row.SKU || !row.Photo) {
        result.errors.push({
          row: i + 2, // +1 header, +1 for 1-indexing
          sku: row.SKU,
          message: "missing SKU or Photo — row skipped",
        });
        continue;
      }

      const photoCheck = await validatePhotoUrl(row.Photo.trim());
      if (!photoCheck.ok) result.photoInvalid++;

      const { enqueued } = await upsertProductFromImport({
        sku: normalizeSku(row.SKU),
        name: row["Product Name"]?.trim() ?? "",
        category: row.Category?.trim() || null,
        color: row["Color / Finish"]?.trim() || null,
        material: row.Material?.trim() || null,
        price: row.Price?.trim() || null,
        photo_url: row.Photo.trim(),
        shot_idea: row["Shot Idea"]?.trim() ?? "",
        notes: row.Notes?.trim() || null,
        photoInvalidReason: photoCheck.ok ? undefined : photoCheck.reason,
      });
      if (enqueued) result.newOrChanged++;
      else result.skipped++;
    } catch (e) {
      result.errors.push({
        row: i + 2,
        sku: row.SKU,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return result;
}
