"use client";
import { useId, useState } from "react";
import { apiFetch } from "../apiFetch";

// Reusable fresh-code check for a sensitive step (#221). It sends a code to the
// signed-in owner's own address and reports when that code is accepted.
// BillingActions mounts it before checkout or the billing portal (#223). It never
// shows or stores the address or the code.
export default function StepUpCodeForm({ onVerified, title = "Confirm it’s you" }: { onVerified?: () => void; title?: string }) {
  const [stage, setStage] = useState<"idle" | "sent" | "verified">("idle");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const headingId = useId();
  const inputId = useId();

  async function send() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await apiFetch("/api/account/step-up/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });
      if (response.status === 403) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        if (body.error === "sign_in_again") {
          setMessage("This session is too old to confirm. Sign out and sign in again.");
          return;
        }
      }
      if (!response.ok) {
        setMessage("Could not send a code. Try again.");
        return;
      }
      const body = await response.json() as { method?: string };
      if (body.method === "recent_sign_in") {
        setStage("verified");
        onVerified?.();
        return;
      }
      setStage("sent");
      setMessage("We sent a code to the address on your account.");
    } catch {
      setMessage("Could not send a code. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const response = await apiFetch("/api/account/step-up/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.trim() })
      });
      if (response.ok) {
        setStage("verified");
        setCode("");
        onVerified?.();
        return;
      }
      if (response.status === 403) {
        setMessage("This session is too old to confirm. Sign out and sign in again.");
        return;
      }
      setMessage("That code is invalid or has expired.");
    } catch {
      setMessage("That code is invalid or has expired.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="pl-step-up" aria-labelledby={headingId}>
      <h2 id={headingId} className="pl-h2">{title}</h2>
      {stage === "verified" ? (
        <p className="pl-small" role="status">Confirmed.</p>
      ) : stage === "idle" ? (
        <button type="button" className="pl-btn pl-btn-primary" onClick={send} disabled={busy}>
          {busy ? "Sending…" : "Send code"}
        </button>
      ) : (
        <form className="pl-profile-form" onSubmit={verify}>
          <label className="pl-field" htmlFor={inputId}>Code
            <input
              id={inputId}
              className="pl-input"
              value={code}
              onChange={event => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              autoFocus
            />
          </label>
          <div className="pl-profile-form-actions">
            <button type="submit" className="pl-btn pl-btn-primary" disabled={busy || code.length !== 6}>
              {busy ? "Checking…" : "Confirm"}
            </button>
            <button type="button" className="pl-btn" onClick={send} disabled={busy}>Send a new code</button>
          </div>
        </form>
      )}
      {message ? <p className={stage === "verified" ? "pl-small" : "pl-small pl-muted"} role="status">{message}</p> : null}
    </section>
  );
}
