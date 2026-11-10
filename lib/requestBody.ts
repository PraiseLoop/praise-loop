import type { NextRequest } from "next/server";

/** Read a request body without letting a caller send an unbounded payload. */
export async function readLimitedText(req: NextRequest, max: number): Promise<string> {
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new Error("body too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * A cookie-minting or cross-origin-sensitive request must come from our own
 * page. Bearer routes do not use this: a browser never attaches the token.
 */
export function sameOriginRequest(req: NextRequest, env: NodeJS.ProcessEnv = process.env): boolean {
  if (req.headers.get("sec-fetch-site") === "cross-site") return false;
  const expected = env.NEXTAUTH_URL;
  const origin = req.headers.get("origin");
  if (!expected || !origin) return false;
  try {
    return origin === new URL(expected).origin;
  } catch {
    return false;
  }
}
