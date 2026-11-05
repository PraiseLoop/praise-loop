import { transaction } from "../db";
import { PLAN_ORDER } from "../plansDisplay";
import type { Plan, PlanSource } from "./entitlements";

// A provider keeps sending its own statuses; this module decides which of them
// still grant a plan. `past_due` keeps the plan during a short grace period after
// the paid-through date so a failed renewal does not lock the owner out at once.
export const PAST_DUE_GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;

export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "incomplete"
  | "incomplete_expired"
  | "paused";

export function subscriptionIsActive(
  status: string,
  currentPeriodEnd: Date | string | null,
  now = new Date()
): boolean {
  const end = currentPeriodEnd ? new Date(currentPeriodEnd) : null;
  if (end && Number.isNaN(end.getTime())) return false;
  switch (status) {
    case "active":
    case "trialing":
      return !end || end.getTime() > now.getTime();
    case "past_due":
      return !!end && end.getTime() + PAST_DUE_GRACE_PERIOD_MS > now.getTime();
    default:
      return false;
  }
}

// Stripe and the local fake adapter share the web-subscription source; a future
// store adapter keeps its own source. The plan reported to clients is the source
// of the grant that actually won, not a merged or default label.
export function sourceForProvider(provider: string): PlanSource {
  return provider === "store" ? "store" : "stripe";
}

export function isPlanKey(plan: string): plan is Plan {
  return PLAN_ORDER.includes(plan as Plan);
}

export type BillingEvent = {
  provider: string;
  eventId: string;
  type: string;
  ownerId: string;
  externalId: string;
  plan: string;
  status: string;
  currentPeriodEnd: Date | string | null;
  cancelAtPeriodEnd?: boolean;
  // The provider's customer id, when the event carries one. Optional so the fake
  // adapter and older callers stay unchanged; a missing value never clears a
  // stored one.
  customerId?: string | null;
  occurredAt: Date | string;
};

export type ApplyBillingEventResult = {
  applied: boolean;
  duplicate: boolean;
  stale: boolean;
  // A provider can deliver an event after the owner deleted their account. It is
  // acknowledged but records nothing, because no local owner remains to own it.
  ignored: boolean;
};

function validDate(value: Date | string, label: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Use a valid ${label}`);
  return date;
}

function sameInstant(a: Date | string | null, b: Date | null): boolean {
  if (a === null || b === null) return a === null && b === null;
  return new Date(a).getTime() === b.getTime();
}

// The only path a provider event may take. The event row, the subscription
// upsert and the audit event commit together, so a retry or a concurrent
// delivery cannot partly apply. Webhooks never touch `owner_plans`.
export async function applyBillingEvent(event: BillingEvent): Promise<ApplyBillingEventResult> {
  if (!event.provider || !event.eventId || !event.ownerId || !event.externalId) {
    throw new Error("A billing event needs a provider, event id, owner and external subscription id");
  }
  if (!isPlanKey(event.plan)) throw new Error("A billing event needs a known plan");
  const occurredAt = validDate(event.occurredAt, "event time");
  const currentPeriodEnd = event.currentPeriodEnd === null ? null : validDate(event.currentPeriodEnd, "period end");
  const cancelAtPeriodEnd = event.cancelAtPeriodEnd ?? false;

  return transaction(async client => {
    // A late event for a deleted owner is ignored before anything is inserted.
    // Locking the owner row also orders this against an account deletion that is
    // already in flight, so the foreign key cannot fail afterwards. Other
    // database errors stay errors: only a genuinely missing owner is ignored.
    const owner = await client.query("SELECT 1 FROM auth_users WHERE id=$1 FOR KEY SHARE", [event.ownerId]);
    if (!owner.rowCount) return { applied: false, duplicate: false, stale: false, ignored: true };

    const recorded = await client.query(
      `INSERT INTO billing_events(provider,event_id,owner_id,type,occurred_at)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(provider,event_id) DO NOTHING
       RETURNING id`,
      [event.provider, event.eventId, event.ownerId, event.type, occurredAt]
    );
    if (!recorded.rowCount) return { applied: false, duplicate: true, stale: false, ignored: false };

    // Serialize concurrent events for one subscription, so the timestamp check
    // below cannot be raced by two deliveries that both saw no row yet.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${event.provider}:${event.externalId}`]);

    const existing = (await client.query(
      `SELECT owner_id,plan,status,current_period_end,cancel_at_period_end,last_event_at,customer_id
       FROM owner_subscriptions WHERE provider=$1 AND external_id=$2 FOR UPDATE`,
      [event.provider, event.externalId]
    )).rows[0];

    // A subscription belongs to the owner who started it. Throwing rolls back the event
    // row too, so a mistaken event can't take a paid plan away or hand it to someone else.
    if (existing && existing.owner_id !== event.ownerId) throw new Error("This subscription belongs to another owner");

    // A late delivery for an older period is recorded but must not roll the
    // subscription back to a status that has already been superseded.
    if (existing?.last_event_at && occurredAt.getTime() < new Date(existing.last_event_at).getTime()) {
      return { applied: false, duplicate: false, stale: true, ignored: false };
    }

    const changed = !existing
      || existing.plan !== event.plan
      || existing.status !== event.status
      || !sameInstant(existing.current_period_end, currentPeriodEnd)
      || existing.cancel_at_period_end !== cancelAtPeriodEnd;

    await client.query(
      `INSERT INTO owner_subscriptions(owner_id,provider,external_id,plan,status,current_period_end,cancel_at_period_end,last_event_at,customer_id,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
       ON CONFLICT(provider,external_id) DO UPDATE SET
         plan=EXCLUDED.plan,
         status=EXCLUDED.status,
         current_period_end=EXCLUDED.current_period_end,
         cancel_at_period_end=EXCLUDED.cancel_at_period_end,
         last_event_at=EXCLUDED.last_event_at,
         customer_id=COALESCE(EXCLUDED.customer_id, owner_subscriptions.customer_id),
         updated_at=now()`,
      [
        event.ownerId,
        event.provider,
        event.externalId,
        event.plan,
        event.status,
        currentPeriodEnd,
        cancelAtPeriodEnd,
        occurredAt,
        event.customerId ?? null
      ]
    );

    if (changed) {
      await client.query(
        `INSERT INTO owner_plan_events(owner_id,plan,source,expires_at,actor,reason)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [
          event.ownerId,
          event.plan,
          sourceForProvider(event.provider),
          currentPeriodEnd,
          `provider:${event.provider}`,
          `billing:${event.type}`
        ]
      );
    }

    return { applied: true, duplicate: false, stale: false, ignored: false };
  });
}
