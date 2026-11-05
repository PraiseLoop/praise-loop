import { query } from "../db";
import { log, errorFields } from "../log";
import {
  canStillBill,
  planForPriceId,
  priceIdForPlan,
  stripeConfigured,
  stripeGateway,
  stripeWebhookConfigured,
  subscriptionStatusCanStillBill,
  subscriptionToBillingEvent,
  verifyStripeSignature,
  type StripeGateway,
  type StripeSubscription
} from "../integrations/stripe";
import { applyBillingEvent, isPlanKey, type BillingEvent } from "./subscriptions";

// Stripe webhook, checkout and portal (#223). The route files are thin wrappers:
// everything here takes injectable env/fetch and returns a status/body pair, so
// fixtures can exercise every branch without a network or Next.js request.

type Env = Record<string, string | undefined>;

export type BillingResponse = { status: number; body: object };

type Deps = { env?: Env; fetchImpl?: typeof fetch; now?: () => Date };

const reply = (status: number, body: object): BillingResponse => ({ status, body });

const SUBSCRIPTION_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_succeeded",
  "charge.refunded"
]);

type StripeEvent = {
  id?: unknown;
  type?: unknown;
  created?: unknown;
  data?: { object?: unknown };
};

type StripeObject = Record<string, unknown>;

function objectOf(value: unknown): StripeObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as StripeObject : null;
}

function stringId(value: unknown): string | null {
  if (typeof value === "string") return value || null;
  const object = objectOf(value);
  return typeof object?.id === "string" ? object.id : null;
}

function metadataOf(value: unknown): Record<string, unknown> | null {
  const object = objectOf(value);
  return objectOf(object?.metadata);
}

// The owner can be named by the subscription metadata (set at checkout), the
// checkout session's client reference metadata, or the subscription row we
// already stored for this Stripe id.
function ownerFromObject(value: unknown): string | null {
  const object = objectOf(value);
  if (!object) return null;
  if (typeof object.client_reference_id === "string" && object.client_reference_id) return object.client_reference_id;
  const owner = metadataOf(object)?.owner_id;
  return typeof owner === "string" && owner ? owner : null;
}

function planFromSubscription(subscription: StripeSubscription, env: Env, stored: string | null): string | null {
  const priceId = subscription.items?.data?.[0]?.price?.id;
  const fromPrice = planForPriceId(priceId, env);
  if (fromPrice) return fromPrice;
  const fromMetadata = subscription.metadata?.plan;
  if (isPlanKey(fromMetadata ?? "")) return fromMetadata ?? null;
  return stored && isPlanKey(stored) ? stored : null;
}

function eventTime(event: StripeEvent, deps: Deps): Date {
  if (typeof event.created === "number" && Number.isFinite(event.created)) return new Date(event.created * 1000);
  return deps.now?.() ?? new Date();
}

/**
 * Verifies and applies one Stripe event. A bad signature or missing secret writes
 * nothing; the subscription is always re-read from Stripe so out-of-order event
 * payloads can't decide the plan.
 */
export async function handleStripeWebhook(rawBody: string, signature: string | null, deps: Deps = {}): Promise<BillingResponse> {
  const env = deps.env ?? process.env;
  if (!stripeWebhookConfigured(env)) return reply(503, { error: "Stripe is not configured" });
  const secret = env.STRIPE_WEBHOOK_SECRET?.trim() ?? "";
  if (!verifyStripeSignature(rawBody, signature, secret, deps.now?.().getTime() ?? Date.now())) {
    return reply(400, { error: "Invalid signature" });
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return reply(400, { error: "Invalid JSON body" });
  }
  if (!event || typeof event.id !== "string" || typeof event.type !== "string") {
    return reply(400, { error: "Invalid event" });
  }
  if (!SUBSCRIPTION_EVENT_TYPES.has(event.type)) return reply(200, { received: true, handled: false });

  const payload = objectOf(event.data?.object);
  if (!payload) return reply(400, { error: "Invalid event" });

  // Subscription events carry the subscription itself; checkout, invoice and
  // charge events point at one. A refund without a subscription changes nothing.
  const subscriptionId = stringId(event.type.startsWith("customer.subscription.") ? payload : payload.subscription);
  if (!subscriptionId) return reply(200, { received: true, handled: false });

  // Re-reading needs the secret key; the webhook secret alone only proves the event.
  if (!stripeConfigured(env)) return reply(503, { error: "Stripe is not configured" });

  const stored = (await query<{ owner_id: string; plan: string }>(
    "SELECT owner_id,plan FROM owner_subscriptions WHERE provider='stripe' AND external_id=$1",
    [subscriptionId]
  )).rows[0] ?? null;

  let gateway: StripeGateway;
  let subscription: StripeSubscription;
  try {
    gateway = stripeGateway({ env, fetchImpl: deps.fetchImpl });
    subscription = await gateway.retrieveSubscription(subscriptionId);
  } catch (error) {
    log.error("stripe_webhook_read_failed", { eventId: event.id, ...errorFields(error) });
    return reply(500, { error: "Stripe request failed" });
  }

  // Resolve the owner only from trusted identifiers, then verify it is a local
  // owner by letting applyBillingEvent lock the row. A checkout for a deleted
  // owner resolves here but is ignored below.
  const ownerId = ownerFromObject(subscription)
    ?? (event.type === "checkout.session.completed" ? ownerFromObject(payload) : null)
    ?? stored?.owner_id
    ?? null;
  if (!ownerId) {
    log.debug("stripe_webhook_ignored", { eventId: event.id, eventType: event.type, reason: "unknown_owner" });
    return reply(200, { received: true, ignored: true });
  }

  const plan = planFromSubscription(subscription, env, stored?.plan ?? null);
  if (!plan) {
    log.debug("stripe_webhook_ignored", { eventId: event.id, eventType: event.type, reason: "unknown_price" });
    return reply(200, { received: true, ignored: true });
  }

  let billingEvent: BillingEvent;
  try {
    billingEvent = subscriptionToBillingEvent(subscription, {
      ownerId,
      plan,
      eventId: event.id,
      type: event.type,
      occurredAt: eventTime(event, deps)
    });
  } catch (error) {
    log.error("stripe_webhook_invalid", { eventId: event.id, ...errorFields(error) });
    return reply(400, { error: "Invalid event" });
  }

  let result;
  try {
    result = await applyBillingEvent(billingEvent);
  } catch (error) {
    log.error("stripe_webhook_apply_failed", { eventId: event.id, ...errorFields(error) });
    return reply(500, { error: "Billing event could not be applied" });
  }

  // The owner may have been deleted between checkout and delivery. Cancelling
  // the still-billable subscription stops a charge with no account behind it.
  if (result.ignored) {
    if (canStillBill(subscription)) {
      try {
        await gateway.cancelSubscription(subscription.id);
      } catch (error) {
        // A 500 makes Stripe retry the event; do not acknowledge a charge we
        // failed to stop.
        log.error("stripe_webhook_cancel_failed", { eventId: event.id, ...errorFields(error) });
        return reply(500, { error: "Stripe cancellation failed" });
      }
      log.info("stripe_webhook_ignored_cancelled", { eventId: event.id, eventType: event.type });
      return reply(200, { received: true, ignored: true, cancelled: true });
    }
    return reply(200, { received: true, ignored: true });
  }

  log.debug("stripe_webhook_applied", {
    eventId: event.id,
    eventType: event.type,
    applied: result.applied,
    duplicate: result.duplicate,
    stale: result.stale
  });
  return reply(200, { received: true, applied: result.applied, duplicate: result.duplicate, stale: result.stale });
}

/** Whether the owner already has a Stripe subscription that can still charge. */
export async function hasBillableStripeSubscription(ownerId: string): Promise<boolean> {
  const rows = (await query<{ status: string }>(
    "SELECT status FROM owner_subscriptions WHERE owner_id=$1 AND provider='stripe'",
    [ownerId]
  )).rows;
  return rows.some(row => subscriptionStatusCanStillBill(row.status));
}

export async function startStripeCheckout(ownerId: string, plan: string, deps: Deps = {}): Promise<BillingResponse> {
  const env = deps.env ?? process.env;
  // Selling without a verified webhook would take money and grant nothing: the
  // plan only ever changes from the webhook, so both halves must be configured.
  if (!stripeConfigured(env) || !stripeWebhookConfigured(env)) return reply(503, { error: "Stripe is not configured" });
  if (plan !== "pro" && plan !== "business") return reply(400, { error: "Choose the pro or business plan" });
  const priceId = priceIdForPlan(plan, env);
  if (!priceId) return reply(400, { error: "plan_not_available" });
  if (await hasBillableStripeSubscription(ownerId)) return reply(409, { error: "subscription_exists" });

  const base = env.NEXTAUTH_URL?.trim().replace(/\/+$/, "");
  if (!base) return reply(503, { error: "Billing is not configured" });
  const email = (await query<{ email: string | null }>("SELECT email FROM auth_users WHERE id=$1", [ownerId])).rows[0]?.email ?? null;

  try {
    const gateway = stripeGateway({ env, fetchImpl: deps.fetchImpl });
    const { url } = await gateway.createCheckoutSession({
      priceId,
      ownerId,
      plan,
      email,
      successUrl: `${base}/account?checkout=success`,
      cancelUrl: `${base}/plans?checkout=cancelled`
    });
    return reply(200, { url });
  } catch (error) {
    log.error("stripe_checkout_failed", errorFields(error));
    return reply(502, { error: "stripe_unavailable" });
  }
}

export async function startStripePortal(ownerId: string, deps: Deps = {}): Promise<BillingResponse> {
  const env = deps.env ?? process.env;
  if (!stripeConfigured(env)) return reply(503, { error: "Stripe is not configured" });
  const base = env.NEXTAUTH_URL?.trim().replace(/\/+$/, "");
  if (!base) return reply(503, { error: "Billing is not configured" });

  const row = (await query<{ customer_id: string }>(
    `SELECT customer_id FROM owner_subscriptions
     WHERE owner_id=$1 AND provider='stripe' AND customer_id IS NOT NULL
     ORDER BY updated_at DESC, id DESC LIMIT 1`,
    [ownerId]
  )).rows[0];
  if (!row) return reply(400, { error: "no_subscription" });

  try {
    const gateway = stripeGateway({ env, fetchImpl: deps.fetchImpl });
    const { url } = await gateway.createPortalSession({ customerId: row.customer_id, returnUrl: `${base}/account` });
    return reply(200, { url });
  } catch (error) {
    log.error("stripe_portal_failed", errorFields(error));
    return reply(502, { error: "stripe_unavailable" });
  }
}
