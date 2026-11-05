import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { databaseFixture } from "./db-fixture";
import { billingProvider, fakeBillingProvider } from "../lib/integrations/billing";
import { entitlementsFor, setOwnerPlan } from "../lib/services/entitlements";
import {
  PAST_DUE_GRACE_PERIOD_MS,
  applyBillingEvent,
  sourceForProvider,
  subscriptionIsActive
} from "../lib/services/subscriptions";

const HOUR = 60 * 60 * 1000;

function request(body: unknown) {
  return new NextRequest("http://localhost/api/dev/billing", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function main() {
  // Statuses that grant a plan, with the past_due grace period.
  const now = new Date("2026-11-04T12:00:00Z");
  assert.equal(subscriptionIsActive("active", new Date("2026-12-04T00:00:00Z"), now), true);
  assert.equal(subscriptionIsActive("active", new Date("2026-10-01T00:00:00Z"), now), false, "an active subscription past its paid period lapses");
  assert.equal(subscriptionIsActive("trialing", null, now), true, "a trial without a period end is active");
  assert.equal(subscriptionIsActive("past_due", new Date(now.getTime() - PAST_DUE_GRACE_PERIOD_MS + 1000), now), true, "past_due keeps the plan inside the grace period");
  assert.equal(subscriptionIsActive("past_due", new Date(now.getTime() - PAST_DUE_GRACE_PERIOD_MS - 1000), now), false, "past_due lapses after the grace period");
  assert.equal(subscriptionIsActive("canceled", new Date("2026-12-04T00:00:00Z"), now), false);
  assert.equal(subscriptionIsActive("unpaid", new Date("2026-12-04T00:00:00Z"), now), false);
  assert.equal(sourceForProvider("stripe"), "stripe");
  assert.equal(sourceForProvider("store"), "store");
  assert.equal(sourceForProvider("fake"), "stripe", "the fake stands in for the web subscription source");

  // The fake adapter is selected by config and refused by a production process.
  assert.throws(() => billingProvider({ BILLING_PROVIDER: "fake", NODE_ENV: "production" }), /not available in production/);
  assert.equal(billingProvider({ BILLING_PROVIDER: "fake", NODE_ENV: "development" }).name, "fake");
  assert.throws(() => billingProvider({}), /No billing provider is configured/);
  const saved = { BILLING_PROVIDER: process.env.BILLING_PROVIDER, NODE_ENV: process.env.NODE_ENV, MOBILE_DEV_AUTH: process.env.MOBILE_DEV_AUTH };
  process.env.BILLING_PROVIDER = "fake";
  (process.env as Record<string, string>).NODE_ENV = "test";

  try {
    const checkout = await fakeBillingProvider.checkout({ ownerId: "synthetic-owner", plan: "pro", now });
    assert.equal(checkout.provider, "fake");
    assert.match(checkout.externalId, /^fake_sub_/);
    assert.equal(checkout.status, "active");
    // The cancel call is immediate and a second call for the same id is a no-op.
    await fakeBillingProvider.cancel(checkout.externalId);
    await fakeBillingProvider.cancel(checkout.externalId);

    await databaseFixture(async client => {
      await client.query(`INSERT INTO auth_users(id,email) VALUES
        ('sub-owner','sub@example.invalid'),('manual-owner','manual@example.invalid'),
        ('expired-manual-owner','expired-manual@example.invalid'),('grace-owner','grace@example.invalid')`);

      const base = new Date();
      const at = (hours: number) => new Date(base.getTime() + hours * HOUR);

      // Checkout records the event, upserts the subscription and appends the audit
      // row together. It never creates or changes the manual owner_plans row.
      const started = await fakeBillingProvider.checkout({ ownerId: "sub-owner", plan: "pro", now: at(-3) });
      assert.deepEqual(await applyBillingEvent(started), { applied: true, duplicate: false, stale: false, ignored: false });
      let subEntitlements = await entitlementsFor("sub-owner");
      assert.equal(subEntitlements.plan, "pro");
      assert.equal(subEntitlements.source, "stripe", "the reported source is the winning subscription");
      assert.equal(subEntitlements.expired, false);
      assert.deepEqual((await client.query("SELECT plan,status,external_id FROM owner_subscriptions WHERE owner_id='sub-owner'")).rows, [
        { plan: "pro", status: "active", external_id: started.externalId }
      ]);
      assert.equal((await client.query("SELECT count(*)::int n FROM billing_events WHERE owner_id='sub-owner'")).rows[0].n, 1);
      assert.equal((await client.query("SELECT count(*)::int n FROM owner_plan_events WHERE owner_id='sub-owner'")).rows[0].n, 1);
      assert.equal((await client.query("SELECT count(*)::int n FROM owner_plans WHERE owner_id='sub-owner'")).rows[0].n, 0, "a webhook never writes owner_plans");

      // A duplicate provider event id is recorded once and changes nothing.
      assert.deepEqual(await applyBillingEvent(started), { applied: false, duplicate: true, stale: false, ignored: false });
      assert.equal((await client.query("SELECT count(*)::int n FROM billing_events WHERE owner_id='sub-owner'")).rows[0].n, 1);
      assert.equal((await client.query("SELECT count(*)::int n FROM owner_plan_events WHERE owner_id='sub-owner'")).rows[0].n, 1);
      assert.equal((await client.query("SELECT status FROM owner_subscriptions WHERE owner_id='sub-owner'")).rows[0].status, "active");

      // A later event for an older period is recorded but does not overwrite newer state.
      const renewed = await fakeBillingProvider.renew({ ownerId: "sub-owner", externalId: started.externalId, plan: "pro", now: at(-1) });
      assert.deepEqual(await applyBillingEvent(renewed), { applied: true, duplicate: false, stale: false, ignored: false });
      const lateCancel = await fakeBillingProvider.cancelEvent({ ownerId: "sub-owner", externalId: started.externalId, plan: "pro", now: at(-2) });
      assert.deepEqual(await applyBillingEvent(lateCancel), { applied: false, duplicate: false, stale: true, ignored: false });
      assert.equal((await client.query("SELECT status FROM owner_subscriptions WHERE owner_id='sub-owner'")).rows[0].status, "active");
      assert.equal((await entitlementsFor("sub-owner")).plan, "pro", "a late cancellation does not undo a renewal");
      assert.equal((await client.query("SELECT count(*)::int n FROM billing_events WHERE owner_id='sub-owner'")).rows[0].n, 3, "even a stale event is recorded");
      assert.equal((await client.query("SELECT count(*)::int n FROM owner_plan_events WHERE owner_id='sub-owner'")).rows[0].n, 2, "only the applied changes are audited");

      // A cancellation gives up the subscription but keeps its row; expiry reads Free.
      const cancellation = await fakeBillingProvider.cancelEvent({ ownerId: "sub-owner", externalId: started.externalId, plan: "pro", now: at(1) });
      assert.deepEqual(await applyBillingEvent(cancellation), { applied: true, duplicate: false, stale: false, ignored: false });
      subEntitlements = await entitlementsFor("sub-owner", undefined, at(2));
      assert.equal(subEntitlements.plan, "free");
      assert.equal(subEntitlements.expired, true);
      assert.equal(subEntitlements.expiredPlan, "pro");
      assert.equal((await client.query("SELECT status FROM owner_subscriptions WHERE owner_id='sub-owner'")).rows[0].status, "canceled", "expiry keeps the subscription row");
      assert.equal((await client.query("SELECT count(*)::int n FROM billing_events WHERE owner_id='sub-owner'")).rows[0].n, 4);

      // A manual Pro grant survives a subscription that lapses underneath it.
      await setOwnerPlan("manual-owner", "pro", { reason: "Synthetic manual grant" });
      const manualCheckout = await fakeBillingProvider.checkout({ ownerId: "manual-owner", plan: "business", now: at(-2) });
      await applyBillingEvent(manualCheckout);
      assert.equal((await entitlementsFor("manual-owner")).plan, "business", "the higher subscription wins while active");
      const manualCancel = await fakeBillingProvider.cancelEvent({ ownerId: "manual-owner", externalId: manualCheckout.externalId, plan: "business", now: at(1) });
      await applyBillingEvent(manualCancel);
      const kept = await entitlementsFor("manual-owner", undefined, at(2));
      assert.equal(kept.plan, "pro");
      assert.equal(kept.source, "manual", "the winning grant supplies the source");
      assert.equal((await client.query("SELECT plan FROM owner_plans WHERE owner_id='manual-owner'")).rows[0].plan, "pro", "the manual grant is untouched");
      assert.equal((await client.query("SELECT status FROM owner_subscriptions WHERE owner_id='manual-owner'")).rows[0].status, "canceled");

      // The reverse: an expired manual Pro does not hide an active Business subscription.
      await setOwnerPlan("expired-manual-owner", "pro", { expiresAt: "2020-01-01T00:00:00Z", reason: "Synthetic expired grant" });
      const businessCheckout = await fakeBillingProvider.checkout({ ownerId: "expired-manual-owner", plan: "business", now: at(-1) });
      await applyBillingEvent(businessCheckout);
      const business = await entitlementsFor("expired-manual-owner");
      assert.equal(business.plan, "business");
      assert.equal(business.source, "stripe");
      assert.equal(business.expired, false, "an active grant is not reported as an expired plan");
      assert.equal((await client.query("SELECT plan FROM owner_plans WHERE owner_id='expired-manual-owner'")).rows[0].plan, "pro", "the expired manual row is kept for a later renewal");

      // past_due keeps the plan through the grace period, then falls back to Free
      // without deleting the subscription.
      const graceCheckout = await fakeBillingProvider.checkout({ ownerId: "grace-owner", plan: "pro", now: at(-2) });
      await applyBillingEvent(graceCheckout);
      const failed = await fakeBillingProvider.failPayment({ ownerId: "grace-owner", externalId: graceCheckout.externalId, plan: "pro", now: at(0) });
      await applyBillingEvent(failed);
      assert.equal((await entitlementsFor("grace-owner", undefined, at(0))).plan, "pro", "past_due is still active inside the grace period");
      const afterGrace = new Date(at(0).getTime() + PAST_DUE_GRACE_PERIOD_MS + 1000);
      assert.equal((await entitlementsFor("grace-owner", undefined, afterGrace)).plan, "free");
      assert.equal((await client.query("SELECT status FROM owner_subscriptions WHERE owner_id='grace-owner'")).rows[0].status, "past_due");
      assert.equal((await client.query("SELECT count(*)::int n FROM owner_subscriptions WHERE owner_id='grace-owner'")).rows[0].n, 1, "expiry keeps subscription data");

      // A subscription that doesn't grant a plan must never read as paid, whatever its
      // dates say: a failed first payment or an immediate cancellation has a future period end.
      await client.query(`INSERT INTO auth_users(id,email) VALUES
        ('never-paid-owner','never-paid@example.invalid'),('canceled-now-owner','canceled-now@example.invalid'),
        ('no-end-owner','no-end@example.invalid'),('thief-owner','thief@example.invalid')`);
      const denied = (ownerId: string, status: string, currentPeriodEnd: Date | null) => applyBillingEvent({
        provider: "fake", eventId: `denied-${ownerId}`, type: "synthetic", ownerId, externalId: `denied-sub-${ownerId}`,
        plan: "business", status, currentPeriodEnd, occurredAt: at(0)
      });
      await denied("never-paid-owner", "incomplete", at(24 * 30));
      const neverPaid = await entitlementsFor("never-paid-owner");
      assert.equal(neverPaid.plan, "free", "a failed first payment unlocks nothing");
      assert.equal(neverPaid.limits.businesses, 1);
      assert.equal(neverPaid.expired, false, "a plan that never started did not expire");
      await denied("canceled-now-owner", "canceled", at(24 * 20));
      const canceledNow = await entitlementsFor("canceled-now-owner");
      assert.equal(canceledNow.plan, "free", "an immediate cancellation ends the plan even with time left in the period");
      assert.equal(canceledNow.expired, false, "there is no past date to report as expired");
      await denied("no-end-owner", "unpaid", null);
      assert.equal((await entitlementsFor("no-end-owner")).plan, "free", "a dead subscription with no date is not open-ended");

      // A provider event can't move an existing subscription to another owner.
      await assert.rejects(
        () => applyBillingEvent({
          provider: "fake", eventId: "steal-1", type: "synthetic", ownerId: "thief-owner", externalId: started.externalId,
          plan: "business", status: "active", currentPeriodEnd: at(24 * 30), occurredAt: at(5)
        }),
        /another owner/
      );
      assert.equal((await client.query("SELECT owner_id FROM owner_subscriptions WHERE external_id=$1", [started.externalId])).rows[0].owner_id, "sub-owner");
      assert.equal((await entitlementsFor("thief-owner")).plan, "free");
      assert.equal((await client.query("SELECT count(*)::int n FROM billing_events WHERE event_id='steal-1'")).rows[0].n, 0, "a refused event isn't recorded as handled");

      // A provider can deliver an event after the owner deleted their account.
      // It is acknowledged and recorded nowhere, and no subscription is recreated.
      await client.query("INSERT INTO auth_users(id,email) VALUES('late-owner','late@example.invalid')");
      const lateCheckout = await fakeBillingProvider.checkout({ ownerId: "late-owner", plan: "pro", now: at(-1) });
      await applyBillingEvent(lateCheckout);
      await client.query("DELETE FROM auth_users WHERE id='late-owner'");
      const late = await applyBillingEvent({
        provider: "fake", eventId: "late-after-delete", type: "subscription.renewed", ownerId: "late-owner",
        externalId: lateCheckout.externalId, plan: "pro", status: "active", currentPeriodEnd: at(24 * 30), occurredAt: at(1)
      });
      assert.deepEqual(late, { applied: false, duplicate: false, stale: false, ignored: true });
      assert.equal((await client.query("SELECT count(*)::int n FROM billing_events WHERE event_id='late-after-delete'")).rows[0].n, 0, "a late event is not recorded");
      assert.equal((await client.query("SELECT count(*)::int n FROM owner_subscriptions WHERE owner_id='late-owner'")).rows[0].n, 0, "a late event recreates no subscription");
      assert.equal((await client.query("SELECT count(*)::int n FROM owner_plan_events WHERE owner_id='late-owner'")).rows[0].n, 0, "a late event records no plan change");

      // A local owner can walk checkout, renewal, failed payment and cancellation
      // through the dev route; it uses the same apply path as a real webhook.
      process.env.MOBILE_DEV_AUTH = "1";
      const route = require("../app/api/dev/billing/route");
      const walk = async (body: Record<string, unknown>) => {
        const response = await route.POST(request(body));
        return { status: response.status, body: await response.json() };
      };
      const opened = await walk({ action: "checkout", owner: "pro", plan: "business" });
      assert.equal(opened.status, 200);
      assert.equal(opened.body.applied, true);
      assert.equal(opened.body.status, "active");
      const externalId = opened.body.externalId as string;
      assert.equal((await entitlementsFor("dev-owner")).plan, "business");

      const renewedByRoute = await walk({ action: "renew", owner: "pro", externalId });
      assert.equal(renewedByRoute.status, 200);
      assert.equal(renewedByRoute.body.status, "active");
      const failedByRoute = await walk({ action: "fail", owner: "pro", externalId });
      assert.equal(failedByRoute.status, 200);
      assert.equal(failedByRoute.body.status, "past_due");
      assert.equal((await entitlementsFor("dev-owner")).plan, "business", "the fake checkout plan stays active during grace");

      const cancelledByRoute = await walk({ action: "cancel", owner: "pro", externalId });
      assert.equal(cancelledByRoute.status, 200);
      assert.equal(cancelledByRoute.body.status, "canceled");
      assert.equal((await entitlementsFor("dev-owner")).plan, "free");

      delete process.env.MOBILE_DEV_AUTH;
      assert.equal((await walk({ action: "checkout", owner: "pro", plan: "pro" })).status, 404, "the fake checkout route is missing without MOBILE_DEV_AUTH");
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  console.log("subscription events, highest-plan resolution and fake billing tests passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
