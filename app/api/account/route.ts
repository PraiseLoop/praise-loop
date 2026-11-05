import { NextRequest, NextResponse } from "next/server";
import { currentOwner, currentSession, ownerRoute } from "../../../lib/authorization";
import {
  DELETE_CONFIRMATION,
  SubscriptionCancellationError,
  deleteOwnerAccount
} from "../../../lib/services/accountDeletion";

// Owner-wide and deliberately final: no soft delete, recovery period or
// operator restore. A retry with the deleted session is a 401, not a second
// deletion, and a wrong confirmation changes nothing.
async function handleDELETE(req: NextRequest) {
  const body = await req.json().catch(() => null) as { confirm?: unknown } | null;
  if (body?.confirm !== DELETE_CONFIRMATION) {
    return NextResponse.json({ error: "Type DELETE to confirm account deletion" }, { status: 400 });
  }

  try {
    await deleteOwnerAccount(currentOwner());
  } catch (error) {
    if (!(error instanceof SubscriptionCancellationError)) throw error;
    // The owner is still signed in and nothing was deleted, so a retry is safe.
    return NextResponse.json({ error: error.message }, {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "5" }
    });
  }

  const response = NextResponse.json({ ok: true });
  if (currentSession()?.kind === "web") {
    // The row is gone; clearing the cookie stops the browser presenting it.
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
  }
  return response;
}

export const DELETE = ownerRoute(handleDELETE);
