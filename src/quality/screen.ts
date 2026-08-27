import { config } from "../config.js";

export interface QualityVerdict {
  passed: boolean;
  reason: string;
}

/**
 * Pre-screen a generated shot before Ellie ever sees it: does it still show
 * the same product (shape/color/material), and is it technically clean
 * (not blank, corrupted, or heavily artifacted)? A single cheap vision call
 * — fractions of a cent against the $0.043 generation it's screening — cuts
 * what actually reaches her, which is the point per direction (time, not
 * budget, is the metric this build optimizes for).
 *
 * Fails open: no ANTHROPIC_API_KEY configured -> treated as passed, not
 * blocked. This is an added quality layer, not a dependency the core loop
 * should break on.
 */
export async function screenImage(opts: {
  referencePhotoUrl: string;
  generatedImageUrl: string;
}): Promise<QualityVerdict> {
  if (!config.quality.anthropicApiKey) {
    return { passed: true, reason: "screening disabled (no ANTHROPIC_API_KEY)" };
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": config.quality.anthropicApiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.quality.model,
        max_tokens: 200,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Reference product photo (white background):" },
              { type: "image", source: { type: "url", url: opts.referencePhotoUrl } },
              { type: "text", text: "Generated styled shot:" },
              { type: "image", source: { type: "url", url: opts.generatedImageUrl } },
              {
                type: "text",
                text:
                  "Compare them. Is the SAME product (same shape, color, material) " +
                  "clearly present in the second image, just in a styled scene? Is the " +
                  "second image technically clean (not blank, corrupted, distorted, or " +
                  "heavily artifacted)? Reply with ONLY this JSON, no other text: " +
                  '{"productPresent": boolean, "technicallyClean": boolean, "reason": "one short sentence"}',
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Anthropic API ${res.status}: ${body}`);
    }

    const data = (await res.json()) as {
      content: { type: string; text?: string }[];
    };
    const text = data.content.find((c) => c.type === "text")?.text ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`no JSON in response: ${text}`);

    const parsed = JSON.parse(match[0]) as {
      productPresent: boolean;
      technicallyClean: boolean;
      reason: string;
    };

    return {
      passed: parsed.productPresent && parsed.technicallyClean,
      reason: parsed.reason,
    };
  } catch (e) {
    // Screening infra hiccup shouldn't block the pipeline either — fail
    // open, but say why in case the reason ends up visible later.
    const message = e instanceof Error ? e.message : String(e);
    console.error("[quality] screen failed, passing through:", message);
    return { passed: true, reason: `screening error, passed through: ${message}` };
  }
}
