import { NextRequest, NextResponse } from "next/server";
import { DEV_OWNER_OPTIONS, DEV_OWNERS, devAuthEnabled, ensureDevOwner, type DevOwnerKey } from "../../../../lib/devAuth";
import { createWebSession, webSessionCookie } from "../../../../lib/webSessions";

// The web counterpart to POST /api/mobile/session/dev: pick a seeded demo owner
// and get the same hashed Postgres session cookie NextAuth uses. Available only
// in a development process with MOBILE_DEV_AUTH=1 (see lib/devAuth.ts);
// otherwise every method answers exactly like an unknown route.
export const dynamic = "force-dynamic";

const reply = (status: number, body: object) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

// A cookie-minting request must come from our own page, so a third-party site
// cannot sign someone into an account it controls.
function sameOrigin(req: NextRequest) {
  if (req.headers.get("sec-fetch-site") === "cross-site") return false;
  const expected = process.env.NEXTAUTH_URL;
  const origin = req.headers.get("origin");
  return !!expected && !!origin && origin === new URL(expected).origin;
}

async function readLimited(req: NextRequest, max: number) {
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { await reader.cancel(); throw new Error("body too large"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// The landing page asks this on mount to decide whether to show the buttons.
// A 404 when the flag is off keeps production pages free of any hint.
export async function GET() {
  if (!devAuthEnabled()) return reply(404, { error: "Not found" });
  return reply(200, { owners: DEV_OWNER_OPTIONS });
}

export async function POST(req: NextRequest) {
  if (!devAuthEnabled()) return reply(404, { error: "Not found" });
  if (!sameOrigin(req)) return reply(403, { error: "Same-origin request required" });

  let body: { owner?: unknown } | null = null;
  try {
    const text = await readLimited(req, 4096);
    body = text.trim() ? JSON.parse(text) ?? null : null;
  } catch { return reply(400, { error: "Unknown demo owner" }); }
  let which: DevOwnerKey = "pro";
  if (body?.owner !== undefined) {
    if (typeof body.owner !== "string" || !Object.prototype.hasOwnProperty.call(DEV_OWNERS, body.owner)) {
      return reply(400, { error: "Unknown demo owner" });
    }
    which = body.owner as DevOwnerKey;
  }

  try {
    const owner = await ensureDevOwner(which);
    const session = await createWebSession(owner, Date.now(), { method: "dev", userAgent: req.headers.get("user-agent") });
    const response = reply(200, { ok: true, owner });
    response.cookies.set(webSessionCookie(session.token, session.expires));
    return response;
  } catch {
    return reply(500, { error: "Sign-in failed; retry" });
  }
}
