import { NextRequest, NextResponse } from "next/server";
import { currentSession, ownerRoute } from "../../../../../lib/authorization";
import { EmailSignInNotConfiguredError } from "../../../../../lib/emailAuth";
import { clientIp } from "../../../../../lib/requestIp";
import { requestStepUp } from "../../../../../lib/stepUp";

// Owner-wide (#221): ask for a step-up code before a sensitive step. The address
// is read from the signed-in owner's auth_users row and any address in the request
// body is ignored.
export const dynamic = "force-dynamic";

const reply = (status: number, body: object) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export const POST = ownerRoute(async (req: NextRequest) => {
  const session = currentSession();
  if (!session) return reply(401, { error: "Sign in to continue" });
  try {
    const result = await requestStepUp(session, clientIp(req));
    if (result === "sign_in_again") return reply(403, { error: "sign_in_again" });
    if (result === "recent_sign_in") return reply(200, { ok: true, method: "recent_sign_in" });
    // Throttled requests get the same answer as sent ones.
    return reply(200, { ok: true, method: "email", message: "If your account has a sign-in address, we’ve sent a code." });
  } catch (error) {
    if (error instanceof EmailSignInNotConfiguredError) return reply(503, { error: "Email codes are not configured" });
    return reply(500, { error: "Could not send a code; retry" });
  }
});
