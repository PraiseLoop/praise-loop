import { NextRequest, NextResponse } from "next/server";
import { verifyAppleIdToken } from "../../../../lib/appleIdToken";
import { currentOwner, ownerRoute } from "../../../../lib/authorization";
import { linkIdentityToOwner, listMethods, unlinkMethod, type LinkFailure } from "../../../../lib/authLinking";
import { verifyGoogleIdToken } from "../../../../lib/googleIdToken";
import { verifyMicrosoftIdToken } from "../../../../lib/microsoftIdToken";

const messages: Record<LinkFailure, string> = {
  invalid_identity: "That sign-in method is not valid",
  provider_already_linked: "This account already has a different account for that sign-in method",
  account_taken: "That sign-in method already belongs to another account",
  unknown_owner: "Account not found",
  last_method: "Keep at least one sign-in method so you can sign in again",
  not_found: "Sign-in method not found"
};

function fail(reason: LinkFailure) {
  const status = reason === "not_found" || reason === "unknown_owner" ? 404 : reason === "invalid_identity" ? 400 : 409;
  return NextResponse.json({ error: messages[reason] }, { status });
}

// The signed-in owner's linked methods. Both the web and phone clients use this,
// so the two can never disagree about what is attached.
async function handleGET() {
  return NextResponse.json({ methods: await listMethods(currentOwner()) });
}

// Link a method from an already signed-in session. Google and Apple have native
// token exchanges today; a future provider adds its verifier here.
async function handlePOST(req: NextRequest) {
  const body = await req.json().catch(() => null) as { provider?: unknown; idToken?: unknown } | null;
  if (body?.provider === "google") {
    const identity = typeof body.idToken === "string" ? await verifyGoogleIdToken(body.idToken) : null;
    if (!identity) return NextResponse.json({ error: "Invalid Google sign-in" }, { status: 400 });
    const result = await linkIdentityToOwner(currentOwner(), {
      provider: "google",
      subject: identity.sub,
      email: identity.email,
      emailVerified: true,
      name: identity.name
    });
    return result.ok ? NextResponse.json({ methods: result.methods }) : fail(result.reason);
  }
  if (body?.provider === "apple") {
    const identity = typeof body.idToken === "string" ? await verifyAppleIdToken(body.idToken) : null;
    if (!identity) return NextResponse.json({ error: "Invalid Apple sign-in" }, { status: 400 });
    const result = await linkIdentityToOwner(currentOwner(), {
      provider: "apple",
      subject: identity.subject,
      email: identity.email,
      emailVerified: identity.emailVerified
    });
    return result.ok ? NextResponse.json({ methods: result.methods }) : fail(result.reason);
  }
  if (body?.provider === "microsoft") {
    const identity = typeof body.idToken === "string" ? await verifyMicrosoftIdToken(body.idToken) : null;
    if (!identity) return NextResponse.json({ error: "Invalid Microsoft sign-in" }, { status: 400 });
    const result = await linkIdentityToOwner(currentOwner(), {
      provider: "microsoft",
      subject: identity.subject,
      email: identity.email,
      emailVerified: false,
      name: identity.name
    });
    return result.ok ? NextResponse.json({ methods: result.methods }) : fail(result.reason);
  }
  return NextResponse.json({ error: "Only Google, Apple and Microsoft can be linked right now" }, { status: 400 });
}

// Unlink by provider. The last method is refused by the shared policy.
async function handleDELETE(req: NextRequest) {
  const body = await req.json().catch(() => null) as { provider?: unknown } | null;
  if (typeof body?.provider !== "string" || !body.provider) return NextResponse.json({ error: "A sign-in provider is required" }, { status: 400 });
  const result = await unlinkMethod(currentOwner(), body.provider);
  return result.ok ? NextResponse.json({ methods: result.methods }) : fail(result.reason);
}

export const GET = ownerRoute(handleGET);
export const POST = ownerRoute(handlePOST);
export const DELETE = ownerRoute(handleDELETE);
