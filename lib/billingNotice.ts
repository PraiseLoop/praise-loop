import { planName } from "./planDisplay";
import type { Plan } from "./services/entitlements";

// The checkout redirect carries only a result, never the plan: the server's
// entitlements read decides whether the upgrade really landed (#249). Keeping
// the decision here lets the page show one settled notice and the tests cover
// every state without a React renderer.

/** Reloads after a Stripe redirect, while the webhook catches up. */
export const CHECKOUT_RELOAD_DELAYS_MS = [1500, 4000, 8000] as const;
/** Extra wait after the last reload so its response can land before giving up. */
export const CHECKOUT_SETTLE_GRACE_MS = 2000;

export type BillingNoticeKind = "active" | "confirming" | "delayed" | "cancelled";
export type BillingNotice = {
  kind: BillingNoticeKind;
  message: string;
  /** True once the notice is final and the URL can drop `checkout`. */
  final: boolean;
};

export const checkoutConfirmingNotice = "Thanks — we’re confirming your subscription. This can take a moment.";
export const checkoutDelayedNotice = "This is taking longer than usual. Refresh in a minute, and contact us if your plan does not change.";
export const checkoutCancelledNotice = "Checkout cancelled. You haven’t been charged.";

export const checkoutActiveNotice = (plan: Plan) => `Your ${planName(plan)} plan is active.`;

/**
 * Decides the billing notice from what the URL asked for, the plan the server
 * just returned, and how many reloads have finished. A paid plan always wins
 * over "success"; a free plan only says "confirming" while the bounded reloads
 * run, then stops with a calm message. Anything other than a checkout result
 * (including a later downgrade with the query already cleared) shows nothing.
 */
export function billingNotice(input: {
  result: "success" | "cancelled" | null;
  plan: Plan;
  attempts: number;
}): BillingNotice | null {
  if (input.result === "cancelled") {
    return { kind: "cancelled", message: checkoutCancelledNotice, final: true };
  }
  if (input.result !== "success") return null;
  if (input.plan !== "free") {
    return { kind: "active", message: checkoutActiveNotice(input.plan), final: true };
  }
  if (input.attempts >= CHECKOUT_RELOAD_DELAYS_MS.length) {
    return { kind: "delayed", message: checkoutDelayedNotice, final: true };
  }
  return { kind: "confirming", message: checkoutConfirmingNotice, final: false };
}
