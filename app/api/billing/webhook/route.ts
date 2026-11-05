import { NextRequest, NextResponse } from "next/server";
import { handleStripeWebhook } from "../../../../lib/services/stripeBilling";

// Public Stripe webhook (#223). It is not wrapped in ownerRoute: Stripe has no
// session. The signature over the raw body is the credential, so read the body
// as text and never parse it before verification.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const result = await handleStripeWebhook(await req.text(), req.headers.get("stripe-signature"));
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
