import { NextResponse } from "next/server";
import { revokeOtherSessions } from "../../../../lib/accountSessions";
import { currentOwner, currentSession, ownerRoute } from "../../../../lib/authorization";
import { requireRecentStepUp } from "../../../../lib/stepUp";

// Owner-wide (#285): end every other web and phone session for the signed-in
// owner and keep this one. It is a sensitive action, so a fresh step-up code is
// required exactly like billing changes (#221). The response carries only the
// number of sessions removed, never a token.
export const dynamic = "force-dynamic";

export const DELETE = ownerRoute(async () => {
  const session = currentSession();
  if (!session) return NextResponse.json({ error: "Sign in to continue" }, { status: 401 });
  const denied = await requireRecentStepUp(session);
  if (denied) return denied;
  const revoked = await revokeOtherSessions(currentOwner(), session.token);
  return NextResponse.json({ ok: true, revoked });
});
