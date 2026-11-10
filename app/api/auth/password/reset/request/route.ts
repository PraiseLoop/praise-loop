import { NextRequest, NextResponse } from "next/server";
import { passwordEmailConfigured, requestPasswordReset } from "../../../../../../lib/passwordAuth";
import { readLimitedText, sameOriginRequest } from "../../../../../../lib/requestBody";
import { clientIp } from "../../../../../../lib/requestIp";

// Public by design: ask for a single-use reset link (#159). It answers the same
// way whether or not the address has a password account, so it cannot be used to
// enumerate owners. Throttled requests also answer like a sent one.
export const dynamic = "force-dynamic";

const reply = (status: number, body: object) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

const SENT = "If that address has a password account, we’ve sent a reset link. It expires in 30 minutes.";

export async function POST(req: NextRequest) {
  if (!passwordEmailConfigured()) return reply(503, { error: "Password reset email is not configured" });
  if (!sameOriginRequest(req)) return reply(403, { error: "Same-origin request required" });

  let body: { email?: unknown };
  try {
    body = JSON.parse(await readLimitedText(req, 4096)) ?? {};
  } catch {
    return reply(400, { error: "Enter a valid email address." });
  }
  const result = await requestPasswordReset(body.email, clientIp(req));
  if (result === "invalid_email") return reply(400, { error: "Enter a valid email address." });
  return reply(200, { ok: true, message: SENT });
}
