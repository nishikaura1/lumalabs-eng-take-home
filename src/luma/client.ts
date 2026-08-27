import { config } from "../config.js";

// Per docs.agents.lumalabs.ai/guides/pricing — uni-1 image_edit is $0.0434/image
// (uni-1-max is $0.1030). Kept here, not hardcoded at call sites, so the unit
// economics in APPROACH.md stay accurate if the model changes.
export const COST_PER_IMAGE_EDIT_USD: Record<string, number> = {
  "uni-1": 0.0434,
  "uni-1-max": 0.103,
};

interface GenerationResponse {
  id: string;
  state: "queued" | "dreaming" | "completed" | "failed";
  output?: { type: string; url: string }[];
  failure_reason?: string | null;
}

/**
 * 429 retry/backoff is not theoretical — smoke-tested against the real API
 * and hit "Concurrent generation limit reached (10)" live, from smoke-test
 * scripts alone. Our own worker generates variants sequentially per product
 * (see worker.ts), so its own concurrency is bounded by batchSize (3), well
 * under 10 — but the limit is account-wide, so /redo calls, retries, or
 * anything else hitting the same key can still collide with it. Worth
 * treating as an expected transient condition, not an edge case.
 */
async function lumaFetch(
  path: string,
  init?: RequestInit,
  retriesLeft = 5,
): Promise<Response> {
  const res = await fetch(`${config.luma.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.luma.apiKey}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (res.status === 429 && retriesLeft > 0) {
    const retryAfterHeader = res.headers.get("retry-after");
    const waitMs = retryAfterHeader
      ? Number(retryAfterHeader) * 1000
      : Math.min(30_000, 1000 * 2 ** (5 - retriesLeft)) + Math.random() * 500;
    console.warn(
      `[luma] 429 on ${path}, retrying in ${Math.round(waitMs)}ms (${retriesLeft} left)`,
    );
    await new Promise((r) => setTimeout(r, waitMs));
    return lumaFetch(path, init, retriesLeft - 1);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Luma API ${path} -> ${res.status}: ${body}`);
  }
  return res;
}

/**
 * Style a product photo per a text prompt, keeping the product itself
 * recognizable (image_edit, not text-to-image — see ASSUMPTIONS.md).
 */
export async function generateStyledShot(opts: {
  photoUrl: string;
  prompt: string;
  model?: string;
}): Promise<{ id: string; outputUrl: string; costUsd: number }> {
  const model = opts.model ?? config.luma.model;

  const createRes = await lumaFetch("/generations", {
    method: "POST",
    body: JSON.stringify({
      type: "image_edit",
      prompt: opts.prompt,
      source: { url: opts.photoUrl },
      model,
    }),
  });
  const created = (await createRes.json()) as GenerationResponse;

  const final = await pollUntilDone(created.id);
  const outputUrl = final.output?.[0]?.url;
  if (!outputUrl) {
    throw new Error(
      `Luma generation ${created.id} completed with no output url`,
    );
  }

  return {
    id: created.id,
    outputUrl,
    costUsd: COST_PER_IMAGE_EDIT_USD[model] ?? COST_PER_IMAGE_EDIT_USD["uni-1"],
  };
}

async function pollUntilDone(
  id: string,
  { intervalMs = 2000, timeoutMs = 120_000 } = {},
): Promise<GenerationResponse> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await lumaFetch(`/generations/${id}`);
    const body = (await res.json()) as GenerationResponse;
    if (body.state === "completed") return body;
    if (body.state === "failed") {
      throw new Error(
        `Luma generation ${id} failed: ${body.failure_reason ?? "unknown"}`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Luma generation ${id} timed out after ${timeoutMs}ms`);
}
