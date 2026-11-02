import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolvePublicImage } from "../../../../lib/services/bufferPosting";
import { mediaRoot } from "../../../../lib/services/media";

export const dynamic = "force-dynamic";

// PUBLIC by design (#29): Buffer, and Instagram behind it, fetch the image over plain HTTPS
// with no session. The only credential is the 256-bit token in the address. A token works only
// while its post is awaiting submission or publication (and never past its expiry); it is
// revoked afterwards. Draft filenames are never exposed, and every miss is the same 404.
const NOT_FOUND = () => new NextResponse(null, { status: 404, headers: { "cache-control": "no-store" } });

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const token = name.endsWith(".png") ? name.slice(0, -4) : "";
  let file: string | null = null;
  try { file = await resolvePublicImage(token); } catch { return NOT_FOUND(); }
  if (!file) return NOT_FOUND();
  let data: Buffer;
  try { data = await readFile(join(mediaRoot(), file)); } catch { return NOT_FOUND(); }
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "content-type": "image/png",
      "content-length": String(data.length),
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "x-content-type-options": "nosniff"
    }
  });
}
