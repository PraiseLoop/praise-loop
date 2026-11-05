import assert from "node:assert/strict";
import { CHECKOUT_RELOAD_DELAYS_MS, billingNotice, checkoutActiveNotice } from "../lib/billingNotice";

// The /account billing notice is decided from the checkout result, the plan the
// server returned and the number of finished reloads (#249). Synthetic only.

// No checkout redirect: nothing to say, including after the query was cleared.
assert.equal(billingNotice({ result: null, plan: "free", attempts: 0 }), null);
assert.equal(billingNotice({ result: null, plan: "pro", attempts: CHECKOUT_RELOAD_DELAYS_MS.length }), null);

// A fresh success redirect on a free plan says it is confirming while reloads run.
assert.deepEqual(billingNotice({ result: "success", plan: "free", attempts: 0 }), {
  kind: "confirming",
  message: "Thanks — we’re confirming your subscription. This can take a moment.",
  final: false
});
assert.deepEqual(billingNotice({ result: "success", plan: "free", attempts: CHECKOUT_RELOAD_DELAYS_MS.length - 1 }), {
  kind: "confirming",
  message: "Thanks — we’re confirming your subscription. This can take a moment.",
  final: false
});

// Once the last reload has finished and the plan is still Free, stop waiting.
assert.deepEqual(billingNotice({ result: "success", plan: "free", attempts: CHECKOUT_RELOAD_DELAYS_MS.length }), {
  kind: "delayed",
  message: "This is taking longer than usual. Refresh in a minute, and contact us if your plan does not change.",
  final: true
});

// If the server already reports a paid plan, the redirect is a success line.
assert.deepEqual(billingNotice({ result: "success", plan: "pro", attempts: 0 }), {
  kind: "active",
  message: checkoutActiveNotice("pro"),
  final: true
});
assert.equal(checkoutActiveNotice("pro"), "Your Pro plan is active.");
assert.equal(checkoutActiveNotice("business"), "Your Business plan is active.");
assert.equal(billingNotice({ result: "success", plan: "pro", attempts: 0 })?.kind, "active", "a paid plan wins over the free-path attempts");

// A cancelled checkout keeps its own line and is final immediately.
assert.deepEqual(billingNotice({ result: "cancelled", plan: "free", attempts: 0 }), {
  kind: "cancelled",
  message: "Checkout cancelled. You haven’t been charged.",
  final: true
});

// After a paid success the query is cleared, so a later downgrade has no
// checkout result to act on and must never say "confirming".
assert.equal(billingNotice({ result: null, plan: "free", attempts: 0 }), null);
assert.equal(billingNotice({ result: "cancelled", plan: "free", attempts: 0 })?.kind, "cancelled", "a cancellation never confirms");

console.log("billing notice decisions passed");
