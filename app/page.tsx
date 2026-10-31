"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getProviders, signIn } from "next-auth/react";
import { useEffect, useState, type FormEvent } from "react";
import { landingNotice } from "../lib/sessionExpiry";
import { useBusiness } from "./AppShell";
import Icon from "./ui/Icon";
import styles from "./landing.module.css";

const steps = [
  ["1 · Bring your reviews", "Upload a spreadsheet of reviews from Google, Yelp or anywhere else."],
  ["2 · We make the posts", "Each week we pick the best quotes, design the image and write the caption."],
  ["3 · You approve", "Tweak a caption if you want. Approved posts go out on your schedule."]
];

type DemoOwnerOption = { key: string; label: string };

async function postJson(path: string, body: object) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => null) as { error?: unknown } | null;
  return { ok: response.ok, status: response.status, error: typeof data?.error === "string" ? data.error : null };
}

export default function HomePage() {
  const router = useRouter();
  const { status, businesses } = useBusiness();
  // Sent here by apiFetch when the session ended: say so, and return to the same page after sign-in.
  const [notice, setNotice] = useState<ReturnType<typeof landingNotice>>({ message: null, callbackUrl: null });
  useEffect(() => { setNotice(landingNotice(window.location.search)); }, []);
  // Microsoft is optional like Google: only offer it when the server has its
  // client configured, which NextAuth reports in its provider list.
  const [microsoftReady, setMicrosoftReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getProviders()
      .then(providers => { if (!cancelled) setMicrosoftReady(!!providers?.["azure-ad"]); })
      .catch(() => { /* The Google and email options still work. */ });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (status === "ready") router.replace(notice.callbackUrl ?? (businesses.length ? "/approval" : "/onboarding"));
  }, [status, businesses.length, router, notice.callbackUrl]);

  // Email one-time code (#157), the second way in and the one that works for any
  // mailbox. It shares the landing page with Google so the session-expiry return
  // path is identical.
  const [emailOpen, setEmailOpen] = useState(false);
  const [stage, setStage] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [emailNotice, setEmailNotice] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  // Development-only demo sign-in: the server answers 404 unless
  // MOBILE_DEV_AUTH=1 in a non-production process, so production pages show
  // nothing and carry no hint that the route exists.
  const [demoOwners, setDemoOwners] = useState<DemoOwnerOption[]>([]);
  const [demoError, setDemoError] = useState<string | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/dev/session", { headers: { accept: "application/json" } })
      .then(response => response.ok ? response.json() : null)
      .then((data: { owners?: unknown } | null) => {
        if (cancelled || !Array.isArray(data?.owners)) return;
        setDemoOwners(data.owners.filter((owner): owner is DemoOwnerOption =>
          !!owner && typeof owner === "object" && typeof (owner as DemoOwnerOption).key === "string" && typeof (owner as DemoOwnerOption).label === "string"));
      })
      .catch(() => { /* The normal sign-in options still work without it. */ });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown(value => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function sendCode(event?: FormEvent) {
    event?.preventDefault();
    if (busy) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setEmailError("Enter a valid email address."); return; }
    setBusy(true); setEmailError(null); setEmailNotice(null);
    try {
      const result = await postJson("/api/auth/email/request", { email: email.trim() });
      if (!result.ok) {
        setEmailError(result.error ?? "Could not send a code; try again.");
        return;
      }
      setStage("code");
      setCooldown(60);
      setEmailNotice("If that address can sign in, we’ve sent a code. It expires in 10 minutes.");
    } catch {
      setEmailError("Could not reach PraiseLoop; try again.");
    } finally { setBusy(false); }
  }

  async function verifyCode(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!/^\d{6}$/.test(code.trim())) { setEmailError("Enter the 6-digit code from the email."); return; }
    setBusy(true); setEmailError(null);
    try {
      const result = await postJson("/api/auth/email/verify", { email: email.trim(), code: code.trim() });
      if (!result.ok) {
        setEmailError(result.status === 429 ? "Too many attempts. Try again later." : result.error ?? "That code is invalid or has expired.");
        return;
      }
      // Reload so AppShell sees the new cookie and runs the existing, validated
      // callback redirect instead of navigating to a query-string value here.
      window.location.reload();
    } catch {
      setEmailError("Could not reach PraiseLoop; try again.");
    } finally { setBusy(false); }
  }

  function restart() {
    setStage("email"); setCode(""); setEmailError(null); setEmailNotice(null); setCooldown(0);
  }

  async function signInDemo(owner: string) {
    if (demoBusy) return;
    setDemoBusy(true); setDemoError(null);
    try {
      const result = await postJson("/api/dev/session", { owner });
      if (!result.ok) {
        setDemoError(result.error ?? "Demo sign-in failed; try again.");
        return;
      }
      // Reload, as the email sign-in does: AppShell reads the session once on mount, and once it sees
      // the new cookie the effect above sends the owner to the callback or their queue.
      window.location.reload();
    } catch {
      setDemoError("Could not reach PraiseLoop; try again.");
    } finally { setDemoBusy(false); }
  }

  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <Link href="/" className="pl-brand"><span className="pl-brand-mark"><Icon name="loop" strokeWidth={2.2} /></span>PraiseLoop</Link>
        <Link href="/plans" className="pl-small">Plans</Link>
      </header>
      <main className={styles.hero}>
        <section className={styles.copy}>
          <span className="pl-badge pl-badge-ready">For local businesses</span>
          <h1 className={styles.headline}>Your happy customers are your best marketing.</h1>
          <p className={styles.lede}>PraiseLoop turns your best reviews into on-brand social posts every week. You spend five minutes approving them. That’s it.</p>
          {notice.message ? <p role="alert" className="pl-banner">{notice.message}</p> : null}
          <div className={styles.cta}>
            <button type="button" className="pl-btn pl-btn-dark pl-btn-lg" onClick={() => signIn("google", { callbackUrl: notice.callbackUrl ?? "/approval" })} disabled={status === "loading" || status === "ready"}>
              Continue with Google
            </button>
            {microsoftReady ? (
              <button type="button" className="pl-btn pl-btn-dark pl-btn-lg" onClick={() => signIn("azure-ad", { callbackUrl: notice.callbackUrl ?? "/approval" })} disabled={status === "loading" || status === "ready"}>
                Continue with Microsoft
              </button>
            ) : null}
            {!emailOpen ? (
              <button type="button" className="pl-btn" onClick={() => { setEmailOpen(true); setEmailError(null); }} disabled={status === "loading" || status === "ready"}>
                Email me a sign-in code
              </button>
            ) : (
              <form className={styles.email} onSubmit={stage === "email" ? sendCode : verifyCode} noValidate>
                <span className="pl-small pl-muted">
                  {stage === "email" ? "Any email address works — no password and no Google account needed." : `Code sent to ${email.trim()}.`}
                </span>
                {stage === "email" ? (
                  <label className="pl-field">
                    Email address
                    <input className="pl-input" type="email" name="email" autoComplete="email" inputMode="email" required value={email} onChange={event => setEmail(event.target.value)} autoFocus />
                  </label>
                ) : (
                  <label className="pl-field">
                    6-digit code
                    <input className="pl-input" type="text" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={event => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} autoFocus />
                  </label>
                )}
                {emailNotice ? <p role="status" className="pl-small pl-muted">{emailNotice}</p> : null}
                {emailError ? <p role="alert" className="pl-small" style={{ color: "#A3361F" }}>{emailError}</p> : null}
                <button type="submit" className="pl-btn pl-btn-dark" disabled={busy}>
                  {busy ? "Working…" : stage === "email" ? "Send code" : "Sign in"}
                </button>
                {stage === "code" ? (
                  <div className={styles.emailLinks}>
                    <button type="button" className="pl-btn pl-btn-danger pl-small" onClick={() => void sendCode()} disabled={busy || cooldown > 0}>
                      {cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"}
                    </button>
                    <button type="button" className="pl-btn pl-btn-danger pl-small" onClick={restart} disabled={busy}>Use a different address</button>
                  </div>
                ) : (
                  <button type="button" className="pl-btn pl-btn-danger pl-small" onClick={() => { setEmailOpen(false); restart(); }} disabled={busy}>Cancel</button>
                )}
              </form>
            )}
            <span className="pl-muted pl-small">Nothing posts without your OK.</span>
            <Link href="/plans" className="pl-small">See what each plan includes</Link>
            {demoOwners.length > 0 ? (
              <div className={styles.demo}>
                <span className="pl-small pl-muted">Demo mode: sign in as a seeded synthetic owner.</span>
                <div className={styles.emailLinks}>
                  {demoOwners.map(owner => (
                    <button key={owner.key} type="button" className="pl-btn" onClick={() => void signInDemo(owner.key)} disabled={demoBusy || status === "loading" || status === "ready"}>
                      {owner.label}
                    </button>
                  ))}
                </div>
                {demoError ? <p role="alert" className="pl-small" style={{ color: "#A3361F" }}>{demoError}</p> : null}
              </div>
            ) : null}
          </div>
        </section>
        <div className={styles.sample} role="img" aria-label="Example quote card: The sourdough is unreal and they remember my order every single time. — Priya S.">
          <span className={styles.stars} aria-hidden="true">★★★★★</span>
          <p className={styles.quote}>“The sourdough is unreal and they remember my order every single time.”</p>
          <span className={styles.author}>Priya S.</span>
        </div>
      </main>
      <section aria-label="How it works" className={styles.steps}>
        {steps.map(([title, body]) => (
          <div key={title} className={styles.step}><strong>{title}</strong><span>{body}</span></div>
        ))}
      </section>
    </div>
  );
}
