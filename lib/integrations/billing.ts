import { randomUUID } from "node:crypto";
import type { Plan } from "../services/entitlements";
import type { BillingEvent, SubscriptionStatus } from "../services/subscriptions";
import { stripeGateway, stripeSecretKey } from "./stripe";

// Provider adapters only translate their own events into the shared BillingEvent
// shape; lib/services/subscriptions.ts is the one place that applies them. Stripe
// (#223) and the app stores (#95) will sit behind this same interface.
export type CheckoutInput = {
  ownerId: string;
  plan: Plan;
  now?: Date;
};

export type SubscriptionInput = {
  ownerId: string;
  externalId: string;
  plan: Plan;
  now?: Date;
};

// Account deletion only needs to end a subscription; the fake's event methods
// belong only to the development walkthrough. Splitting the types keeps the
// deletion path from claiming it can simulate checkout.
export type BillingCanceller = {
  readonly name: string;
  // Ends billing at the provider immediately. Calling it again for a
  // subscription that is already cancelled must succeed without another charge
  // or side effect, because account deletion may retry after a partial failure.
  cancel(externalId: string): Promise<void>;
};

export type BillingProvider = BillingCanceller & {
  checkout(input: CheckoutInput): Promise<BillingEvent>;
  renew(input: SubscriptionInput): Promise<BillingEvent>;
  failPayment(input: SubscriptionInput): Promise<BillingEvent>;
  // The event a provider reports when a subscription ends. This is not the
  // cancel call itself; the dev route uses it to walk the webhook path.
  cancelEvent(input: SubscriptionInput): Promise<BillingEvent>;
};

export const BILLING_PROVIDER_ENV = "BILLING_PROVIDER";
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

// Mirrors devAuthEnabled: the config alone is not enough, the process must also
// not be a production build. A stray BILLING_PROVIDER=fake in a server .env
// therefore cannot make the fake adapter available.
export function fakeBillingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[BILLING_PROVIDER_ENV] === "fake" && env.NODE_ENV !== "production";
}

function requireFake(env: Record<string, string | undefined> = process.env) {
  if (!fakeBillingEnabled(env)) {
    throw new Error("The fake billing provider is not available in this process");
  }
}

// The fake has no provider to call, so tests can make one cancellation fail and
// can inspect which ids were cancelled. Both are development/test-only, like
// the fake itself.
const cancelledIds = new Set<string>();
const failingIds = new Set<string>();

export function failFakeBillingCancellation(externalId: string, fail = true): void {
  if (fail) failingIds.add(externalId);
  else failingIds.delete(externalId);
}

export function resetFakeBillingCancellations(): void {
  cancelledIds.clear();
  failingIds.clear();
}

export function fakeBillingCancelledIds(): string[] {
  return [...cancelledIds];
}

function event(
  provider: string,
  type: string,
  input: { ownerId: string; externalId: string; plan: Plan; status: SubscriptionStatus; currentPeriodEnd: Date; cancelAtPeriodEnd?: boolean; now: Date }
): BillingEvent {
  return {
    provider,
    eventId: `fake_evt_${randomUUID()}`,
    type,
    ownerId: input.ownerId,
    externalId: input.externalId,
    plan: input.plan,
    status: input.status,
    currentPeriodEnd: input.currentPeriodEnd,
    cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
    occurredAt: input.now
  };
}

export const fakeBillingProvider: BillingProvider = {
  name: "fake",
  async checkout(input) {
    requireFake();
    const now = input.now ?? new Date();
    return event("fake", "checkout.completed", {
      ...input,
      externalId: `fake_sub_${randomUUID()}`,
      status: "active",
      currentPeriodEnd: new Date(now.getTime() + MONTH_MS),
      now
    });
  },
  async renew(input) {
    requireFake();
    const now = input.now ?? new Date();
    return event("fake", "subscription.renewed", {
      ...input,
      status: "active",
      currentPeriodEnd: new Date(now.getTime() + MONTH_MS),
      now
    });
  },
  async failPayment(input) {
    requireFake();
    const now = input.now ?? new Date();
    // The payment failed at the end of the paid period; the grace period in
    // subscriptionIsActive keeps the plan briefly while the owner retries.
    return event("fake", "subscription.payment_failed", {
      ...input,
      status: "past_due",
      currentPeriodEnd: now,
      now
    });
  },
  async cancelEvent(input) {
    requireFake();
    const now = input.now ?? new Date();
    return event("fake", "subscription.canceled", {
      ...input,
      status: "canceled",
      currentPeriodEnd: now,
      cancelAtPeriodEnd: true,
      now
    });
  },
  async cancel(externalId) {
    requireFake();
    if (!externalId) throw new Error("A subscription id is required");
    if (failingIds.has(externalId)) throw new Error("Synthetic billing cancellation failure");
    // A set makes the second call for the same subscription a successful no-op.
    cancelledIds.add(externalId);
  }
};

export function billingProvider(env: Record<string, string | undefined> = process.env): BillingProvider {
  if (env[BILLING_PROVIDER_ENV] === "fake") {
    if (env.NODE_ENV === "production") throw new Error("The fake billing provider is not available in production");
    return fakeBillingProvider;
  }
  throw new Error("No billing provider is configured");
}

// Stripe implements cancellation through the same REST client as checkout and
// the webhook. It is selected whenever a secret key exists, so account deletion
// keeps working for real subscriptions without loading the fake's event methods.
function stripeCanceller(env: Record<string, string | undefined>): BillingCanceller {
  return {
    name: "stripe",
    async cancel(externalId) {
      if (!externalId) throw new Error("A subscription id is required");
      await stripeGateway({ env }).cancelSubscription(externalId);
    }
  };
}

// The development fake wins when it is explicitly selected: a developer can have
// Stripe test keys in the same .env and still delete a seeded fake owner. In
// production the fake is refused, so Stripe is the only provider left.
export function billingCanceller(env: Record<string, string | undefined> = process.env): BillingCanceller {
  if (fakeBillingEnabled(env)) return fakeBillingProvider;
  if (stripeSecretKey(env)) return stripeCanceller(env);
  throw new Error("No billing provider is configured");
}
