"use client";
import { useEffect, useState } from "react";
import type { Plan, PlanSource } from "../../lib/services/entitlements";
import {
  CHECKOUT_RELOAD_DELAYS_MS,
  CHECKOUT_SETTLE_GRACE_MS,
  billingNotice,
  type BillingNotice
} from "../../lib/billingNotice";
import { apiFetch } from "../apiFetch";
import StepUpCodeForm from "../ui/StepUpCodeForm";

// Billing controls on /account (#223). Starting a checkout or opening the Stripe
// portal always passes through StepUpCodeForm first. The success redirect grants
// nothing: this only reloads the server's plan while the webhook catches up. The
// notice follows the plan the server returns, not the query string (#249), and a
// settled notice is removed from the URL so a reload cannot bring it back.
export default function BillingActions({ plan, source, onReload }: {
  plan: Plan;
  source: PlanSource;
  onReload?: () => void;
}) {
  const [intent, setIntent] = useState<"checkout" | "portal" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<"success" | "cancelled" | null>(null);
  const [checkoutRead, setCheckoutRead] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [settledNotice, setSettledNotice] = useState<BillingNotice | null>(null);

  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get("checkout");
    setCheckout(result === "success" || result === "cancelled" ? result : null);
    setCheckoutRead(true);
  }, []);

  useEffect(() => {
    if (checkout !== "success" || settledNotice) return;
    // The webhook may land after the redirect. Reload a few times, but never
    // change the plan here: only the server's next read decides it. The final
    // pause lets the last response land before "taking longer" is shown.
    const timers = CHECKOUT_RELOAD_DELAYS_MS.map((ms, index) => window.setTimeout(() => {
      onReload?.();
      if (index < CHECKOUT_RELOAD_DELAYS_MS.length - 1) setAttempts(index + 1);
    }, ms));
    const last = CHECKOUT_RELOAD_DELAYS_MS[CHECKOUT_RELOAD_DELAYS_MS.length - 1];
    const settled = window.setTimeout(() => setAttempts(CHECKOUT_RELOAD_DELAYS_MS.length), last + CHECKOUT_SETTLE_GRACE_MS);
    return () => [...timers, settled].forEach(timer => window.clearTimeout(timer));
  }, [checkout, settledNotice, onReload]);

  const notice = settledNotice ?? (checkoutRead ? billingNotice({ result: checkout, plan, attempts }) : null);

  useEffect(() => {
    if (!notice?.final) return;
    setSettledNotice(notice);
    setCheckout(null);
    const url = new URL(window.location.href);
    if (!url.searchParams.has("checkout")) return;
    url.searchParams.delete("checkout");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [notice]);

  useEffect(() => {
    if (!settledNotice) return;
    // A downgrade after the success line must not turn back into "confirming".
    if (settledNotice.kind === "active" && plan === "free") {
      setSettledNotice(null);
      return;
    }
    // If the delayed notice was shown just before the last reload landed, the
    // paid plan that arrived afterwards still wins.
    if (settledNotice.kind === "delayed" && plan !== "free") {
      setSettledNotice(billingNotice({ result: "success", plan, attempts: 0 }));
    }
  }, [plan, settledNotice]);

  const action: "checkout" | "portal" | null = source === "stripe" ? "portal" : plan === "free" ? "checkout" : null;
  // While the checkout result is being confirmed, an Upgrade button would invite
  // a second checkout and look like part of the same notice. Wait for the plan.
  const showAction = checkoutRead && action !== null && notice?.kind !== "confirming" && notice?.kind !== "delayed";

  async function start(which: "checkout" | "portal") {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/billing/${which}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(which === "checkout" ? { plan: "pro" } : {})
      });
      const data = await response.json().catch(() => ({})) as { url?: string; error?: string };
      if (response.status === 403 && data.error === "step_up_required") {
        setIntent(null);
        setError("Please confirm it’s you again.");
        return;
      }
      if (response.status === 409 && data.error === "subscription_exists") {
        setIntent(null);
        setError("You already have a subscription. Use Manage subscription to change it.");
        onReload?.();
        return;
      }
      if (response.status === 503) {
        setIntent(null);
        setError("Billing is not available right now. Try again later.");
        return;
      }
      if (!response.ok || !data.url) {
        setIntent(null);
        setError("We couldn’t start billing. Try again.");
        return;
      }
      window.location.assign(data.url);
    } catch {
      setIntent(null);
      setError("We couldn’t reach billing. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!notice && !action) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {notice ? <p role="status" className="pl-small" style={{ margin: 0, fontWeight: 600 }}>{notice.message}</p> : null}
      {action && showAction ? (
        intent ? (
          <StepUpCodeForm title="Confirm it’s you" onVerified={() => void start(action)} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div>
              <button type="button" className="pl-btn pl-btn-primary" disabled={busy} onClick={() => { setIntent(action); setError(null); }}>
                {action === "checkout" ? "Upgrade to Pro" : "Manage subscription"}
              </button>
            </div>
            <span className="pl-small pl-muted">
              {action === "checkout"
                ? "You’ll confirm it’s you, then pay by card on Stripe."
                : "Opens Stripe’s billing portal to change your card or cancel."}
            </span>
          </div>
        )
      ) : null}
      {error ? <p role="alert" className="pl-small" style={{ margin: 0, color: "#A3361F", fontWeight: 600 }}>{error}</p> : null}
    </div>
  );
}
