import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { databaseFixture } from "./db-fixture";
import { sessionHash } from "../lib/auth-adapter";
import { billingCanceller } from "../lib/integrations/billing";
import {
  StripeApiError,
  canStillBill,
  planForPriceId,
  priceIdForPlan,
  stripeGateway,
  subscriptionToBillingEvent,
  verifyStripeSignature,
  type StripeSubscription
} from "../lib/integrations/stripe";
import { cancelOwnerSubscriptions } from "../lib/services/accountDeletion";
import { entitlementsFor } from "../lib/services/entitlements";
import { PAST_DUE_GRACE_PERIOD_MS } from "../lib/services/subscriptions";
import { handleStripeWebhook } from "../lib/services/stripeBilling";

const SECRET = "whsec_synthetic_for_tests";
const ENV = {
  STRIPE_SECRET_KEY: "sk_test_synthetic",
  STRIPE_WEBHOOK_SECRET: SECRET,
  STRIPE_PRICE_PRO: "price_pro_synthetic",
  STRIPE_PRICE_BUSINESS: "price_business_synthetic",
  NEXTAUTH_URL: "http://localhost"
};

type Call = { url: string; method: string; headers: Record<string, string>; body: string };

function fakeFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(init.headers ?? {})) headers[key.toLowerCase()] = String(value);
    const call = {
      url: String(input),
      method: String(init.method ?? "GET"),
      headers,
      body: typeof init.body === "string" ? init.body : ""
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function subscription(overrides: Partial<StripeSubscription> = {}): StripeSubscription {
  const end = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
  return {
    id: "sub_synthetic",
    status: "active",
    current_period_end: end,
    cancel_at_period_end: false,
    customer: "cus_synthetic",
    metadata: { owner_id: "purchase-owner", plan: "pro" },
    items: { data: [{ price: { id: ENV.STRIPE_PRICE_PRO }, current_period_end: end }] },
    ...overrides
  };
}

function stripeFetch(routes: {
  checkout?: (call: Call) => Response | Promise<Response>;
  portal?: (call: Call) => Response | Promise<Response>;
  subscription?: StripeSubscription | ((id: string) => StripeSubscription | Error);
  cancel?: (id: string) => Response | Promise<Response>;
} = {}) {
  return fakeFetch(call => {
    const url = new URL(call.url);
    const subPath = /^\/v1\/subscriptions\/(.+)$/.exec(url.pathname);
    if (call.method === "POST" && url.pathname === "/v1/checkout/sessions") {
      return routes.checkout?.(call) ?? json({ id: "cs_synthetic", url: "https://checkout.stripe.test/session" });
    }
    if (call.method === "POST" && url.pathname === "/v1/billing_portal/sessions") {
      return routes.portal?.(call) ?? json({ id: "bps_synthetic", url: "https://billing.stripe.test/session" });
    }
    if (call.method === "DELETE" && subPath) {
      return routes.cancel?.(decodeURIComponent(subPath[1])) ?? json({ id: decodeURIComponent(subPath[1]), status: "canceled" });
    }
    if (call.method === "GET" && subPath) {
      const id = decodeURIComponent(subPath[1]);
      const value = typeof routes.subscription === "function" ? routes.subscription(id) : routes.subscription;
      if (value instanceof Error) throw value;
      return json(value ?? subscription({ id }));
    }
    throw new Error(`unexpected Stripe call ${call.method} ${call.url}`);
  });
}

function signature(raw: string, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

function eventBody(type: string, object: unknown, options: { id: string; created?: number }): string {
  return JSON.stringify({
    id: options.id,
    type,
    created: options.created ?? Math.floor(Date.now() / 1000),
    data: { object }
  });
}

function webhook(raw: string, fetchImpl: typeof fetch, env: Record<string, string | undefined> = ENV, header = signature(raw)) {
  return handleStripeWebhook(raw, header, { env, fetchImpl, now: () => new Date() });
}

function cookieRequest(path: string, method: string, body: unknown, session = "stripe-route-session") {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { cookie: `next-auth.session-token=${session}`, origin: "http://localhost", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

function anonymousRequest(path: string, method: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { origin: "http://localhost", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

async function main() {
  // Config and mapping are pure.
  assert.equal(priceIdForPlan("pro", ENV), ENV.STRIPE_PRICE_PRO);
  assert.equal(priceIdForPlan("business", ENV), ENV.STRIPE_PRICE_BUSINESS);
  assert.equal(priceIdForPlan("free", ENV), null);
  assert.equal(priceIdForPlan("pro", {}), null, "a plan without a configured price cannot be bought");
  assert.equal(planForPriceId(ENV.STRIPE_PRICE_PRO, ENV), "pro");
  assert.equal(planForPriceId(ENV.STRIPE_PRICE_BUSINESS, ENV), "business");
  assert.equal(planForPriceId("price_unknown", ENV), null);
  assert.equal(planForPriceId(null, ENV), null);

  const mapped = subscriptionToBillingEvent(subscription({
    id: "sub_mapped",
    current_period_end: undefined,
    items: { data: [{ price: { id: ENV.STRIPE_PRICE_PRO }, current_period_end: 1_800_000_000 }] },
    cancel_at_period_end: true
  }), { ownerId: "mapped-owner", plan: "pro", eventId: "evt_mapped", type: "invoice.paid", occurredAt: "2026-11-04T12:00:00Z" });
  assert.deepEqual(mapped, {
    provider: "stripe",
    eventId: "evt_mapped",
    type: "invoice.paid",
    ownerId: "mapped-owner",
    externalId: "sub_mapped",
    plan: "pro",
    status: "active",
    currentPeriodEnd: new Date(1_800_000_000_000),
    cancelAtPeriodEnd: true,
    customerId: "cus_synthetic",
    occurredAt: "2026-11-04T12:00:00Z"
  }, "the period end falls back to the subscription item and a string customer id is stored");
  const objectCustomer = subscriptionToBillingEvent(subscription({ customer: { id: "cus_object" } }), {
    ownerId: "mapped-owner", plan: "pro", eventId: "evt_mapped_2", type: "invoice.paid", occurredAt: new Date()
  });
  assert.equal(objectCustomer.customerId, null, "an expanded customer object is not stored as an id");
  assert.equal(canStillBill(subscription({ status: "active" })), true);
  assert.equal(canStillBill(subscription({ status: "past_due" })), true);
  assert.equal(canStillBill(subscription({ status: "canceled" })), false);
  assert.equal(canStillBill(subscription({ status: "incomplete_expired" })), false);

  // Signature: valid, missing, wrong secret, tampered, stale and multiple v1.
  const raw = eventBody("invoice.paid", { subscription: "sub_signature" }, { id: "evt_signature" });
  const now = Date.now();
  assert.equal(verifyStripeSignature(raw, signature(raw), SECRET, now), true);
  assert.equal(verifyStripeSignature(raw, null, SECRET, now), false, "a missing header is refused");
  assert.equal(verifyStripeSignature(raw, "", SECRET, now), false);
  assert.equal(verifyStripeSignature(raw, signature(raw, "whsec_other"), SECRET, now), false, "another secret is refused");
  assert.equal(verifyStripeSignature(`${raw} `, signature(raw), SECRET, now), false, "a tampered body is refused");
  assert.equal(verifyStripeSignature(raw, signature(raw, SECRET, Math.floor(now / 1000) - 301), SECRET, now), false, "a stale timestamp is refused");
  assert.equal(verifyStripeSignature(raw, `t=${Math.floor(now / 1000)},v1=${"0".repeat(64)},v1=${signature(raw).split("v1=")[1]}`, SECRET, now), true, "one valid v1 is enough");
  assert.equal(verifyStripeSignature(raw, "v1=abc", SECRET, now), false, "a header without t is refused");

  // The REST client sends form bodies, pins the API version and maps errors.
  const checkout = stripeFetch();
  const gateway = stripeGateway({ env: ENV, fetchImpl: checkout.fetchImpl });
  const checkoutUrl = await gateway.createCheckoutSession({
    priceId: ENV.STRIPE_PRICE_PRO,
    ownerId: "checkout-owner",
    plan: "pro",
    email: "checkout@example.invalid",
    successUrl: "http://localhost/account?checkout=success",
    cancelUrl: "http://localhost/plans?checkout=cancelled"
  });
  assert.deepEqual(checkoutUrl, { url: "https://checkout.stripe.test/session" });
  const checkoutCall = checkout.calls[0];
  assert.equal(checkoutCall.method, "POST");
  assert.equal(checkoutCall.headers.authorization, "Bearer sk_test_synthetic");
  assert.equal(checkoutCall.headers["stripe-version"], "2024-06-20");
  assert.equal(checkoutCall.headers["content-type"], "application/x-www-form-urlencoded");
  const checkoutParams = new URLSearchParams(checkoutCall.body);
  assert.equal(checkoutParams.get("mode"), "subscription");
  assert.equal(checkoutParams.get("line_items[0][price]"), ENV.STRIPE_PRICE_PRO);
  assert.equal(checkoutParams.get("line_items[0][quantity]"), "1");
  assert.equal(checkoutParams.get("client_reference_id"), "checkout-owner");
  assert.equal(checkoutParams.get("metadata[owner_id]"), "checkout-owner");
  assert.equal(checkoutParams.get("subscription_data[metadata][owner_id]"), "checkout-owner");
  assert.equal(checkoutParams.get("subscription_data[metadata][plan]"), "pro");
  assert.equal(checkoutParams.get("customer_email"), "checkout@example.invalid");
  assert.equal(checkoutParams.get("automatic_tax[enabled]"), "true");
  assert.equal(checkoutParams.get("billing_address_collection"), "auto");
  assert.equal(checkoutParams.get("success_url"), "http://localhost/account?checkout=success");
  assert.equal(checkoutParams.get("cancel_url"), "http://localhost/plans?checkout=cancelled");

  const noEmail = stripeFetch();
  await stripeGateway({ env: ENV, fetchImpl: noEmail.fetchImpl }).createCheckoutSession({
    priceId: ENV.STRIPE_PRICE_PRO, ownerId: "checkout-owner", plan: "pro", email: null,
    successUrl: "http://localhost/account?checkout=success", cancelUrl: "http://localhost/plans?checkout=cancelled"
  });
  assert.equal(new URLSearchParams(noEmail.calls[0].body).get("customer_email"), null, "a missing email is omitted");

  const portal = stripeFetch();
  assert.deepEqual(
    await stripeGateway({ env: ENV, fetchImpl: portal.fetchImpl }).createPortalSession({ customerId: "cus_portal", returnUrl: "http://localhost/account" }),
    { url: "https://billing.stripe.test/session" }
  );
  const portalParams = new URLSearchParams(portal.calls[0].body);
  assert.equal(portalParams.get("customer"), "cus_portal");
  assert.equal(portalParams.get("return_url"), "http://localhost/account");

  const retrieve = stripeFetch({ subscription: subscription({ id: "sub_read" }) });
  assert.equal((await stripeGateway({ env: ENV, fetchImpl: retrieve.fetchImpl }).retrieveSubscription("sub_read")).id, "sub_read");

  // Cancel is idempotent for a missing or already-ended subscription, in every
  // shape Stripe reports: 404, resource_missing, and the 400 "already canceled".
  for (const response of [
    json({ error: { message: "No such subscription" } }, 404),
    json({ error: { message: "No such subscription", code: "resource_missing" } }, 400),
    json({ error: { message: "This subscription has already been canceled." } }, 400)
  ]) {
    const cancel = stripeFetch({ cancel: () => response });
    await stripeGateway({ env: ENV, fetchImpl: cancel.fetchImpl }).cancelSubscription("sub_missing");
  }
  const failedCancel = stripeFetch({ cancel: () => json({ error: { message: "Server error" } }, 500) });
  await assert.rejects(
    () => stripeGateway({ env: ENV, fetchImpl: failedCancel.fetchImpl }).cancelSubscription("sub_failed"),
    (error: unknown) => error instanceof StripeApiError && error.status === 500
  );

  const savedEnv = {
    NEXTAUTH_URL: process.env.NEXTAUTH_URL,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    STRIPE_PRICE_PRO: process.env.STRIPE_PRICE_PRO,
    STRIPE_PRICE_BUSINESS: process.env.STRIPE_PRICE_BUSINESS
  };
  const savedFetch = globalThis.fetch;
  Object.assign(process.env, ENV);

  try {
    await databaseFixture(async client => {
      await client.query(`INSERT INTO auth_users(id,email) VALUES
        ('purchase-owner','purchase@example.invalid'),('failed-owner','failed@example.invalid'),
        ('cancel-owner','cancel@example.invalid'),('expiry-owner','expiry@example.invalid'),
        ('refund-owner','refund@example.invalid'),('route-owner','route@example.invalid'),
        ('active-owner','active@example.invalid'),('no-price-owner','no-price@example.invalid'),
        ('portal-owner','portal@example.invalid'),('delete-stripe-owner','delete-stripe@example.invalid')`);

      // Purchase: the event row, subscription and audit commit together, and the
      // manual plan table is untouched.
      const purchaseSub = subscription({
        id: "sub_purchase",
        customer: "cus_purchase",
        metadata: { owner_id: "purchase-owner", plan: "pro" }
      });
      const purchaseFetch = stripeFetch({ subscription: purchaseSub });
      const purchaseRaw = eventBody("checkout.session.completed", {
        id: "cs_purchase", subscription: "sub_purchase", client_reference_id: "purchase-owner", metadata: { owner_id: "purchase-owner" }
      }, { id: "evt_purchase" });
      const purchase = await webhook(purchaseRaw, purchaseFetch.fetchImpl);
      assert.equal(purchase.status, 200);
      assert.deepEqual(purchase.body, { received: true, applied: true, duplicate: false, stale: false });
      const purchaseRow = (await client.query(
        "SELECT plan,status,current_period_end,customer_id FROM owner_subscriptions WHERE external_id='sub_purchase'"
      )).rows[0];
      assert.equal(purchaseRow.plan, "pro");
      assert.equal(purchaseRow.status, "active");
      assert.equal(purchaseRow.customer_id, "cus_purchase");
      assert.equal(new Date(purchaseRow.current_period_end).getTime(), purchaseSub.current_period_end! * 1000);
      assert.equal((await client.query("SELECT count(*)::int n FROM owner_plans WHERE owner_id='purchase-owner'")).rows[0].n, 0, "checkout never writes owner_plans");
      assert.equal((await client.query("SELECT count(*)::int n FROM billing_events WHERE owner_id='purchase-owner'")).rows[0].n, 1);
      assert.equal((await entitlementsFor("purchase-owner")).plan, "pro");

      // A duplicate event id is recorded once and acknowledged.
      const duplicate = await webhook(purchaseRaw, purchaseFetch.fetchImpl);
      assert.deepEqual(duplicate, { status: 200, body: { received: true, applied: false, duplicate: true, stale: false } });
      assert.equal((await client.query("SELECT count(*)::int n FROM billing_events WHERE owner_id='purchase-owner'")).rows[0].n, 1);
      assert.equal((await client.query("SELECT count(*)::int n FROM owner_plan_events WHERE owner_id='purchase-owner'")).rows[0].n, 1);

      // Renewal: the re-read subscription moves the period forward.
      const renewalSub = subscription({
        ...purchaseSub,
        current_period_end: purchaseSub.current_period_end! + 30 * 24 * 60 * 60,
        items: { data: [{ price: { id: ENV.STRIPE_PRICE_PRO }, current_period_end: purchaseSub.current_period_end! + 30 * 24 * 60 * 60 }] }
      });
      const renewalRaw = eventBody("invoice.paid", { subscription: "sub_purchase" }, {
        id: "evt_renewal",
        created: Math.floor(Date.now() / 1000) + 10
      });
      assert.equal((await webhook(renewalRaw, stripeFetch({ subscription: renewalSub }).fetchImpl)).status, 200);
      const renewedRow = (await client.query("SELECT current_period_end FROM owner_subscriptions WHERE external_id='sub_purchase'")).rows[0];
      assert.equal(new Date(renewedRow.current_period_end).getTime(), renewalSub.current_period_end! * 1000, "a renewal moves the period end forward");

      // Failed payment: the plan survives inside the three-day grace, then Free.
      const failedEnd = Math.floor(Date.now() / 1000);
      const failedSub = subscription({
        id: "sub_failed",
        status: "past_due",
        current_period_end: failedEnd,
        items: { data: [{ price: { id: ENV.STRIPE_PRICE_PRO }, current_period_end: failedEnd }] },
        metadata: { owner_id: "failed-owner", plan: "pro" }
      });
      const failedRaw = eventBody("invoice.payment_failed", { subscription: "sub_failed" }, { id: "evt_failed", created: failedEnd });
      assert.equal((await webhook(failedRaw, stripeFetch({ subscription: failedSub }).fetchImpl)).status, 200);
      assert.equal((await client.query("SELECT status FROM owner_subscriptions WHERE external_id='sub_failed'")).rows[0].status, "past_due");
      assert.equal((await entitlementsFor("failed-owner", undefined, new Date(failedEnd * 1000 + 1000))).plan, "pro");
      assert.equal((await entitlementsFor("failed-owner", undefined, new Date(failedEnd * 1000 + PAST_DUE_GRACE_PERIOD_MS + 1000))).plan, "free");

      // Cancellation: status canceled, plan Free, row kept.
      const cancelSub = subscription({
        id: "sub_cancel",
        status: "canceled",
        cancel_at_period_end: true,
        metadata: { owner_id: "cancel-owner", plan: "pro" }
      });
      const cancelRaw = eventBody("customer.subscription.deleted", cancelSub, { id: "evt_cancel" });
      assert.equal((await webhook(cancelRaw, stripeFetch({ subscription: cancelSub }).fetchImpl)).status, 200);
      assert.equal((await client.query("SELECT status FROM owner_subscriptions WHERE external_id='sub_cancel'")).rows[0].status, "canceled");
      assert.equal((await entitlementsFor("cancel-owner")).plan, "free");
      assert.equal((await client.query("SELECT count(*)::int n FROM owner_subscriptions WHERE external_id='sub_cancel'")).rows[0].n, 1, "expiry keeps the row");

      // Expiry is the same path with a lapsed period, and reports what lapsed.
      const expiryEnd = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
      const expirySub = subscription({
        id: "sub_expiry",
        status: "canceled",
        current_period_end: expiryEnd,
        items: { data: [{ price: { id: ENV.STRIPE_PRICE_PRO }, current_period_end: expiryEnd }] },
        metadata: { owner_id: "expiry-owner", plan: "pro" }
      });
      const expiryRaw = eventBody("customer.subscription.deleted", expirySub, { id: "evt_expiry" });
      assert.equal((await webhook(expiryRaw, stripeFetch({ subscription: expirySub }).fetchImpl)).status, 200);
      const expired = await entitlementsFor("expiry-owner");
      assert.equal(expired.plan, "free");
      assert.equal(expired.expired, true);
      assert.equal(expired.expiredPlan, "pro");

      // Seed the refund owner, then a refund must acknowledge without changing the plan.
      const refundSub = subscription({
        id: "sub_refund",
        metadata: { owner_id: "refund-owner", plan: "pro" }
      });
      const seeded = eventBody("customer.subscription.created", refundSub, { id: "evt_refund_seed" });
      assert.equal((await webhook(seeded, stripeFetch({ subscription: refundSub }).fetchImpl)).status, 200);
      const auditsBefore = (await client.query("SELECT count(*)::int n FROM owner_plan_events WHERE owner_id='refund-owner'")).rows[0].n;
      const refundRaw = eventBody("charge.refunded", { id: "ch_refund", subscription: "sub_refund" }, { id: "evt_refund" });
      const refund = await webhook(refundRaw, stripeFetch({ subscription: refundSub }).fetchImpl);
      assert.equal(refund.status, 200);
      assert.equal((await entitlementsFor("refund-owner")).plan, "pro", "a refund does not cancel the subscription");
      assert.equal((await client.query("SELECT status FROM owner_subscriptions WHERE external_id='sub_refund'")).rows[0].status, "active");
      assert.equal((await client.query("SELECT count(*)::int n FROM owner_plan_events WHERE owner_id='refund-owner'")).rows[0].n, auditsBefore, "a refund with no change adds no audit row");

      // A refund without a subscription is acknowledged and changes nothing.
      const noSubscriptionRefund = eventBody("charge.refunded", { id: "ch_no_sub" }, { id: "evt_refund_no_sub" });
      const noSubResult = await webhook(noSubscriptionRefund, stripeFetch().fetchImpl);
      assert.deepEqual(noSubResult, { status: 200, body: { received: true, handled: false } });
      assert.equal((await client.query("SELECT count(*)::int n FROM billing_events WHERE event_id='evt_refund_no_sub'")).rows[0].n, 0);

      // Bad signature: 400 and nothing written.
      const badRaw = eventBody("invoice.paid", { subscription: "sub_bad" }, { id: "evt_bad_signature" });
      const badFetch = stripeFetch({ subscription: subscription({ id: "sub_bad" }) });
      const bad = await handleStripeWebhook(badRaw, signature(badRaw, "whsec_wrong"), { env: ENV, fetchImpl: badFetch.fetchImpl });
      assert.deepEqual(bad, { status: 400, body: { error: "Invalid signature" } });
      assert.equal(badFetch.calls.length, 0, "a bad signature makes no provider call");
      assert.equal((await client.query("SELECT count(*)::int n FROM billing_events WHERE event_id='evt_bad_signature'")).rows[0].n, 0);
      const noSecret = await handleStripeWebhook(badRaw, signature(badRaw), { env: { ...ENV, STRIPE_WEBHOOK_SECRET: "" }, fetchImpl: badFetch.fetchImpl });
      assert.deepEqual(noSecret, { status: 503, body: { error: "Stripe is not configured" } });
      const noKey = await handleStripeWebhook(badRaw, signature(badRaw), { env: { ...ENV, STRIPE_SECRET_KEY: "" }, fetchImpl: badFetch.fetchImpl });
      assert.deepEqual(noKey, { status: 503, body: { error: "Stripe is not configured" } });

      // Unknown owner: ignored, nothing written, and the still-billable subscription is cancelled.
      const unknownSub = subscription({
        id: "sub_orphan",
        metadata: { owner_id: "deleted-owner", plan: "pro" }
      });
      const orphanFetch = stripeFetch({ subscription: unknownSub });
      const orphanRaw = eventBody("invoice.paid", { subscription: "sub_orphan" }, { id: "evt_orphan" });
      const orphan = await webhook(orphanRaw, orphanFetch.fetchImpl);
      assert.deepEqual(orphan, { status: 200, body: { received: true, ignored: true, cancelled: true } });
      assert.equal(orphanFetch.calls.filter(call => call.method === "DELETE").length, 1, "a late checkout is cancelled at Stripe");
      assert.equal((await client.query("SELECT count(*)::int n FROM billing_events WHERE event_id='evt_orphan'")).rows[0].n, 0);
      assert.equal((await client.query("SELECT count(*)::int n FROM owner_subscriptions WHERE external_id='sub_orphan'")).rows[0].n, 0);

      // A missing subscription is already cancelled as far as the retry is concerned.
      const missingCancelFetch = stripeFetch({
        subscription: unknownSub,
        cancel: () => json({ error: { message: "No such subscription", code: "resource_missing" } }, 404)
      });
      assert.deepEqual(
        await webhook(eventBody("invoice.paid", { subscription: "sub_orphan" }, { id: "evt_orphan_missing" }), missingCancelFetch.fetchImpl),
        { status: 200, body: { received: true, ignored: true, cancelled: true } }
      );

      // An already canceled subscription is not cancelled again.
      const alreadyCanceled = subscription({
        id: "sub_orphan_canceled",
        status: "canceled",
        metadata: { owner_id: "deleted-owner", plan: "pro" }
      });
      const alreadyFetch = stripeFetch({ subscription: alreadyCanceled });
      assert.deepEqual(
        await webhook(eventBody("invoice.paid", { subscription: "sub_orphan_canceled" }, { id: "evt_orphan_canceled" }), alreadyFetch.fetchImpl),
        { status: 200, body: { received: true, ignored: true } }
      );
      assert.equal(alreadyFetch.calls.filter(call => call.method === "DELETE").length, 0);

      // Unknown price and unknown owner: no plan can be resolved, so nothing changes.
      const unknownPrice = subscription({
        id: "sub_unknown_price",
        metadata: { owner_id: "deleted-owner" },
        items: { data: [{ price: { id: "price_unknown" }, current_period_end: Math.floor(Date.now() / 1000) }] }
      });
      const unknownPriceFetch = stripeFetch({ subscription: unknownPrice });
      assert.deepEqual(
        await webhook(eventBody("invoice.paid", { subscription: "sub_unknown_price" }, { id: "evt_unknown_price" }), unknownPriceFetch.fetchImpl),
        { status: 200, body: { received: true, ignored: true } }
      );
      assert.equal(unknownPriceFetch.calls.filter(call => call.method === "DELETE").length, 0);
      assert.equal((await client.query("SELECT count(*)::int n FROM billing_events WHERE event_id='evt_unknown_price'")).rows[0].n, 0);

      // Checkout route: anonymous, no step-up, success, conflict and unconfigured.
      const checkoutRoute = require("../app/api/billing/checkout/route");
      assert.equal((await checkoutRoute.POST(anonymousRequest("/api/billing/checkout", "POST", { plan: "pro" }))).status, 401);

      await client.query("INSERT INTO auth_sessions(token_hash,owner_id,expires,step_up_at) VALUES($1,'route-owner',now()+interval '1 hour',NULL)", [sessionHash("stripe-route-session")]);
      const denied = await checkoutRoute.POST(cookieRequest("/api/billing/checkout", "POST", { plan: "pro" }));
      assert.equal(denied.status, 403);
      assert.deepEqual(await denied.json(), { error: "step_up_required" });
      await client.query("UPDATE auth_sessions SET step_up_at=now() WHERE token_hash=$1", [sessionHash("stripe-route-session")]);

      const routeCheckoutFetch = stripeFetch();
      globalThis.fetch = routeCheckoutFetch.fetchImpl;
      const started = await checkoutRoute.POST(cookieRequest("/api/billing/checkout", "POST", { plan: "pro" }));
      assert.equal(started.status, 200);
      assert.deepEqual(await started.json(), { url: "https://checkout.stripe.test/session" });
      const routeCall = routeCheckoutFetch.calls.find(call => call.url.endsWith("/checkout/sessions"));
      assert.ok(routeCall);
      const routeParams = new URLSearchParams(routeCall.body);
      assert.equal(routeParams.get("line_items[0][price]"), ENV.STRIPE_PRICE_PRO);
      assert.equal(routeParams.get("client_reference_id"), "route-owner");
      assert.equal(routeParams.get("subscription_data[metadata][plan]"), "pro");
      assert.equal(routeParams.get("customer_email"), "route@example.invalid");
      assert.equal(routeParams.get("automatic_tax[enabled]"), "true");
      assert.equal(routeParams.get("success_url"), "http://localhost/account?checkout=success");
      assert.equal(routeParams.get("cancel_url"), "http://localhost/plans?checkout=cancelled");

      await client.query("INSERT INTO owner_subscriptions(owner_id,provider,external_id,plan,status,customer_id) VALUES('route-owner','stripe','sub_route_active','pro','active','cus_route')");
      const conflict = await checkoutRoute.POST(cookieRequest("/api/billing/checkout", "POST", { plan: "pro" }));
      assert.equal(conflict.status, 409);
      assert.deepEqual(await conflict.json(), { error: "subscription_exists" });

      const savedKey = process.env.STRIPE_SECRET_KEY;
      delete process.env.STRIPE_SECRET_KEY;
      const notConfigured = await checkoutRoute.POST(cookieRequest("/api/billing/checkout", "POST", { plan: "pro" }));
      assert.equal(notConfigured.status, 503);
      process.env.STRIPE_SECRET_KEY = savedKey;

      // Without a verified webhook, a checkout would charge and never grant the
      // plan, so it fails closed too.
      const savedWebhook = process.env.STRIPE_WEBHOOK_SECRET;
      delete process.env.STRIPE_WEBHOOK_SECRET;
      const noWebhook = await checkoutRoute.POST(cookieRequest("/api/billing/checkout", "POST", { plan: "pro" }));
      assert.equal(noWebhook.status, 503);
      assert.deepEqual(await noWebhook.json(), { error: "Stripe is not configured" });
      process.env.STRIPE_WEBHOOK_SECRET = savedWebhook;

      const savedPrice = process.env.STRIPE_PRICE_PRO;
      delete process.env.STRIPE_PRICE_PRO;
      const noPrice = await checkoutRoute.POST(cookieRequest("/api/billing/checkout", "POST", { plan: "pro" }));
      assert.equal(noPrice.status, 400);
      assert.deepEqual(await noPrice.json(), { error: "plan_not_available" });
      process.env.STRIPE_PRICE_PRO = savedPrice;

      // Portal route: anonymous, no step-up, no subscription, then the stored customer id.
      const portalRoute = require("../app/api/billing/portal/route");
      assert.equal((await portalRoute.POST(anonymousRequest("/api/billing/portal", "POST", {}))).status, 401);
      await client.query("INSERT INTO auth_sessions(token_hash,owner_id,expires,step_up_at) VALUES($1,'no-price-owner',now()+interval '1 hour',NULL)", [sessionHash("stripe-portal-session")]);
      assert.equal((await portalRoute.POST(cookieRequest("/api/billing/portal", "POST", {}, "stripe-portal-session"))).status, 403);
      await client.query("UPDATE auth_sessions SET step_up_at=now() WHERE token_hash=$1", [sessionHash("stripe-portal-session")]);
      const noSubscription = await portalRoute.POST(cookieRequest("/api/billing/portal", "POST", {}, "stripe-portal-session"));
      assert.equal(noSubscription.status, 400);
      assert.deepEqual(await noSubscription.json(), { error: "no_subscription" });

      await client.query("INSERT INTO owner_subscriptions(owner_id,provider,external_id,plan,status,customer_id) VALUES('no-price-owner','stripe','sub_portal','pro','active','cus_portal')");
      const routePortalFetch = stripeFetch();
      globalThis.fetch = routePortalFetch.fetchImpl;
      const openedPortal = await portalRoute.POST(cookieRequest("/api/billing/portal", "POST", {}, "stripe-portal-session"));
      assert.equal(openedPortal.status, 200);
      assert.deepEqual(await openedPortal.json(), { url: "https://billing.stripe.test/session" });
      const portalCall = routePortalFetch.calls.find(call => call.url.endsWith("/billing_portal/sessions"));
      assert.ok(portalCall);
      const portalBody = new URLSearchParams(portalCall.body);
      assert.equal(portalBody.get("customer"), "cus_portal");
      assert.equal(portalBody.get("return_url"), "http://localhost/account");

      // Account deletion: only the live Stripe row is cancelled, a cancelled row
      // is left alone, and a missing subscription is treated as success on retry.
      await client.query(`INSERT INTO owner_subscriptions(owner_id,provider,external_id,plan,status)
        VALUES('delete-stripe-owner','stripe','sub_delete_active','pro','active'),
              ('delete-stripe-owner','stripe','sub_delete_canceled','pro','canceled')`);
      const deleteFetch = stripeFetch();
      globalThis.fetch = deleteFetch.fetchImpl;
      await cancelOwnerSubscriptions("delete-stripe-owner");
      assert.deepEqual(
        deleteFetch.calls.filter(call => call.method === "DELETE").map(call => new URL(call.url).pathname),
        ["/v1/subscriptions/sub_delete_active"],
        "a cancelled row is not sent to Stripe"
      );
      const missingFetch = stripeFetch({ cancel: () => json({ error: { message: "No such subscription", code: "resource_missing" } }, 404) });
      globalThis.fetch = missingFetch.fetchImpl;
      await billingCanceller({ ...ENV }).cancel("sub_already_gone");
      assert.equal(missingFetch.calls.length, 1, "a missing subscription resolves without throwing");

      const repeatFetch = stripeFetch({ cancel: () => json({ error: { message: "No such subscription", code: "resource_missing" } }, 404) });
      globalThis.fetch = repeatFetch.fetchImpl;
      const repeatCanceller = billingCanceller({ ...ENV });
      await repeatCanceller.cancel("sub_delete_active");
      await repeatCanceller.cancel("sub_delete_active");
      assert.equal(repeatFetch.calls.length, 2, "a repeat cancel after a partial failure succeeds");

      // The webhook is public by design and covered by the authorization allow-list.
      const authorizationTest = readFileSync(join(__dirname, "test-authorization.ts"), "utf8");
      assert.match(authorizationTest, /app\/api\/billing\/webhook\/route\.ts/, "the Stripe webhook must be allow-listed as public");
    });
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  console.log("Stripe signatures, gateway, webhook fixtures and billing routes passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
