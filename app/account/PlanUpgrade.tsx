"use client";
import { useEffect, useState } from "react";
import type { Plan } from "../../lib/services/entitlements";
import { apiFetch } from "../apiFetch";

// The pilot self-service upgrade. The server decides who may use it from
// SELF_SERVICE_UPGRADE_EMAILS; this only asks whether to show the button.
export default function PlanUpgrade({ plan, onUpgraded }: { plan: Plan; onUpgraded: () => void }) {
  const [eligible, setEligible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (plan !== "free") { setEligible(false); return; }
    let current = true;
    apiFetch("/api/plan/upgrade")
      .then(async response => response.ok ? (await response.json() as { eligible?: boolean }).eligible === true : false)
      .catch(() => false)
      .then(value => { if (current) setEligible(value); });
    return () => { current = false; };
  }, [plan]);

  async function upgrade() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch("/api/plan/upgrade", { method: "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        setError(body?.error ?? "We couldn’t upgrade your account. Try again.");
        return;
      }
      onUpgraded();
    } catch {
      setError("We couldn’t upgrade your account. Check your connection and try again.");
    } finally {
      // The button can't stay stuck on "Upgrading…" if the plan reload fails; a repeat is a no-op.
      setBusy(false);
    }
  }

  if (plan !== "free" || !eligible) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div>
        <button type="button" className="pl-btn pl-btn-primary" disabled={busy} onClick={() => void upgrade()}>
          {busy ? "Upgrading…" : "Upgrade to Pro"}
        </button>
      </div>
      <span className="pl-small pl-muted">Pilot self-service upgrade. No payment is taken.</span>
      {error ? <span role="alert" className="pl-small" style={{ color: "#A3361F", fontWeight: 600 }}>{error}</span> : null}
    </div>
  );
}
