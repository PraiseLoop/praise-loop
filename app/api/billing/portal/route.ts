import { NextRequest, NextResponse } from "next/server";
import { currentOwner, ownerRoute } from "../../../../lib/authorization";
import { requireRecentStepUp } from "../../../../lib/stepUp";
import { startStripePortal } from "../../../../lib/services/stripeBilling";

// Owner-wide Stripe customer portal (#223). The customer id is read from the
// owner's subscription row, never from the request, and step-up comes first.
export const dynamic = "force-dynamic";

const reply = (status: number, body: object) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export const POST = ownerRoute(async (_req: NextRequest) => {
  const denied = await requireRecentStepUp();
  if (denied) return denied;

  const result = await startStripePortal(currentOwner());
  return reply(result.status, result.body);
});
