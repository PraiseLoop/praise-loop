"use client";
import { useEffect, useState } from "react";
import type { Plan, PlanSource } from "../../lib/services/entitlements";
import { apiFetch } from "../apiFetch";
import StepUpCodeForm from "../ui/StepUpCodeForm";

// Billing controls on /account (#223). Starting a checkout or opening the Stripe
// portal always passes through StepUpCodeForm first. The success redirect grants
// nothing: this only reloads the server's plan while the webhook catches up.
export default function BillingActions({ plan, source, onReload }: {
  plan: Plan;
  source: PlanSource;
  onReload?: () => void;
}) {
  const [intent, setIntent] = useState<"checkout" | "portal" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get("checkout");
    if (result === "success") {
      setNotice("Thanks — we’re confirming your subscription. This can take a moment.");
      // The webhook may land after the redirect. Reload a few times, but never
      // change the plan here: only the server's next read decides it.
      const timers = [1500, 4000, 8000].map(ms => window.setTimeout(() => onReload?.(), ms));
      return () => timers.forEach(timer => window.clearTimeout(timer));
    }
    if (result === "cancelled") setNotice("Checkout cancelled. You haven’t been charged.");
  }, [onReload]);

  const action: "checkout" | "portal" | null = source === "stripe" ? "portal" : plan === "free" ? "checkout" : null;

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
      {notice ? <p role="status" className="pl-small" style={{ margin: 0, fontWeight: 600 }}>{notice}</p> : null}
      {action ? (
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
