"use client";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { apiFetch } from "../apiFetch";
import { useBusiness } from "../AppShell";
import BrandPreview from "../brand/BrandPreview";
import { ColorPicker, readLogo, timezones, TonePicker, type BrandTone } from "../brand/options";
import Icon from "../ui/Icon";
import { jobNotice, postCount, readyFooter } from "../../lib/onboardingStatus";
import styles from "./onboarding.module.css";

type Draft = { id: string; version: number; quote_text: string; caption_text: string; image_path: string | null; status: string; job_state?: string; error_code?: string };
type Progress = { business: { id: string; name: string; timezone: string; weekly_target: number } | null; reviews: number; drafts: Draft[]; period?: { reason: string; allocated: number; target: number }; postsPerWeek?: number };
type ImportResult = { imported: number; duplicates: number; rejectedInvalid: number; skippedEmpty: number; failedRows: number; errors?: { row: number; error: string }[] };

// A successful request can still queue nothing; say why instead of appearing to do nothing.
const noDrafts: Record<string, string> = {
  reviews_exhausted: "None of your reviews can become posts yet. Add a few 4–5 star reviews with at least 30 characters, then try again.",
  quota_met: "You’ve used this week’s posts. New ones can be made next week.",
  backlog_full: "Posts are still being made. Check back in a minute.",
  business_paused: "This business is paused because your plan includes fewer businesses. Upgrade on the plans page to resume new posts."
};

function browserZone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } }

export default function Onboarding() {
  const shell = useBusiness();
  const [data, setData] = useState<Progress | null>(null), [message, setMessage] = useState(""), [busy, setBusy] = useState(false), [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [name, setName] = useState(""), [zone, setZone] = useState("UTC"), [primary, setPrimary] = useState("#5b2a44"), [secondary] = useState("#f2e3c8"), [tone, setTone] = useState<BrandTone>("friendly"), [logo, setLogo] = useState("");
  const [loaded, setLoaded] = useState<Record<string, string>>({}); const key = useRef(""); const fresh = useRef(false);
  // How long this page has watched each draft hold its current in-flight state. A
  // retry changes the state, so it starts a fresh clock instead of inheriting the
  // age of an older draft.
  const seenJobs = useRef<Record<string, { state: string; since: number }>>({});

  function observeJobs(drafts: Draft[]) {
    const at = Date.now();
    const next: typeof seenJobs.current = {};
    for (const draft of drafts) {
      const state = draft.job_state ?? "";
      if (!["pending", "running", "retry"].includes(state)) continue;
      const before = seenJobs.current[draft.id];
      next[draft.id] = before?.state === state ? before : { state, since: at };
    }
    seenJobs.current = next;
  }
  function waitingFor(draft: Draft) {
    const before = seenJobs.current[draft.id];
    return before && before.state === (draft.job_state ?? "") ? Date.now() - before.since : 0;
  }

  async function load(id?: string) {
    const response = await apiFetch(`/api/onboarding${id ? `?businessId=${encodeURIComponent(id)}` : ""}`), next = await response.json();
    if (!response.ok) { setData(null); setMessage(response.status === 401 ? "" : next.error ?? "Unable to resume; sign in and retry"); return; }
    setData(next); observeJobs(next.drafts); if (next.business) window.history.replaceState(null, "", `/onboarding?businessId=${next.business.id}`);
  }
  useEffect(() => {
    const params = new URL(window.location.href).searchParams;
    fresh.current = params.get("new") === "1";
    // A new business gets its own idempotency key so it never resumes the previous setup request.
    // That key also survives reloads, so a retried create after a lost response can't duplicate it.
    const slot = fresh.current ? "praise-onboarding-new-key" : "praise-onboarding-key";
    key.current = sessionStorage.getItem(slot) || crypto.randomUUID();
    sessionStorage.setItem(slot, key.current);
    setZone(browserZone());
    if (fresh.current) setData({ business: null, reviews: 0, drafts: [] });
    else void load(params.get("businessId") ?? undefined);
  }, []);
  const business = data?.business;
  useEffect(() => { if (!business) return; const timer = setInterval(() => void load(business.id), 2000); return () => clearInterval(timer); }, [business?.id]);

  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      const response = await apiFetch("/api/businesses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, timezone: zone, brandColors: { primary, secondary }, brandTone: tone, logoUrl: logo || null, onboardingKey: key.current }) }); const body = await response.json();
      if (!response.ok) { setMessage(body.error); return; }
      if (fresh.current) sessionStorage.removeItem("praise-onboarding-new-key");
      await load(body.business.id); setMessage(""); void shell.reload();
    } catch { setMessage("Connection problem. Try again — your setup won’t be duplicated."); } finally { setBusy(false); }
  }
  async function importCsv(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!business) return; const form = event.currentTarget; const formData = new FormData(form); formData.set("businessId", business.id); setBusy(true);
    try {
      const response = await apiFetch("/api/reviews/import", { method: "POST", body: formData }), body = await response.json();
      if (!response.ok) { setResult(null); setMessage(body.error); return; }
      setResult(body); setMessage(""); form.reset(); await load(business.id);
    } catch { setMessage("Import connection failed; importing the same file again is safe."); } finally { setBusy(false); }
  }
  async function importTakeout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!business) return; const form = event.currentTarget; const formData = new FormData(form); formData.set("businessId", business.id); setBusy(true);
    try {
      const response = await apiFetch("/api/reviews/import-takeout", { method: "POST", body: formData }), body = await response.json();
      if (!response.ok) { setResult(null); setMessage(body.error); return; }
      setResult(body); setMessage(""); form.reset(); await load(business.id);
    } catch { setMessage("Import connection failed; importing the same file again is safe."); } finally { setBusy(false); }
  }
  async function generate(path = "/api/quotes/select", draft?: Draft) {
    if (!business) return; setBusy(true);
    try {
      const response = await apiFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(draft ? { draftPostId: draft.id, version: draft.version } : { businessId: business.id, limit: 3 }) }), body = await response.json();
      if (!response.ok) setMessage(body.error ?? "We couldn’t start making posts. Try again.");
      else if (!draft && !body.inserted) setMessage(noDrafts[body.reason] ?? "We couldn’t find a review to turn into a post yet.");
      else { setMessage(""); setImporting(false); setResult(null); }
      await load(business.id);
    } catch { setMessage("Connection problem; refresh progress before trying again."); } finally { setBusy(false); }
  }

  if (shell.status === "signed-out") {
    return (
      <div className={styles.frame}>
        <main className={styles.body}>
          <h1 className={styles.title}>Sign in to set up your business</h1>
          <p className="pl-muted">Your progress is saved to your account, so you can pick up where you left off.</p>
          <button type="button" className="pl-btn pl-btn-dark pl-btn-lg" onClick={() => signIn("google", { callbackUrl: "/onboarding" })}>Continue with Google</button>
        </main>
      </div>
    );
  }
  if (!data) return <div className={styles.frame}><main className={styles.body}><p className="pl-muted" role="status">{message || "Loading your setup…"}</p></main></div>;

  const target = Math.min(3, business?.weekly_target ?? 3, data.postsPerWeek ?? 3);
  const complete = data.drafts.filter(d => d.caption_text.trim() && d.image_path && !["failed", "archived"].includes(d.status)).slice(0, target);
  const ready = complete.length === target && complete.every(d => loaded[d.id] === d.image_path);
  const active = data.drafts.some(d => ["pending", "running", "retry"].includes(d.job_state ?? ""));
  const stuck = data.drafts.some(d => jobNotice(d, waitingFor(d)).kind === "slow");
  const step = !business ? 1 : importing || !data.drafts.length ? 2 : ready ? 4 : 3;
  const markLoaded = (d: Draft) => setLoaded(v => ({ ...v, [d.id]: d.image_path! }));
  const imageFailed = (d: Draft) => { setLoaded(v => ({ ...v, [d.id]: "" })); setMessage("An image didn’t load. You can recover it from This week."); };

  return (
    <div className={styles.frame}>
      <header className={styles.header}>
        <div className={styles.headerRow}>
          <span />
          <span className="pl-small pl-muted" style={{ fontWeight: 600 }}>Step {step} of 4</span>
          {/* Step 3 puts its exits in the footer, next to the waiting message. */}
          {business ? (step === 3 ? <span /> : <Link href={`/approval?businessId=${business.id}`} className="pl-small" style={{ fontWeight: 600 }}>Save &amp; exit</Link>) : shell.businesses.length ? <Link href="/approval" className="pl-small" style={{ fontWeight: 600 }}>Cancel</Link> : <span />}
        </div>
        <div role="progressbar" aria-label="Setup progress" aria-valuenow={step} aria-valuemin={0} aria-valuemax={4} className={styles.progress}>
          {[1, 2, 3, 4].map(n => <span key={n} className={n <= step ? styles.done : undefined} />)}
        </div>
      </header>

      <main className={styles.body}>
        <p role="status" className="pl-toast">{message}</p>

        {step === 1 ? (
          <form id="brand-form" onSubmit={create} className={styles.stack}>
            <div>
              <h1 className={styles.title}>Tell us about your business</h1>
              <p className="pl-muted" style={{ margin: 0 }}>This is how your posts will look and sound. You can change it later.</p>
            </div>
            <label className="pl-field">Business name<input className="pl-input" required maxLength={120} value={name} onChange={e => setName(e.target.value)} /></label>
            <label className="pl-field">Time zone
              <select className="pl-select" value={zone} onChange={e => setZone(e.target.value)}>{timezones(zone).map(z => <option key={z} value={z}>{z.replaceAll("_", " ")}</option>)}</select>
            </label>
            <ColorPicker label="Brand color" value={primary} onChange={setPrimary} />
            <TonePicker name="onboarding-tone" value={tone} onChange={setTone} />
            <div className="pl-field">
              <span>Logo <span className="pl-muted" style={{ fontWeight: 400 }}>(optional)</span></span>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                {logo ? <img src={logo} alt="Selected logo" width={48} height={48} style={{ objectFit: "contain", borderRadius: 10, border: "1px solid var(--pl-line)", background: "#FFFFFF" }} /> : null}
                <input className="pl-input" type="file" aria-label="Optional logo" accept="image/png,image/jpeg,image/webp" onChange={e => { setLogo(""); readLogo(e.target.files?.[0], setLogo, setMessage); }} />
              </div>
              <span className="pl-small pl-muted" style={{ fontWeight: 400 }}>PNG, JPEG or WebP, up to 256 KB.</span>
            </div>
            <details>
              <summary style={{ cursor: "pointer", fontWeight: 600, color: "var(--pl-green)" }}>Preview a sample post</summary>
              <div style={{ marginTop: 12, maxWidth: 320 }}><BrandPreview primary={primary} secondary={secondary} quoteSize="standard" tone={tone} template="quote-card-v1" /></div>
            </details>
          </form>
        ) : null}

        {step === 2 && business ? (
          <div className={styles.stack}>
            <div>
              <h1 className={styles.title}>Bring in your reviews</h1>
              <p className="pl-muted" style={{ margin: 0 }}>Upload a CSV with rating, review text and date, or import a Google Takeout export. Uploading the same file twice is fine — we skip repeats.</p>
            </div>
            <form onSubmit={importCsv} className={styles.drop}>
              <Icon name="upload" size={28} />
              <label className="pl-field" style={{ alignItems: "center", textAlign: "center" }}>
                Review CSV
                <input className="pl-input" type="file" name="file" accept=".csv,text/csv" required />
              </label>
              <span className="pl-small pl-muted">Columns: rating, text, reviewed_at. Optional: author_name, source_review_id, source_url. Up to 1,000 rows / 1 MB.</span>
              <button type="submit" className="pl-btn" disabled={busy}>Import reviews</button>
            </form>
            <a href="/onboarding-example.csv" download className="pl-small" style={{ fontWeight: 600 }}>Download a sample CSV</a>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 8, borderTop: "1px solid var(--pl-line-soft)" }}>
              <strong>Or import a Google Takeout export</strong>
              <span className="pl-small pl-muted">
                In Google Takeout, deselect everything, choose <strong>Business Profile</strong>, and export once.
                Download the archive, then open <strong>Google Business Profile → account-… → location-… → reviews.json</strong>.
                Takeout only includes profiles you own or manage, and it exports JSON only. This uses no Google API connection.
              </span>
              <form onSubmit={importTakeout} className={styles.drop}>
                <Icon name="upload" size={28} />
                <label className="pl-field" style={{ alignItems: "center", textAlign: "center" }}>
                  Google Takeout reviews (JSON)
                  <input className="pl-input" type="file" name="file" accept=".json,application/json" required />
                </label>
                <span className="pl-small pl-muted">reviews.json from your own Business Profile. Up to 1,000 reviews / 1 MB.</span>
                <button type="submit" className="pl-btn" disabled={busy}>Import Takeout reviews</button>
              </form>
            </div>
            {result ? (
              <section aria-label="Import results" className="pl-panel" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 6 }}>
                <strong>{result.imported} imported · {result.duplicates} duplicates skipped</strong>
                {result.rejectedInvalid + result.skippedEmpty + result.failedRows ? (
                  <span style={{ color: "#A3361F" }}>{result.rejectedInvalid} invalid · {result.skippedEmpty} empty · {result.failedRows} couldn’t be saved</span>
                ) : null}
                {result.errors?.length ? <ul style={{ margin: 0, paddingLeft: 20 }} className="pl-small">{result.errors.map(e => <li key={`${e.row}-${e.error}`}>Row {e.row}: {e.error}</li>)}</ul> : null}
              </section>
            ) : null}
            <p className="pl-muted" style={{ margin: 0 }}>{data.reviews ? `${data.reviews} reviews so far. We pick 4–5 star reviews with at least 30 characters.` : "No reviews yet."}</p>
          </div>
        ) : null}

        {step === 3 ? (
          <div className={styles.stack}>
            <div>
              <h1 className={styles.title}>Making your first posts</h1>
              <p className="pl-muted" style={{ margin: 0 }}>Usually under a minute. You can close this page — we’ll keep going and they’ll be waiting for you.</p>
            </div>
            <ol aria-live="polite" className={styles.jobs}>
              {data.drafts.map((d, n) => {
                // The worker marks the draft failed while it retries automatically; only a failed job is terminal.
                const notice = jobNotice(d, waitingFor(d));
                const failed = notice.kind === "failed";
                const shown = d.image_path && d.caption_text.trim() && !failed;
                return (
                  <li key={d.id} className={styles.job}>
                    {shown ? <img src={d.image_path!} width={64} height={64} alt={`Onboarding draft ${d.id}`} onLoad={() => markLoaded(d)} onError={() => imageFailed(d)} /> : <span className={failed ? styles.thumbFailed : styles.thumbPending} aria-hidden="true" />}
                    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                      <strong>Post {data.drafts.length - n}</strong>
                      <span className={failed ? undefined : "pl-muted"} style={failed ? { color: "#A3361F" } : undefined}>
                        {notice.text}
                      </span>
                    </div>
                    {notice.actions.includes("retry") ? <button type="button" className="pl-btn pl-btn-dark" disabled={busy} onClick={() => void generate("/api/generation/retry", d)}>Try again</button>
                      : shown ? <span className="pl-badge pl-badge-approved"><Icon name="check" size={13} strokeWidth={3} />Ready</span> : null}
                  </li>
                );
              })}
            </ol>
            {stuck && business ? (
              <div className="pl-panel" role="status" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
                <strong>This is taking longer than usual</strong>
                <span className="pl-muted">The generation worker may be paused, so these posts are taking much longer than usual. Nothing is lost, and nothing is posted until you approve it. They’ll keep going in the background.</span>
                <Link href={`/approval?businessId=${business.id}`} className="pl-btn">Carry on to This week</Link>
              </div>
            ) : null}
            {!active && complete.length < target ? (
              <div className="pl-panel" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
                <strong>We need a few more reviews</strong>
                <span className="pl-muted">We could make {complete.length} of {postCount(target)}. Add a few more 4–5 star reviews with at least 30 characters so we can make the rest.</span>
                <button type="button" className="pl-btn" onClick={() => setImporting(true)}>Add more reviews</button>
              </div>
            ) : (
              <div style={{ padding: "14px 16px", borderRadius: 14, background: "#FCF1D6", color: "#4A3300", fontSize: 14, lineHeight: 1.5 }}>
                <strong>How we pick:</strong> 4–5 star reviews with enough to say, that we haven’t used before. Nothing gets posted until you approve it.
              </div>
            )}
          </div>
        ) : null}

        {step === 4 && business ? (
          <div className={styles.stack}>
            <div>
              <h1 className={styles.title}>{target === 1 ? "Your first post is ready" : `Your first ${postCount(target)} are ready`}</h1>
              <p className="pl-muted" style={{ margin: 0 }}>Made from what your customers already said.</p>
            </div>
            <div className={styles.carousel}>
              {complete.map(d => (
                <article key={d.id} className="pl-card" style={{ flex: "0 0 min(300px, 80%)", scrollSnapAlign: "start" }}>
                  <div className="pl-card-media"><img src={d.image_path!} alt={`Onboarding draft ${d.id}`} onLoad={() => markLoaded(d)} onError={() => imageFailed(d)} /></div>
                  <p className="pl-card-body pl-caption-text">{d.caption_text}</p>
                </article>
              ))}
            </div>
            {/* Optional: onboarding never requires a posting connection. Posts wait in
                the approval queue until the owner connects Instagram, Facebook or Buffer. */}
            <section className="pl-panel" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
              <strong>Want us to publish for you?</strong>
              <span className="pl-muted">
                You can connect Instagram or Facebook now, but it’s optional. Until you do, your
                approved posts stay in the approval queue and you can post them from your phone.
              </span>
              <Link href="/connections" className="pl-btn" style={{ alignSelf: "flex-start" }}>Connect Instagram or Facebook</Link>
            </section>
          </div>
        ) : null}
      </main>

      <footer className={styles.footer}>
        {step === 1 ? <button type="submit" form="brand-form" className="pl-btn pl-btn-primary pl-btn-lg" disabled={busy}>Continue</button> : null}
        {step === 2 ? <button type="button" className="pl-btn pl-btn-primary pl-btn-lg" disabled={busy || !data.reviews} onClick={() => void generate()}>Make my first {postCount(target)}</button> : null}
        {step === 3 && business ? <>
          <span className="pl-small pl-muted" style={{ textAlign: "center" }}>{readyFooter(target)}</span>
          <button type="button" className="pl-btn" onClick={() => setImporting(true)}>Back</button>
          <Link href={`/approval?businessId=${business.id}`} className="pl-btn pl-btn-primary pl-btn-lg">Save &amp; exit</Link>
        </> : null}
        {step === 4 && business ? <>
          <Link href={`/approval?businessId=${business.id}`} className="pl-btn pl-btn-primary pl-btn-lg">Review &amp; approve</Link>
          <span className="pl-small pl-muted" style={{ textAlign: "center" }}>Nothing posts until you approve it.</span>
        </> : null}
      </footer>
    </div>
  );
}
