import { NextRequest, NextResponse } from "next/server";
import { currentOwner, currentSession, ownerRoute } from "../../../../../lib/authorization";
import { passwordProblem, passwordRuleMessage, setPasswordForOwner } from "../../../../../lib/passwordAuth";
import { BREACHED_PASSWORD_MESSAGE } from "../../../../../lib/passwordBreach";
import { requireRecentStepUp } from "../../../../../lib/stepUp";

// Owner-wide (#286): add a password to an owner who signed in with Google,
// email code, Apple or Microsoft. A fresh step-up code is required exactly like
// billing changes (#221) and signing out other devices (#285). The credential
// address is the owner's primary verified address and is never taken from the
// request body. Owners who already have a password use POST /api/account/password.
export const dynamic = "force-dynamic";

const reply = (status: number, body: object) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export const POST = ownerRoute(async (req: NextRequest) => {
  const session = currentSession();
  if (!session) return reply(401, { error: "Sign in to continue" });
  const denied = await requireRecentStepUp(session);
  if (denied) return denied;

  const body = await req.json().catch(() => null) as { password?: unknown } | null;
  const problem = passwordProblem(body?.password);
  if (problem) return reply(400, { error: passwordRuleMessage(problem) });

  const result = await setPasswordForOwner(currentOwner(), body?.password);
  if (!result.ok) {
    if (result.reason === "invalid_password") return reply(400, { error: passwordRuleMessage(passwordProblem(body?.password)) });
    if (result.reason === "breached_password") return reply(400, { error: BREACHED_PASSWORD_MESSAGE });
    if (result.reason === "password_exists") return reply(409, { error: "This account already has a password. Change it instead." });
    if (result.reason === "email_taken") return reply(409, { error: "A password is already set for that address. Sign in or reset it." });
    return reply(400, { error: "Add and verify an email address before setting a password." });
  }
  return reply(200, { ok: true });
});
