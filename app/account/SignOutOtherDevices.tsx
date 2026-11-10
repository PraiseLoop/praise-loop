"use client";
import { useState } from "react";
import { apiFetch } from "../apiFetch";
import StepUpCodeForm from "../ui/StepUpCodeForm";

// "Sign out of all other devices" (#285). The server deletes every other web and
// phone session for the owner and keeps this one. A borrowed browser must pass
// the same fresh step-up code as billing changes (#221), so confirming here is
// the only way the action runs.
export default function SignOutOtherDevices() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function signOutOthers() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch("/api/account/sessions", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });
      const data = await response.json().catch(() => null) as { ok?: boolean; revoked?: number; error?: string } | null;
      if (response.status === 403 && data?.error === "step_up_required") {
        setConfirming(true);
        setError("Please confirm it’s you again.");
        return;
      }
      if (!response.ok || typeof data?.revoked !== "number") {
        setError(data?.error ?? "We couldn’t sign out your other devices. Try again.");
        return;
      }
      setConfirming(false);
      const revoked = data.revoked;
      setMessage(`Signed out ${revoked} other ${revoked === 1 ? "session" : "sessions"}.`);
    } catch {
      setError("We couldn’t sign out your other devices. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {confirming ? (
        <StepUpCodeForm title="Confirm it’s you" onVerified={() => void signOutOthers()} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div>
            <button
              type="button"
              className="pl-btn"
              disabled={busy}
              onClick={() => { setConfirming(true); setError(null); setMessage(null); }}
            >
              {busy ? "Signing out…" : "Sign out of all other devices"}
            </button>
          </div>
          <span className="pl-small pl-muted">You’ll confirm it’s you with a code first.</span>
        </div>
      )}
      {message ? <p role="status" className="pl-small" style={{ margin: 0, fontWeight: 600 }}>{message}</p> : null}
      {error ? <p role="alert" className="pl-small" style={{ margin: 0, color: "#A3361F", fontWeight: 600 }}>{error}</p> : null}
    </div>
  );
}
