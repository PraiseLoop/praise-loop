"use client";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import Icon from "../ui/Icon";

// Public password recovery (#159). The email link carries a single-use,
// 30-minute token; this page only ever sends the token back to our own API. It
// works signed out and is treated as a bare route by AppShell.
async function postJson(path: string, body: object) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => null) as { error?: unknown; message?: unknown } | null;
  return {
    ok: response.ok,
    status: response.status,
    error: typeof data?.error === "string" ? data.error : null,
    message: typeof data?.message === "string" ? data.message : null
  };
}

export default function ResetPasswordPage() {
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get("token") ?? "");
  }, []);

  function passwordProblem(value: string) {
    const length = Array.from(value).length;
    return length < 12 ? "Use at least 12 characters." : length > 256 ? "Use at most 256 characters." : null;
  }

  async function requestLink(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError("Enter a valid email address."); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await postJson("/api/auth/password/reset/request", { email: email.trim() });
      if (!result.ok) { setError(result.error ?? "Could not send a reset link; try again."); return; }
      setNotice(result.message ?? "If that address has a password account, we’ve sent a reset link.");
    } catch {
      setError("Could not reach PraiseLoop; try again.");
    } finally { setBusy(false); }
  }

  async function resetNow(event: FormEvent) {
    event.preventDefault();
    if (busy || done) return;
    const problem = passwordProblem(password);
    if (problem) { setError(problem); return; }
    if (password !== confirm) { setError("The two passwords do not match."); return; }
    setBusy(true); setError(null);
    try {
      const result = await postJson("/api/auth/password/reset/confirm", { token, password });
      if (!result.ok) { setError(result.error ?? "That reset link is invalid or has expired."); return; }
      setDone(true);
      setPassword(""); setConfirm("");
    } catch {
      setError("Could not reach PraiseLoop; try again.");
    } finally { setBusy(false); }
  }

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
      <main className="pl-panel" style={{ width: "100%", maxWidth: 460, display: "flex", flexDirection: "column", gap: 14 }}>
        <Link href="/" className="pl-brand"><span className="pl-brand-mark"><Icon name="loop" strokeWidth={2.2} /></span>PraiseLoop</Link>
        <h1 className="pl-h2" style={{ margin: 0 }}>{done ? "Password changed" : token ? "Choose a new password" : "Reset your password"}</h1>

        {done ? (
          <>
            <p style={{ margin: 0 }}>Your password has been changed. Every other signed-in device has been signed out.</p>
            <Link className="pl-btn pl-btn-dark" href="/">Go to sign in</Link>
          </>
        ) : token ? (
          <form onSubmit={resetNow} noValidate style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p className="pl-small pl-muted" style={{ margin: 0 }}>
              This link can be used once and expires 30 minutes after it was requested. Signing in on any device will need the new password.
            </p>
            <label className="pl-field">
              New password
              <input className="pl-input" type="password" name="password" autoComplete="new-password" required minLength={12} value={password} onChange={event => setPassword(event.target.value)} autoFocus />
            </label>
            <label className="pl-field">
              Confirm new password
              <input className="pl-input" type="password" name="confirm" autoComplete="new-password" required minLength={12} value={confirm} onChange={event => setConfirm(event.target.value)} />
            </label>
            <span className="pl-small pl-muted">At least 12 characters (up to 256). There are no other rules.</span>
            {error ? <p role="alert" className="pl-small" style={{ color: "#A3361F", margin: 0 }}>{error}</p> : null}
            <button type="submit" className="pl-btn pl-btn-dark" disabled={busy}>{busy ? "Working…" : "Change password"}</button>
            <Link href="/" className="pl-small">Back to sign in</Link>
          </form>
        ) : (
          <form onSubmit={requestLink} noValidate style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p className="pl-small pl-muted" style={{ margin: 0 }}>
              Enter the email address on your password account and we’ll send a single-use link that expires in 30 minutes.
            </p>
            <label className="pl-field">
              Email address
              <input className="pl-input" type="email" name="email" autoComplete="email" inputMode="email" required value={email} onChange={event => setEmail(event.target.value)} autoFocus />
            </label>
            {notice ? <p role="status" className="pl-small pl-muted" style={{ margin: 0 }}>{notice}</p> : null}
            {error ? <p role="alert" className="pl-small" style={{ color: "#A3361F", margin: 0 }}>{error}</p> : null}
            <button type="submit" className="pl-btn pl-btn-dark" disabled={busy}>{busy ? "Working…" : "Send reset link"}</button>
            <Link href="/" className="pl-small">Back to sign in</Link>
          </form>
        )}
      </main>
    </div>
  );
}
