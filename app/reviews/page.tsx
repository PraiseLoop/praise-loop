"use client";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../apiFetch";
import { useBusiness } from "../AppShell";
import Icon from "../ui/Icon";

type Review = { id: number; rating: number; author_name: string | null; text: string; reviewed_at: string; source: string; status: string };
type ImportResult = { imported: number; duplicates: number; failedRows: number; skippedEmpty: number; rejectedInvalid: number; errors?: { row: number; error: string }[] };
type Filter = "all" | "ready" | "used" | "unfit";
type ApifyRun = {
  id: number; status: string; startedAt: string; importedAt: string | null;
  imported: number; duplicates: number; rejected: number; skipped: number; failedRows: number;
  errorCode: string | null; inProgress: boolean;
};
type ApifyStatus = {
  enabled: boolean;
  place: { input: string; kind: string; confirmedAt: string } | null;
  run: ApifyRun | null;
  canStart: boolean;
  nextRunAt: string | null;
  limits: { maxReviews: number; intervalHours: number };
};
const apifyErrors: Record<string, string> = {
  unavailable: "Fetching Google reviews isn’t available right now.",
  confirmation_required: "Please confirm this is your own business.",
  invalid_place: "That doesn’t look like a single Google Maps place. Paste the link to your business.",
  run_in_progress: "A fetch is already running for this business.",
  run_interval: "This business has already fetched reviews recently. Try again later.",
  daily_limit: "You’ve reached today’s limit for fetching reviews. Try again tomorrow.",
  provider_auth: "The review service refused our request. Nothing was fetched.",
  provider_error: "The review service had a problem. Try again in a few minutes.",
  provider_failed: "The review service couldn’t finish this fetch. You can try again.",
  timeout: "This fetch took too long and was stopped. You can try again.",
  missing_dataset: "The review service returned no results. You can try again."
};
const apifyError = (code: string | null | undefined) => apifyErrors[code ?? ""] ?? "Something went wrong fetching reviews. Try again.";

const statusLabels: Record<string, [string, string]> = {
  ready: ["pl-badge-approved", "Ready"],
  used: ["pl-badge-scheduled", "In a post"],
  duplicate: ["pl-badge-archived", "Duplicate"],
  low_rating: ["pl-badge-archived", "Under 4 stars"],
  too_short: ["pl-badge-archived", "Too short"],
  unsuitable: ["pl-badge-archived", "Not suitable"]
};
const filters: [Filter, string][] = [["all", "All"], ["ready", "Ready"], ["used", "Used"], ["unfit", "Not a fit"]];
const unfit = ["duplicate", "low_rating", "too_short", "unsuitable"];

function stars(rating: number) { return "★★★★★".slice(0, rating) + "☆☆☆☆☆".slice(0, 5 - rating); }

export default function ReviewsPage() {
  const { business, status } = useBusiness();
  const businessId = business?.id;
  const [reviews, setReviews] = useState<Review[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState<Filter>("all");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [apify, setApify] = useState<ApifyStatus | null>(null);
  const [apifyMessage, setApifyMessage] = useState("");
  const [apifyBusy, setApifyBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const currentId = useRef(businessId);
  currentId.current = businessId;

  const load = useCallback(async (id: number | string, isCurrent: () => boolean = () => true) => {
    const response = await apiFetch(`/api/reviews?businessId=${id}`);
    if (!response.ok || !isCurrent()) return;
    const data = await response.json();
    setReviews(data.reviews ?? []);
    setCounts(data.counts ?? {});
  }, []);

  // The status call also advances an in-progress Apify run and imports a
  // successful dataset once, so polling it is enough while a run is going.
  const loadApify = useCallback(async (id: number | string, isCurrent: () => boolean = () => true) => {
    const response = await apiFetch(`/api/businesses/${id}/apify-reviews`);
    if (!isCurrent()) return;
    // Keep the form on screen if a status check fails: polling tries again, and the page says why.
    if (!response.ok) {
      const failed = await response.json().catch(() => null) as { error?: string } | null;
      if (isCurrent()) setApifyMessage(apifyError(failed?.error));
      return;
    }
    const data = await response.json() as ApifyStatus;
    if (!isCurrent()) return;
    setApify(data);
    setApifyMessage("");
    if (data.run?.importedAt) await load(id, isCurrent);
  }, [load]);

  useEffect(() => {
    setReviews([]); setCounts({}); setResult(null); setMessage("");
    setApify(null); setApifyMessage("");
    if (!businessId) return;
    let current = true;
    void load(businessId, () => current);
    void loadApify(businessId, () => current);
    return () => { current = false; };
  }, [businessId, load, loadApify]);

  const apifyPolling = Boolean(apify?.run && (apify.run.inProgress || (apify.run.status === "SUCCEEDED" && !apify.run.importedAt)));
  useEffect(() => {
    if (!businessId || !apifyPolling) return;
    const polledFor = businessId;
    const timer = setInterval(() => {
      void loadApify(polledFor, () => currentId.current === polledFor);
    }, 5000);
    return () => clearInterval(timer);
  }, [businessId, apifyPolling, loadApify]);

  async function importCsv(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!businessId) return;
    const importedFor = businessId, stillCurrent = () => currentId.current === importedFor;
    const form = e.currentTarget;
    const formData = new FormData(form);
    formData.set("businessId", String(businessId));
    setBusy(true);
    try {
      const response = await apiFetch("/api/reviews/import", { method: "POST", body: formData });
      const data = await response.json();
      // The owner may have switched business while the upload ran; don't show A's results under B.
      if (!stillCurrent()) return;
      if (!response.ok) { setResult(null); setMessage(`Import failed: ${data.error ?? "unknown error"}`); return; }
      setResult(data); setMessage("");
      form.reset();
      await load(importedFor, stillCurrent);
    } catch {
      if (stillCurrent()) setMessage("Connection problem. Importing the same file again is safe — duplicates are skipped.");
    } finally { setBusy(false); }
  }

  async function importTakeout(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!businessId) return;
    const importedFor = businessId, stillCurrent = () => currentId.current === importedFor;
    const form = e.currentTarget;
    const formData = new FormData(form);
    formData.set("businessId", String(businessId));
    setBusy(true);
    try {
      const response = await apiFetch("/api/reviews/import-takeout", { method: "POST", body: formData });
      const data = await response.json();
      // The owner may have switched business while the upload ran; don't show A's results under B.
      if (!stillCurrent()) return;
      if (!response.ok) { setResult(null); setMessage(`Import failed: ${data.error ?? "unknown error"}`); return; }
      setResult(data); setMessage("");
      form.reset();
      await load(importedFor, stillCurrent);
    } catch {
      if (stillCurrent()) setMessage("Connection problem. Importing the same file again is safe — duplicates are skipped.");
    } finally { setBusy(false); }
  }

  async function fetchGoogleReviews(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!businessId) return;
    const startedFor = businessId, stillCurrent = () => currentId.current === startedFor;
    const formData = new FormData(e.currentTarget);
    const place = String(formData.get("place") ?? "");
    const confirmed = formData.get("confirmed") === "on";
    setApifyBusy(true);
    setApifyMessage("");
    try {
      const response = await apiFetch(`/api/businesses/${businessId}/apify-reviews`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ place, confirmed })
      });
      const data = await response.json();
      if (!stillCurrent()) return;
      if (!response.ok) { setApifyMessage(apifyError(data.error)); return; }
      setApify(data);
    } catch {
      if (stillCurrent()) setApifyMessage("Connection problem. Check the status below before starting another run.");
    } finally { setApifyBusy(false); }
  }

  if (status === "loading") return <p className="pl-muted" role="status">Loading reviews…</p>;
  if (!business) return <div className="pl-empty"><h2>Set up your business first</h2><Link href="/onboarding" className="pl-btn pl-btn-primary">Get started</Link></div>;

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const shown = reviews.filter(r => filter === "all" || (filter === "unfit" ? unfit.includes(r.status) : r.status === filter));
  const problems = result ? result.failedRows + result.rejectedInvalid + result.skippedEmpty : 0;

  return (
    <>
      <header className="pl-header">
        <div className="pl-header-text">
          <h1 className="pl-title">Reviews</h1>
          <p className="pl-lede">Everything your customers have said, and which reviews we can turn into posts.</p>
        </div>
      </header>

      {apify?.enabled ? (
        <form key={businessId} onSubmit={fetchGoogleReviews} className="pl-panel" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <h2 className="pl-h2" style={{ fontSize: 18, marginBottom: 4 }}>Fetch Google reviews</h2>
            <p className="pl-small pl-muted" style={{ margin: 0 }}>
              Temporary stopgap until official Google sync. Paste one Google Maps place link or place ID for this business.
              We keep only a short reviewer name and the review text; the review link, reviewer profile and photo are discarded.
            </p>
          </div>
          <label className="pl-field">
            Google Maps link or place ID
            <input
              className="pl-input"
              name="place"
              type="text"
              required
              defaultValue={apify.place?.input ?? ""}
              placeholder="https://www.google.com/maps/place/… or ChIJ…"
            />
          </label>
          <label className="pl-small" style={{ display: "flex", alignItems: "flex-start", gap: 8, fontWeight: 400 }}>
            <input type="checkbox" name="confirmed" required style={{ marginTop: 3 }} />
            I confirm this is my own business.
          </label>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <button type="submit" className="pl-btn pl-btn-primary" disabled={apifyBusy || !apify.canStart}>
              <Icon name="reviews" size={18} />{apify.run?.inProgress ? "Fetching…" : "Fetch reviews"}
            </button>
            <span className="pl-small pl-muted">
              Up to {apify.limits.maxReviews} reviews per run · next run after {apify.limits.intervalHours}h
            </span>
          </div>
          {apify.run ? (
            <p role="status" className="pl-small" style={{ margin: 0 }}>
              {apify.run.inProgress
                ? "Fetching your reviews. This can take a few minutes, and you can leave this page."
                : apify.run.importedAt
                  ? `${apify.run.imported} imported · ${apify.run.duplicates} duplicates skipped · ${apify.run.rejected} invalid · ${apify.run.skipped} without text · ${apify.run.failedRows} storage failures`
                  : apify.run.errorCode
                    ? apifyError(apify.run.errorCode)
                    : "Finishing up…"}
            </p>
          ) : null}
          {apify.nextRunAt && !apify.canStart && !apify.run?.inProgress ? (
            <p className="pl-small pl-muted" style={{ margin: 0 }}>
              Next run available after {new Date(apify.nextRunAt).toLocaleString()}.
            </p>
          ) : null}
          {apifyMessage ? <p role="status" className="pl-small" style={{ margin: 0, color: "#A3361F", fontWeight: 600 }}>{apifyMessage}</p> : null}
        </form>
      ) : null}

      <form onSubmit={importCsv} className="pl-panel" style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 16 }}>
        <label className="pl-field" style={{ flex: "1 1 280px" }}>
          Review CSV
          <input ref={fileInput} className="pl-input" type="file" name="file" accept=".csv,text/csv" required />
          <span className="pl-small pl-muted" style={{ fontWeight: 400 }}>Columns: rating, text, reviewed_at. Optional: author_name, source_review_id, source_url. Up to 1,000 rows / 1 MB. Re-importing a file is safe.</span>
        </label>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <button type="submit" className="pl-btn pl-btn-primary pl-btn-lg" disabled={busy}><Icon name="upload" size={18} />Import reviews</button>
          <a href="/onboarding-example.csv" download className="pl-small" style={{ fontWeight: 600 }}>Sample CSV</a>
        </div>
      </form>

      <form onSubmit={importTakeout} className="pl-panel" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <h2 className="pl-h2" style={{ fontSize: 18, marginBottom: 4 }}>Import a Google Takeout export</h2>
          <p className="pl-small pl-muted" style={{ margin: 0 }}>
            In Google Takeout, deselect everything, choose <strong>Business Profile</strong>, and export once.
            Download the archive, then open <strong>Google Business Profile → account-… → location-… → reviews.json</strong>.
            Takeout only includes profiles you own or manage, and it exports JSON only. We read the file here; there is no Google API connection.
          </p>
        </div>
        <label className="pl-field">
          Google Takeout reviews (JSON)
          <input className="pl-input" type="file" name="file" accept=".json,application/json" required />
          <span className="pl-small pl-muted" style={{ fontWeight: 400 }}>reviews.json from your own Business Profile. Up to 1,000 reviews / 1 MB. Re-importing a file is safe.</span>
        </label>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <button type="submit" className="pl-btn pl-btn-primary" disabled={busy}><Icon name="upload" size={18} />Import Takeout reviews</button>
        </div>
      </form>

      <p role="status" className="pl-toast">{message}</p>

      {result ? (
        <section aria-labelledby="import-h" className="pl-panel" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h2 id="import-h" className="pl-h2" style={{ fontSize: 18 }}>Import finished</h2>
          <p style={{ margin: 0 }}>
            {result.imported} imported · {result.duplicates} duplicates skipped
            {problems ? <> · <span style={{ color: "#A3361F", fontWeight: 600 }}>{problems} rows couldn’t be used</span></> : null}
          </p>
          {result.errors?.length ? (
            <details>
              <summary style={{ cursor: "pointer", fontWeight: 600, color: "var(--pl-green)" }}>See rows with problems</summary>
              <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>{result.errors.map(e => <li key={`${e.row}-${e.error}`}>Row {e.row}: {e.error}</li>)}</ul>
            </details>
          ) : null}
        </section>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
        <div className="pl-panel" style={{ padding: "16px 18px", background: "var(--pl-green-soft)", borderColor: "transparent" }}>
          <div style={{ fontFamily: "var(--pl-display)", fontSize: 32, fontWeight: 700, color: "var(--pl-green)" }}>{counts.ready ?? 0}</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#0A3D31" }}>Ready to become posts</div>
        </div>
        <div className="pl-panel" style={{ padding: "16px 18px" }}><div style={{ fontFamily: "var(--pl-display)", fontSize: 32, fontWeight: 700 }}>{counts.used ?? 0}</div><div className="pl-muted" style={{ fontSize: 14 }}>Already used</div></div>
        <div className="pl-panel" style={{ padding: "16px 18px" }}><div style={{ fontFamily: "var(--pl-display)", fontSize: 32, fontWeight: 700 }}>{unfit.reduce((n, s) => n + (counts[s] ?? 0), 0)}</div><div className="pl-muted" style={{ fontSize: 14 }}>Not a fit for a post</div></div>
        <div className="pl-panel" style={{ padding: "16px 18px" }}><div style={{ fontFamily: "var(--pl-display)", fontSize: 32, fontWeight: 700 }}>{total}</div><div className="pl-muted" style={{ fontSize: 14 }}>Total imported</div></div>
      </div>

      {reviews.length ? (
        <>
          <div role="group" aria-label="Filter reviews" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {filters.map(([value, label]) => (
              <button key={value} type="button" aria-pressed={filter === value} className={`pl-btn ${filter === value ? "pl-btn-dark" : ""}`} style={{ borderRadius: 22 }} onClick={() => setFilter(value)}>{label}</button>
            ))}
          </div>
          <div style={{ overflowX: "auto", borderRadius: 18, border: "1px solid var(--pl-line)", background: "var(--pl-surface)" }}>
            <table style={{ width: "100%", minWidth: 720, borderCollapse: "collapse", fontSize: 15 }}>
              <caption className="pl-small pl-muted" style={{ textAlign: "left", padding: "12px 18px 0" }}>Latest {Math.min(100, total)} of {total} reviews</caption>
              <thead>
                <tr style={{ textAlign: "left", fontSize: 13 }} className="pl-muted">
                  {["Rating", "Review", "From", "Date", "Status"].map(h => <th key={h} scope="col" style={{ padding: "12px 18px", borderBottom: "1px solid var(--pl-line)" }}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {shown.map(r => {
                  const [badge, label] = statusLabels[r.status] ?? ["pl-badge-archived", r.status];
                  return (
                    <tr key={r.id}>
                      <td style={{ padding: "14px 18px", borderBottom: "1px solid var(--pl-line-soft)", whiteSpace: "nowrap", color: "#B5650D", fontWeight: 700 }} aria-label={`${r.rating} stars`}>{stars(r.rating)}</td>
                      <td style={{ padding: "14px 18px", borderBottom: "1px solid var(--pl-line-soft)", lineHeight: 1.45, color: unfit.includes(r.status) ? "var(--pl-muted)" : undefined }}>{r.text}</td>
                      <td style={{ padding: "14px 18px", borderBottom: "1px solid var(--pl-line-soft)", whiteSpace: "nowrap" }}>{r.author_name || "Anonymous"}</td>
                      <td style={{ padding: "14px 18px", borderBottom: "1px solid var(--pl-line-soft)", whiteSpace: "nowrap" }} className="pl-muted">{new Date(r.reviewed_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</td>
                      <td style={{ padding: "14px 18px", borderBottom: "1px solid var(--pl-line-soft)" }}><span className={`pl-badge ${badge}`}>{label}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="pl-empty">
          <h2>Start with your reviews</h2>
          <p className="pl-muted">Upload a review CSV or a Google Takeout reviews.json above and we’ll make posts from the best ones.</p>
          <button type="button" className="pl-btn pl-btn-primary" onClick={() => fileInput.current?.click()}><Icon name="upload" size={16} />Choose a CSV file</button>
        </div>
      )}
    </>
  );
}
