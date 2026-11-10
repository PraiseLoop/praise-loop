import { NextRequest, NextResponse } from "next/server";
import { emailSignInConfigured } from "../../../../../lib/emailAuth";
import { recordFailure, tooManyFailures } from "../../../../../lib/mobileSignIn";
import { passwordProblem, passwordRuleMessage, signUpWithPassword } from "../../../../../lib/passwordAuth";
import { BREACHED_PASSWORD_MESSAGE } from "../../../../../lib/passwordBreach";
import { readLimitedText, sameOriginRequest } from "../../../../../lib/requestBody";
import { clientIp } from "../../../../../lib/requestIp";
import { INVITE_ONLY_MESSAGE } from "../../../../../lib/signupMessages";
import { createWebSession, webSessionCookie } from "../../../../../lib/webSessions";

// Public by design: the web half of password sign-up (#159). The caller has
// already requested a code with /api/auth/email/request; this route consumes it,
// creates or finds the owner through the shared #156 linking policy and #195
// invite gate, and only then writes the credential. Nothing is stored before the
// mailbox is proved.
export const dynamic = "force-dynamic";

const reply = (status: number, body: object) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: NextRequest) {
  if (!emailSignInConfigured()) return reply(503, { error: "Email sign-in is not configured" });
  if (!sameOriginRequest(req)) return reply(403, { error: "Same-origin request required" });
  const client = clientIp(req);
  if (tooManyFailures(client)) return reply(429, { error: "Too many attempts; try again later" });

  let body: { email?: unknown; code?: unknown; password?: unknown };
  try {
    body = JSON.parse(await readLimitedText(req, 8192)) ?? {};
  } catch {
    return reply(400, { error: "That code is invalid or has expired" });
  }

  const problem = passwordProblem(body.password);
  if (problem) return reply(400, { error: passwordRuleMessage(problem) });

  const result = await signUpWithPassword(body.email, body.code, body.password);
  if (!result.ok) {
    if (result.reason === "invite_only") return reply(403, { error: "invite_only", message: INVITE_ONLY_MESSAGE });
    if (result.reason === "invalid_password") return reply(400, { error: passwordRuleMessage(passwordProblem(body.password)) });
    if (result.reason === "breached_password") return reply(400, { error: BREACHED_PASSWORD_MESSAGE });
    if (result.reason === "password_exists" || result.reason === "email_taken") {
      // Only a caller who already proved this mailbox reaches this branch.
      return reply(409, { error: "A password is already set for that address. Sign in or reset it." });
    }
    recordFailure(client);
    return reply(400, { error: "That code is invalid or has expired" });
  }

  const session = await createWebSession(result.ownerId, Date.now(), { method: "password", userAgent: req.headers.get("user-agent") });
  const response = reply(200, { ok: true });
  response.cookies.set(webSessionCookie(session.token, session.expires));
  return response;
}
