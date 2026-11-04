import { NextRequest, NextResponse } from "next/server";
import { DEV_OWNERS, devAuthEnabled, ensureDevOwner, type DevOwnerKey } from "../../../../lib/devAuth";
import { billingProvider, type BillingProvider } from "../../../../lib/integrations/billing";
import { query } from "../../../../lib/db";
import { applyBillingEvent } from "../../../../lib/services/subscriptions";
import type { Plan } from "../../../../lib/services/entitlements";

// Development-only walkthrough for the fake billing provider (#219). It starts a
// checkout or sends a renewal, failed-payment or cancellation event through the
// same applyBillingEvent path a real webhook will use. Without MOBILE_DEV_AUTH
// in a development process every request answers exactly like an unknown route.
export const dynamic = "force-dynamic";

const reply = (status: number, body: object) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
const actions = ["checkout", "renew", "fail", "cancel"] as const;
type Action = typeof actions[number];

export async function POST(req: NextRequest) {
  if (!devAuthEnabled()) return reply(404, { error: "Not found" });

  let body: Record<string, unknown> | null = null;
  try {
    body = await req.json() as Record<string, unknown> | null;
  } catch {
    return reply(400, { error: "Valid JSON body required" });
  }
  if (!body || typeof body.action !== "string" || !actions.includes(body.action as Action)) {
    return reply(400, { error: "Use checkout, renew, fail or cancel" });
  }
  const which = (body.owner ?? "pro") as DevOwnerKey;
  if (typeof which !== "string" || !Object.prototype.hasOwnProperty.call(DEV_OWNERS, which)) {
    return reply(400, { error: "Unknown demo owner" });
  }

  let provider: BillingProvider;
  try {
    provider = billingProvider();
  } catch {
    return reply(503, { error: "Billing provider is not configured" });
  }

  try {
    const ownerId = await ensureDevOwner(which);
    const action = body.action as Action;
    let event;
    if (action === "checkout") {
      if (body.plan !== "pro" && body.plan !== "business") {
        return reply(400, { error: "Choose the pro or business plan" });
      }
      event = await provider.checkout({ ownerId, plan: body.plan as Plan });
    } else {
      if (typeof body.externalId !== "string" || !body.externalId) {
        return reply(400, { error: "externalId is required" });
      }
      const subscription = (await query<{ plan: Plan }>(
        "SELECT plan FROM owner_subscriptions WHERE provider=$1 AND external_id=$2 AND owner_id=$3",
        [provider.name, body.externalId, ownerId]
      )).rows[0];
      if (!subscription) return reply(404, { error: "Subscription not found" });
      const input = { ownerId, externalId: body.externalId, plan: subscription.plan };
      event = action === "renew" ? await provider.renew(input)
        : action === "fail" ? await provider.failPayment(input)
        : await provider.cancel(input);
    }

    const result = await applyBillingEvent(event);
    return reply(200, {
      action,
      provider: provider.name,
      eventId: event.eventId,
      externalId: event.externalId,
      plan: event.plan,
      status: event.status,
      applied: result.applied,
      duplicate: result.duplicate,
      stale: result.stale
    });
  } catch {
    return reply(400, { error: "Billing event could not be applied" });
  }
}
