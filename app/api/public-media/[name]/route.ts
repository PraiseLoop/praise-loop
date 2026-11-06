import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../../../../lib/log";
import { resolvePublicImage } from "../../../../lib/services/bufferPosting";
import { mediaRoot } from "../../../../lib/services/media";

export const dynamic = "force-dynamic";

// PUBLIC by design (#29, #234): Buffer, Instagram and Facebook fetch the image over plain HTTPS
// with no session. The only credential is the 256-bit token in the address. A token works only
// while its post is awaiting submission or publication (and never past its expiry); it is
// revoked afterwards. Draft filenames are never exposed, and every miss is the same 404.
// `.png` is the stored original; `.jpg` is the deterministic JPEG variant Instagram requires.
const NOT_FOUND = () => new NextResponse(null, { status: 404, headers: { "cache-control": "no-store" } });

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const format = name.endsWith(".jpg") ? "jpg" : name.endsWith(".png") ? "png" : null;
  const token = format ? name.slice(0, -4) : "";
  let file: string | null = null;
  try { file = format ? await resolvePublicImage(token, format) : null; } catch { return NOT_FOUND(); }
  // Served or not, never which token or why: a miss must look the same to the caller and in the log.
  log.debug("public_media_request", { served: !!file, format });
  if (!file) return NOT_FOUND();
  let data: Buffer;
  try { data = await readFile(join(mediaRoot(), file)); } catch { return NOT_FOUND(); }
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "content-type": format === "jpg" ? "image/jpeg" : "image/png",
      "content-length": String(data.length),
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "x-content-type-options": "nosniff"
    }
  });
}
