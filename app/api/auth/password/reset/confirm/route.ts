import { NextRequest, NextResponse } from "next/server";
import { passwordProblem, passwordRuleMessage, resetPassword } from "../../../../../../lib/passwordAuth";
import { BREACHED_PASSWORD_MESSAGE } from "../../../../../../lib/passwordBreach";
import { readLimitedText, sameOriginRequest } from "../../../../../../lib/requestBody";

// Public by design: consume a reset token and choose a new password (#159). The
// token is single use and expires after 30 minutes. A successful reset deletes
// every web and phone session for the owner, so the browser's cookie is cleared
// here even if this tab was signed in.
export const dynamic = "force-dynamic";

const reply = (status: number, body: object) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: NextRequest) {
  if (!sameOriginRequest(req)) return reply(403, { error: "Same-origin request required" });

  let body: { token?: unknown; password?: unknown };
  try {
    body = JSON.parse(await readLimitedText(req, 8192)) ?? {};
  } catch {
    return reply(400, { error: "That reset link is invalid or has expired." });
  }

  const problem = passwordProblem(body.password);
  if (problem) return reply(400, { error: passwordRuleMessage(problem) });

  const result = await resetPassword(body.token, body.password);
  if (!result.ok) {
    if (result.reason === "invalid_password") return reply(400, { error: passwordRuleMessage(passwordProblem(body.password)) });
    if (result.reason === "breached_password") return reply(400, { error: BREACHED_PASSWORD_MESSAGE });
    return reply(400, { error: "That reset link is invalid or has expired." });
  }

  const response = reply(200, { ok: true });
  // All sessions are gone in the database; clear both cookie spellings so the
  // browser does not keep presenting a dead token.
  for (const name of ["__Secure-next-auth.session-token", "next-auth.session-token"]) {
    response.cookies.set({
      name,
      value: "",
      expires: new Date(0),
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: name.startsWith("__Secure-")
    });
  }
  return response;
}
