import { NextRequest, NextResponse } from "next/server";
import { currentOwner, ownerRoute } from "../../../../lib/authorization";
import { requireRecentStepUp } from "../../../../lib/stepUp";
import { startStripeCheckout } from "../../../../lib/services/stripeBilling";

// Owner-wide Stripe checkout (#223). The client sends only a plan key; the server
// picks the price from config and never grants the plan. Step-up comes before any
// provider or database work.
export const dynamic = "force-dynamic";

const reply = (status: number, body: object) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export const POST = ownerRoute(async (req: NextRequest) => {
  const denied = await requireRecentStepUp();
  if (denied) return denied;

  let body: { plan?: unknown } | null = null;
  try {
    body = await req.json() as { plan?: unknown } | null;
  } catch {
    return reply(400, { error: "Valid JSON body required" });
  }
  if (!body || (body.plan !== "pro" && body.plan !== "business")) {
    return reply(400, { error: "Choose the pro or business plan" });
  }

  const result = await startStripeCheckout(currentOwner(), body.plan);
  return reply(result.status, result.body);
});
