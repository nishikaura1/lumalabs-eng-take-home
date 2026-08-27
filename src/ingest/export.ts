import { stringify } from "csv-stringify/sync";
import { allProductsForExport } from "../db/index.js";
import { signedUrlFor } from "../storage/s3.js";

/**
 * Regenerate the catalog export with status + approved image links added.
 * Per README: "an updated export at the end is fine, and nobody is asking
 * for live sheet sync" — this is that updated export, on demand.
 */
export async function buildExportCsv(): Promise<string> {
  const products = await allProductsForExport();

  const rows = await Promise.all(
    products.map(async (p) => {
      const urls = await Promise.all(
        p.approved_urls.filter(Boolean).map((key) => signedUrlFor(key, 7 * 24 * 3600)),
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
        "Approved Image URLs": urls.join(" ; "),
      };
    }),
  );

  return stringify(rows, { header: true });
}
