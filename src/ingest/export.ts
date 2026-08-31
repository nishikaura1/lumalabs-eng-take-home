import { stringify } from "csv-stringify/sync";
import { allProductsForExport, markExported } from "../db/index.js";
import { signedUrlFor } from "../storage/s3.js";

/**
 * Regenerate the catalog export with status + approved image links added.
 * Per README: "an updated export at the end is fine, and nobody is asking
 * for live sheet sync" — this is that updated export, on demand.
 *
 * Side effect: every approved generation included here gets exported_at
 * stamped, which locks it against /undo (see undecideGeneration) — once a
 * link has gone out in an export, we treat it as potentially in the web
 * team's hands and stop allowing it to silently change underneath them.
 */
export async function buildExportCsv(): Promise<string> {
  const products = await allProductsForExport();
  const exportedIds: number[] = [];

  const rows = await Promise.all(
    products.map(async (p) => {
      const urls = await Promise.all(
        p.approved.map(async (g) => {
          exportedIds.push(g.id);
          return signedUrlFor(g.s3_key, 7 * 24 * 3600);
        }),
      );
      return {
        SKU: p.sku,
        "Product Name": p.name,
        Category: p.category ?? "",
        "Color / Finish": p.color ?? "",
        Material: p.material ?? "",
        Price: p.price ?? "",
        Photo: p.photo_url,
        "Shot Idea": p.shot_idea,
        Notes: p.notes ?? "",
        Status: p.status,
        "Error Detail": p.error_message ?? "",
        "Approved Image URLs": urls.join(" ; "),
      };
    }),
  );

  await markExported(exportedIds);

  return stringify(rows, { header: true });
}
