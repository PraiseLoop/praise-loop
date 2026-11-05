import { createHmac, timingSafeEqual } from "node:crypto";
import type { Plan } from "../services/entitlements";
import type { BillingEvent } from "../services/subscriptions";

// Minimal Stripe REST client (#223). No SDK: the three calls we need are plain
// form-encoded requests, and injecting `fetchImpl` keeps every test offline. The
// API version is pinned so `current_period_end` stays on the Subscription object.
export const STRIPE_API_VERSION = "2024-06-20";
const STRIPE_API = "https://api.stripe.com/v1";
const TIMEOUT_MS = 15_000;
const SIGNATURE_TOLERANCE_SECONDS = 300;

type Env = Record<string, string | undefined>;

export type StripeSubscription = {
  id: string;
  status: string;
  current_period_end?: number | null;
  cancel_at_period_end?: boolean;
  customer?: string | { id?: string } | null;
  metadata?: Record<string, string> | null;
  items?: { data?: Array<{ price?: { id?: string | null } | null; current_period_end?: number | null }> } | null;
};

export type CreateCheckoutInput = {
  priceId: string;
  ownerId: string;
  plan: Plan;
  email: string | null;
  successUrl: string;
  cancelUrl: string;
};

export type CreatePortalInput = {
  customerId: string;
  returnUrl: string;
};

export interface StripeGateway {
  createCheckoutSession(input: CreateCheckoutInput): Promise<{ url: string }>;
  createPortalSession(input: CreatePortalInput): Promise<{ url: string }>;
  retrieveSubscription(id: string): Promise<StripeSubscription>;
  cancelSubscription(id: string): Promise<void>;
}

/** Short provider code only; the message never carries a key, body or payload. */
export class StripeApiError extends Error {
  constructor(message: string, readonly status = 0, readonly code?: string) {
    super(message);
    this.name = "StripeApiError";
  }
}

function configured(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

export function stripeSecretKey(env: Env = process.env): string | null {
  return configured(env.STRIPE_SECRET_KEY);
}

export function stripeWebhookSecret(env: Env = process.env): string | null {
  return configured(env.STRIPE_WEBHOOK_SECRET);
}

export function stripeConfigured(env: Env = process.env): boolean {
  return stripeSecretKey(env) !== null;
}

export function stripeWebhookConfigured(env: Env = process.env): boolean {
  return stripeWebhookSecret(env) !== null;
}

export function priceIdForPlan(plan: Plan | string, env: Env = process.env): string | null {
  if (plan === "pro") return configured(env.STRIPE_PRICE_PRO);
  if (plan === "business") return configured(env.STRIPE_PRICE_BUSINESS);
  return null;
}

export function planForPriceId(priceId: string | null | undefined, env: Env = process.env): Plan | null {
  if (!priceId) return null;
  if (priceId === configured(env.STRIPE_PRICE_PRO)) return "pro";
  if (priceId === configured(env.STRIPE_PRICE_BUSINESS)) return "business";
  return null;
}

/** Anything that still creates a charge or can be paid; used before a new checkout. */
export function subscriptionStatusCanStillBill(status: string): boolean {
  return status !== "canceled" && status !== "incomplete_expired";
}

/** A cancellation is only unnecessary when Stripe says the subscription is dead. */
export function canStillBill(subscription: Pick<StripeSubscription, "status">): boolean {
  return subscriptionStatusCanStillBill(subscription.status);
}

function periodEnd(subscription: StripeSubscription): number | null {
  if (typeof subscription.current_period_end === "number") return subscription.current_period_end;
  const itemEnd = subscription.items?.data?.[0]?.current_period_end;
  return typeof itemEnd === "number" ? itemEnd : null;
}

export function subscriptionToBillingEvent(
  subscription: StripeSubscription,
  input: { ownerId: string; plan: string; eventId: string; type: string; occurredAt: Date | string }
): BillingEvent {
  const end = periodEnd(subscription);
  return {
    provider: "stripe",
    eventId: input.eventId,
    type: input.type,
    ownerId: input.ownerId,
    externalId: subscription.id,
    plan: input.plan,
    status: subscription.status,
    currentPeriodEnd: end === null ? null : new Date(end * 1000),
    cancelAtPeriodEnd: !!subscription.cancel_at_period_end,
    customerId: typeof subscription.customer === "string" ? subscription.customer : null,
    occurredAt: input.occurredAt
  };
}

/**
 * Verifies a `Stripe-Signature` header over the exact raw body. Pure, so fixtures
 * cover tampering, an old timestamp and multiple `v1` values without a network.
 */
export function verifyStripeSignature(rawBody: string, header: string | null, secret: string, now = Date.now()): boolean {
  if (!header || !secret) return false;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t" && value && /^\d+$/.test(value)) timestamp = Number(value);
    else if (key === "v1" && value) signatures.push(value);
  }
  if (timestamp === null || !signatures.length) return false;
  if (Math.abs(now - timestamp * 1000) > SIGNATURE_TOLERANCE_SECONDS * 1000) return false;

  const expected = Buffer.from(createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex"), "utf8");
  return signatures.some(signature => {
    const actual = Buffer.from(signature, "utf8");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

type GatewayOptions = { env?: Env; fetchImpl?: typeof fetch; timeoutMs?: number };

class RestStripeGateway implements StripeGateway {
  private readonly env: Env;
  private readonly fetchImpl?: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: GatewayOptions) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    if (!stripeSecretKey(this.env)) throw new StripeApiError("Stripe is not configured", 503);
  }

  private async request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: URLSearchParams): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${stripeSecretKey(this.env)}`,
      "stripe-version": STRIPE_API_VERSION
    };
    if (body) headers["content-type"] = "application/x-www-form-urlencoded";

    let response: Response;
    try {
      response = await (this.fetchImpl ?? fetch)(`${STRIPE_API}${path}`, {
        method,
        headers,
        body: body?.toString(),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      throw new StripeApiError("Stripe request failed", 0);
    }

    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      // A successful cancel may have an empty body; other calls need JSON below.
    }
    if (!response.ok) {
      const error = (json as { error?: { message?: unknown; code?: unknown } } | null)?.error;
      throw new StripeApiError(
        typeof error?.message === "string" ? error.message.slice(0, 200) : "Stripe request failed",
        response.status,
        typeof error?.code === "string" ? error.code : undefined
      );
    }
    return json as T;
  }

  async createCheckoutSession(input: CreateCheckoutInput): Promise<{ url: string }> {
    const body = new URLSearchParams({
      mode: "subscription",
      "line_items[0][price]": input.priceId,
      "line_items[0][quantity]": "1",
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.ownerId,
      "metadata[owner_id]": input.ownerId,
      "subscription_data[metadata][owner_id]": input.ownerId,
      "subscription_data[metadata][plan]": input.plan,
      "automatic_tax[enabled]": "true",
      billing_address_collection: "auto"
    });
    if (input.email) body.set("customer_email", input.email);
    const session = await this.request<{ url?: unknown }>("POST", "/checkout/sessions", body);
    if (typeof session.url !== "string" || !session.url) throw new StripeApiError("Stripe returned no checkout URL");
    return { url: session.url };
  }

  async createPortalSession(input: CreatePortalInput): Promise<{ url: string }> {
    const session = await this.request<{ url?: unknown }>(
      "POST",
      "/billing_portal/sessions",
      new URLSearchParams({ customer: input.customerId, return_url: input.returnUrl })
    );
    if (typeof session.url !== "string" || !session.url) throw new StripeApiError("Stripe returned no portal URL");
    return { url: session.url };
  }

  async retrieveSubscription(id: string): Promise<StripeSubscription> {
    return this.request<StripeSubscription>("GET", `/subscriptions/${encodeURIComponent(id)}`);
  }

  async cancelSubscription(id: string): Promise<void> {
    try {
      await this.request("DELETE", `/subscriptions/${encodeURIComponent(id)}`);
    } catch (error) {
      // Stripe reports a missing subscription as 404/resource_missing and an
      // already-ended one as a 400 ("already canceled"). Account deletion retries
      // after a partial failure, so both mean the desired end state is reached.
      const alreadyGone = error instanceof StripeApiError && (
        error.status === 404 ||
        error.code === "resource_missing" ||
        (error.status === 400 && /already (?:been )?cancel(?:l)?ed/i.test(error.message))
      );
      if (alreadyGone) return;
      throw error;
    }
  }
}

export function stripeGateway(options: GatewayOptions = {}): StripeGateway {
  return new RestStripeGateway(options);
}
