/**
 * Standalone Luma image_edit smoke test — deliberately does NOT import
 * src/config.ts (which requires Telegram/DB/S3 vars we may not have
 * provisioned yet). Only needs LUMA_AGENTS_API_KEY, already provided in
 * .env.local. Run with: npm run smoke:luma
 */
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const API_KEY = process.env.LUMA_AGENTS_API_KEY;
if (!API_KEY) {
  throw new Error(
    "Missing LUMA_AGENTS_API_KEY. Copy .env.local's value into .env, or export it directly.",
  );
}
const BASE = "https://agents.lumalabs.ai/v1";
const OUT_DIR = process.env.SMOKE_OUT_DIR ?? "./scripts/smoke-output";

interface GenerationResponse {
  id: string;
  state: "queued" | "dreaming" | "completed" | "failed";
  output?: { type: string; url: string }[];
  failure_reason?: string | null;
}

async function generate(photoUrl: string, prompt: string, model = "uni-1") {
  const createRes = await fetch(`${BASE}/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "image_edit",
      prompt,
      source: { url: photoUrl },
      model,
    }),
  });
  if (!createRes.ok) {
    throw new Error(`create failed: ${createRes.status} ${await createRes.text()}`);
  }
  const created = (await createRes.json()) as GenerationResponse;
  console.log(`  queued: ${created.id}`);

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const pollRes = await fetch(`${BASE}/generations/${created.id}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const body = (await pollRes.json()) as GenerationResponse;
    if (body.state === "completed") {
      const url = body.output?.[0]?.url;
      if (!url) throw new Error("completed with no output url");
      return url;
    }
    if (body.state === "failed") {
      throw new Error(`generation failed: ${body.failure_reason ?? "unknown"}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("timed out waiting for generation");
}

const testCases = [
  {
    sku: "HG-002",
    photo: "https://take-home-service.lumalabs-ext.workers.dev/assets/fde/hg-002.jpg",
    prompt: "morning kitchen counter, steam, warm light",
  },
  {
    sku: "HG-020",
    photo: "https://take-home-service.lumalabs-ext.workers.dev/assets/fde/hg-020.jpg",
    prompt: "baking scene, a little flour mess",
  },
  {
    sku: "HG-025",
    photo: "https://take-home-service.lumalabs-ext.workers.dev/assets/fde/hg-025.jpg",
    prompt: "holiday mantel with evergreen",
  },
  {
    sku: "HG-034",
    photo: "https://take-home-service.lumalabs-ext.workers.dev/assets/fde/hg-034.jpg",
    prompt: "bathroom counter next to a towel",
  },
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const only = process.env.SMOKE_SKU;
  const cases = only ? testCases.filter((tc) => tc.sku === only) : testCases;
  for (const tc of cases) {
    console.log(`\nGenerating ${tc.sku}: "${tc.prompt}"`);
    try {
      const url = await generate(tc.photo, tc.prompt);
      const imgRes = await fetch(url);
      const bytes = Buffer.from(await imgRes.arrayBuffer());
      const outPath = path.join(OUT_DIR, `${tc.sku.toLowerCase()}.jpg`);
      await writeFile(outPath, bytes);
      console.log(`  ✅ saved -> ${outPath}`);
    } catch (e) {
      console.error(`  ❌ ${tc.sku} failed:`, e instanceof Error ? e.message : e);
    }
  }
}

main();
