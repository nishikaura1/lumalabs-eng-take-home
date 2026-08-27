/**
 * Catch a broken/non-image Photo link at import time instead of finding out
 * after paying for a failed Luma call. HEAD first (cheap); some hosts don't
 * support HEAD, so fall back to a ranged GET rather than a full download.
 */
export async function validatePhotoUrl(
  url: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { ok: false, reason: `unsupported protocol ${parsed.protocol}` };
  }

  const check = async (method: "HEAD" | "GET") =>
    fetch(url, {
      method,
      headers: method === "GET" ? { Range: "bytes=0-0" } : undefined,
      signal: AbortSignal.timeout(8000),
    });

  try {
    let res = await check("HEAD");
    if (res.status === 405 || res.status === 501) {
      res = await check("GET");
    }
    if (!res.ok && res.status !== 206) {
      return { ok: false, reason: `photo URL returned HTTP ${res.status}` };
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType && !contentType.startsWith("image/")) {
      return {
        ok: false,
        reason: `photo URL content-type is "${contentType}", not an image`,
      };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      reason: `photo URL unreachable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
