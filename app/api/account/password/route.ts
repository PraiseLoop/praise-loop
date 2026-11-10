import { NextRequest, NextResponse } from "next/server";
import { currentOwner, currentSession, ownerRoute } from "../../../../lib/authorization";
import { changePassword, hasPassword, passwordProblem, passwordRuleMessage } from "../../../../lib/passwordAuth";
import { BREACHED_PASSWORD_MESSAGE } from "../../../../lib/passwordBreach";

// Owner-wide (#159): change the signed-in owner's password. The current password
// is required even though the session already proves control, so a borrowed
// browser cannot silently change it. Success deletes the owner's other sessions
// and leaves this one working.
async function handleGET() {
  return NextResponse.json({ hasPassword: await hasPassword(currentOwner()) });
}

async function handlePOST(req: NextRequest) {
  const session = currentSession();
  if (!session) return NextResponse.json({ error: "Sign in to continue" }, { status: 401 });
  const body = await req.json().catch(() => null) as { currentPassword?: unknown; newPassword?: unknown } | null;
  const problem = passwordProblem(body?.newPassword);
  if (problem) return NextResponse.json({ error: passwordRuleMessage(problem) }, { status: 400 });

  const result = await changePassword(currentOwner(), session.token, body?.currentPassword, body?.newPassword);
  if (!result.ok) {
    if (result.reason === "no_password") return NextResponse.json({ error: "This account has no password to change" }, { status: 409 });
    if (result.reason === "invalid_password") return NextResponse.json({ error: passwordRuleMessage(passwordProblem(body?.newPassword)) }, { status: 400 });
    if (result.reason === "breached_password") return NextResponse.json({ error: BREACHED_PASSWORD_MESSAGE }, { status: 400 });
    return NextResponse.json({ error: "That current password is not right" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, revoked: result.revoked });
}

export const GET = ownerRoute(handleGET);
export const POST = ownerRoute(handlePOST);
