/**
 * Runs the exact same importCatalogCsv() the chat handler calls, bypassing
 * only the Telegram file-upload UI step (which needs a real human/Ellie —
 * see ASSUMPTIONS.md on the single-writer model). Everything downstream
 * (DB writes, generation, quality screen, notifier) is identical either way.
 */
import { readFileSync } from "node:fs";
import { importCatalogCsv } from "../src/ingest/csv.js";

async function main() {
  const path = process.argv[2] ?? "data/catalog.csv";
  const csvText = readFileSync(path, "utf-8");
  const result = await importCatalogCsv(csvText);
  console.log(JSON.stringify(result, null, 2));
}

main();
