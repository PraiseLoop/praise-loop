import { NextRequest, NextResponse } from "next/server";
import { verifyMicrosoftIdToken } from "../../../../../lib/microsoftIdToken";
import { findOrCreateMicrosoftOwner, recordFailure, tooManyFailures } from "../../../../../lib/mobileSignIn";
import { createMobileSession } from "../../../../../lib/mobileSessions";
import { clientIp } from "../../../../../lib/requestIp";

// Reads at most `max` bytes of the stream, so a missing or false Content-Length cannot make us buffer more.
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

// Public by design: this is where a bearer session is born. Exchanges a Microsoft
// Entra ID token from the native sign-in for a mobile session. The token is never logged.
export async function POST(req: NextRequest) {
  const reply = (status: number, body: object) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  try {
    // Client-supplied IP headers are only trustworthy behind a proxy that overwrites them.
    const client = clientIp(req);
    if (tooManyFailures(client)) return reply(429, { error: "Too many failed sign-in attempts; try again later" });
    let body: { idToken?: unknown } | null = null;
    try { body = JSON.parse(await readLimited(req, 8192)); } catch { /* handled below */ }
    const identity = typeof body?.idToken === "string" ? await verifyMicrosoftIdToken(body.idToken) : null;
    if (!identity) { recordFailure(client); return reply(401, { error: "Invalid Microsoft sign-in" }); }
    const owner = await findOrCreateMicrosoftOwner(identity);
    if (!owner) { recordFailure(client); return reply(401, { error: "Invalid Microsoft sign-in" }); }
    const session = await createMobileSession(owner);
    return reply(200, { token: session.token, expires: session.expires });
  } catch { return reply(500, { error: "Sign-in failed; retry" }); }
}
