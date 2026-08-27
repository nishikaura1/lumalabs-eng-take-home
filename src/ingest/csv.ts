import { parse } from "csv-parse/sync";
import { upsertProductFromImport } from "../db/index.js";

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
  errors: { row: number; sku?: string; message: string }[];
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
    errors: [],
  };

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
      const { enqueued } = await upsertProductFromImport({
        sku: row.SKU.trim(),
        name: row["Product Name"]?.trim() ?? "",
        category: row.Category?.trim() || null,
        color: row["Color / Finish"]?.trim() || null,
        material: row.Material?.trim() || null,
        price: row.Price?.trim() || null,
        photo_url: row.Photo.trim(),
        shot_idea: row["Shot Idea"]?.trim() ?? "",
        notes: row.Notes?.trim() || null,
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
