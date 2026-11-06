import { NextRequest, NextResponse } from "next/server";
import { emailSignInConfigured, verifyEmailCode } from "../../../../../lib/emailAuth";
import { recordFailure, tooManyFailures } from "../../../../../lib/mobileSignIn";
import { clientIp } from "../../../../../lib/requestIp";
import { INVITE_ONLY_MESSAGE } from "../../../../../lib/signupMessages";
import { createWebSession, webSessionCookie } from "../../../../../lib/webSessions";

// Public by design: the web half of email sign-in. On success it sets the same
// hashed Postgres session cookie the Google flow uses.
export const dynamic = "force-dynamic";

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

const reply = (status: number, body: object) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

// A cookie-minting request must come from our own page, so a third-party site
// cannot sign someone into an account it controls.
function sameOrigin(req: NextRequest) {
  if (req.headers.get("sec-fetch-site") === "cross-site") return false;
  const expected = process.env.NEXTAUTH_URL;
  const origin = req.headers.get("origin");
  return !!expected && !!origin && origin === new URL(expected).origin;
}

export async function POST(req: NextRequest) {
  if (!emailSignInConfigured()) return reply(503, { error: "Email sign-in is not configured" });
  if (!sameOrigin(req)) return reply(403, { error: "Same-origin request required" });
  const client = clientIp(req);
  if (tooManyFailures(client)) return reply(429, { error: "Too many attempts; try again later" });

  let body: { email?: unknown; code?: unknown };
  try { body = JSON.parse(await readLimited(req, 4096)) ?? {}; } catch { return reply(400, { error: "That code is invalid or has expired" }); }
  const result = await verifyEmailCode(String(body.email ?? "").trim().toLowerCase(), String(body.code ?? "").trim());
  if (!result.ok) {
    // A valid code for a brand-new uninvited address is the only place the gate
    // surfaces; it says so plainly and counts nothing as a failed guess (#195).
    if (result.reason === "invite_only") return reply(403, { error: "invite_only", message: INVITE_ONLY_MESSAGE });
    recordFailure(client);
    return reply(400, { error: "That code is invalid or has expired" });
  }
  const session = await createWebSession(result.ownerId);
  const response = reply(200, { ok: true });
  response.cookies.set(webSessionCookie(session.token, session.expires));
  return response;
}
