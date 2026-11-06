import { NextRequest, NextResponse } from "next/server";
import { emailSignInConfigured, verifyEmailCode } from "../../../../../lib/emailAuth";
import { recordFailure, tooManyFailures } from "../../../../../lib/mobileSignIn";
import { createMobileSession } from "../../../../../lib/mobileSessions";
import { clientIp } from "../../../../../lib/requestIp";
import { INVITE_ONLY_MESSAGE } from "../../../../../lib/signupMessages";

// Public by design: the phone half of email sign-in. Returns a bearer session for
// the owner a verified address belongs to; no Google account is involved.
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

// 401 is deliberately not used for a wrong code: the app treats 401 as "the
// session ended" and would clear a token over a simple typing mistake.
export async function POST(req: NextRequest) {
  if (!emailSignInConfigured()) return reply(503, { error: "Email sign-in is not configured" });
  const client = clientIp(req);
  if (tooManyFailures(client)) return reply(429, { error: "Too many attempts; try again later" });

  let body: { email?: unknown; code?: unknown };
  try { body = JSON.parse(await readLimited(req, 4096)) ?? {}; } catch { return reply(400, { error: "That code is invalid or has expired" }); }
  const result = await verifyEmailCode(String(body.email ?? "").trim().toLowerCase(), String(body.code ?? "").trim());
  if (!result.ok) {
    if (result.reason === "invite_only") return reply(403, { error: "invite_only", message: INVITE_ONLY_MESSAGE });
    recordFailure(client);
    return reply(400, { error: "That code is invalid or has expired" });
  }
  const session = await createMobileSession(result.ownerId);
  return reply(200, { token: session.token, expires: session.expires });
}
