"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiFetch } from "../apiFetch";

// Change password (#159). The current password is required even though the page
// is signed in. A successful change deletes the owner's other web and phone
// sessions, so this tab stays signed in and every other device must sign in again.
export default function PasswordForm() {
  const [loaded, setLoaded] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await apiFetch("/api/account/password");
      if (!response.ok) { setLoadError("We couldn’t load your password settings."); return; }
      const data = await response.json() as { hasPassword?: boolean };
      setHasPassword(!!data.hasPassword);
      setLoadError(null);
    } catch {
      setLoadError("We couldn’t load your password settings.");
    } finally {
      setLoaded(true);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  function problem(value: string) {
    const length = Array.from(value).length;
    return length < 12 ? "Use at least 12 characters." : length > 256 ? "Use at most 256 characters." : null;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const rule = problem(next);
    if (rule) { setError(rule); return; }
    if (next !== confirm) { setError("The two new passwords do not match."); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      const response = await apiFetch("/api/account/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next })
      });
      const data = await response.json().catch(() => null) as { error?: unknown; revoked?: unknown } | null;
      if (!response.ok) {
        setError(typeof data?.error === "string" ? data.error : "We couldn’t change your password.");
        return;
      }
      const revoked = typeof data?.revoked === "number" ? data.revoked : 0;
      setCurrent(""); setNext(""); setConfirm("");
      setNotice(revoked > 0
        ? `Password changed. ${revoked} other ${revoked === 1 ? "session was" : "sessions were"} signed out.`
        : "Password changed.");
    } catch {
      setError("We couldn’t change your password. Check your connection and try again.");
    } finally { setBusy(false); }
  }

  return (
    <section aria-labelledby="password-h" className="pl-panel" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h2 id="password-h" className="pl-h2">Password</h2>
      {!loaded ? <p className="pl-muted" role="status">Loading your password settings…</p> : loadError ? (
        <p role="alert" className="pl-banner" style={{ margin: 0 }}>{loadError} <button type="button" className="pl-link-button" onClick={() => { setLoadError(null); void load(); }}>Try again</button></p>
      ) : !hasPassword ? (
        <p className="pl-muted" style={{ margin: 0 }}>
          This account does not have a password yet. You can sign in with your email code, Google or Microsoft.
        </p>
      ) : (
        <>
          <p className="pl-muted" style={{ margin: 0 }}>
            Changing it signs out your other web and phone sessions. This browser stays signed in.
          </p>
          <form onSubmit={submit} noValidate style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label className="pl-field">
              Current password
              <input className="pl-input" type="password" name="current-password" autoComplete="current-password" required value={current} onChange={event => setCurrent(event.target.value)} />
            </label>
            <label className="pl-field">
              New password
              <input className="pl-input" type="password" name="new-password" autoComplete="new-password" required minLength={12} value={next} onChange={event => setNext(event.target.value)} />
            </label>
            <label className="pl-field">
              Confirm new password
              <input className="pl-input" type="password" name="confirm-password" autoComplete="new-password" required minLength={12} value={confirm} onChange={event => setConfirm(event.target.value)} />
            </label>
            <span className="pl-small pl-muted">At least 12 characters (up to 256). There are no other rules.</span>
            {notice ? <p role="status" style={{ margin: 0, fontWeight: 600 }}>{notice}</p> : null}
            {error ? <p role="alert" className="pl-small" style={{ margin: 0, color: "#A3361F", fontWeight: 600 }}>{error}</p> : null}
            <div>
              <button type="submit" className="pl-btn pl-btn-dark" disabled={busy}>{busy ? "Changing…" : "Change password"}</button>
            </div>
          </form>
        </>
      )}
    </section>
  );
}
