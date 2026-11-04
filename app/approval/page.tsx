"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../apiFetch";
import { useBusiness } from "../AppShell";
import Icon from "../ui/Icon";
import PostingBanner from "../ui/PostingBanner";
import { usePlan } from "../ui/usePlan";
import { weekLimitNotice } from "../../lib/planDisplay";
import PostCard, { stageOf, type Draft, type Stage } from "./PostCard";

const conflict = "This post changed somewhere else. We loaded the latest version — try again.";

function weekOf(now = new Date()) {
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  return monday.toLocaleDateString(undefined, { month: "long", day: "numeric" });
}

function plural(count: number, word: string) { return `${count} ${word}${count === 1 ? "" : "s"}`; }

export default function ThisWeekPage() {
  const { business, status } = useBusiness();
  const businessId = business?.id;
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const { plan } = usePlan();

  const load = useCallback(async (id: number | string) => {
    const res = await apiFetch(`/api/drafts?businessId=${id}`);
    if (!res.ok) return;
    const data = await res.json();
    setDrafts(data.drafts ?? []);
  }, []);

  useEffect(() => {
    setDrafts(null);
    if (!businessId) return;
    void load(businessId);
    const timer = setInterval(() => void load(businessId), 3000);
    return () => clearInterval(timer);
  }, [businessId, load]);

  const groups = useMemo(() => {
    const by: Record<Stage, Draft[]> = { making: [], failed: [], ready: [], approved: [], scheduled: [], shared: [], archived: [] };
    for (const d of drafts ?? []) by[stageOf(d)].push(d);
    return by;
  }, [drafts]);

  async function run(path: string, draft: Draft, extra: Record<string, unknown> = {}) {
    setBusy(true);
    try {
      const response = await apiFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ draftPostId: draft.id, version: draft.version, ...extra }) });
      const data = await response.json();
      if (response.ok) {
        const done: Record<string, string> = {
          "/api/drafts/caption": "Caption saved",
          "/api/generation/regenerate": "Making a new version — it’ll appear here shortly",
          "/api/generation/retry": "Trying again — it’ll appear here shortly",
          "/api/posting-slots/cancel": "Cancelled. It’s back in Approved.",
          "/api/posting-slots/resolve": "Thanks — noted."
        };
        setMessage(path === "/api/drafts/status"
          ? { approved: "Approved", archived: "Skipped. You can bring it back below.", draft: "Moved back to review" }[String(extra.status)] ?? "Saved"
          : done[path] ?? data.message ?? "Saved");
      } else {
        setMessage(data.error === "Draft changed; refresh and retry" ? conflict : data.error ?? "That didn’t work — try again");
      }
      return response.ok;
    } catch {
      setMessage("Connection problem — check your internet and try again");
      return false;
    } finally {
      if (businessId) await load(businessId);
      setBusy(false);
    }
  }

  async function approveAll() {
    setBusy(true);
    try {
      const items = groups.ready.map(d => ({ draftPostId: d.id, version: d.version }));
      const response = await apiFetch("/api/drafts/bulk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items }) });
      const data = await response.json();
      if (!data.results) { setMessage(data.error ?? "That didn’t work — try again"); return; }
      const results = data.results as { draftPostId: number; status: number; error?: string }[];
      const approved = results.filter(r => r.status === 200).length, failed = results.length - approved;
      setMessage(`Approved ${plural(approved, "post")}${failed ? `. ${plural(failed, "post")} couldn’t be approved: ${results.filter(r => r.status !== 200).map(r => r.error).join("; ")}` : ""}`);
    } catch {
      setMessage("Connection problem — check your internet and try again");
    } finally {
      if (businessId) await load(businessId);
      setBusy(false);
    }
  }

  if (status === "loading" || (business && drafts === null)) return <p className="pl-muted" role="status">Loading your posts…</p>;
  if (!business) {
    return (
      <div className="pl-empty">
        <h2>Let’s set up your business</h2>
        <p className="pl-muted">Add your brand and reviews, and we’ll make your first posts.</p>
        <Link href="/onboarding" className="pl-btn pl-btn-primary pl-btn-lg">Get started</Link>
      </div>
    );
  }

  const ready = groups.ready.length, pending = groups.making.length + groups.failed.length;
  const active = [...groups.ready, ...groups.failed, ...groups.making, ...groups.approved];
  const title = ready ? `${plural(ready, "post")} need${ready === 1 ? "s" : ""} your OK`
    : pending ? "Your posts are on the way"
    : groups.approved.length ? "You’re set for this week"
    : "Nothing to review yet";
  // The server owns the limits; when this week's quota is used up, name the plan limit.
  const usage = plan?.usage.find(u => String(u.businessId) === String(business.id));
  const limitNote = plan ? weekLimitNotice(plan, usage) : null;

  return (
    <>
      <header className="pl-header">
        <div className="pl-header-text">
          <span className="pl-eyebrow">Week of {weekOf()}</span>
          <h1 className="pl-title">{title}</h1>
          <p className="pl-lede">Made from reviews your customers left. Approve the ones you like and they’ll be lined up in your schedule.</p>
        </div>
        {ready > 1 ? (
          <button type="button" className="pl-btn pl-btn-primary pl-btn-lg" disabled={busy} onClick={() => void approveAll()}>
            <Icon name="check" size={18} strokeWidth={2.4} />Approve all {ready}
          </button>
        ) : null}
      </header>

      <p role="status" className="pl-toast">{message}</p>

      {limitNote && active.length ? <p className="pl-small pl-muted" style={{ margin: 0 }}>{limitNote} <Link href="/account">See your plan</Link></p> : null}

      <PostingBanner key={business.id} businessId={business.id} />

      {active.length ? (
        <section aria-label="Posts for this week" className="pl-grid">
          {active.map(d => <PostCard key={d.id} draft={d} run={run} busy={busy} />)}
        </section>
      ) : !groups.scheduled.length && !groups.shared.length && !limitNote ? (
        <div className="pl-empty">
          <h2>Your next posts start with reviews</h2>
          <p className="pl-muted">We make new posts from your reviews each week. Add more reviews to keep them coming.</p>
          <Link href="/reviews" className="pl-btn pl-btn-primary"><Icon name="upload" size={16} />Add reviews</Link>
        </div>
      ) : (
        <div className="pl-empty done">
          <h2>{limitNote ? "You’ve reached this week’s limit" : "You’re all caught up"}</h2>
          <p>{limitNote ?? "Everything is approved, scheduled or shared. New posts arrive next week."}</p>
          {limitNote ? <p><Link href="/account">See your plan</Link></p> : null}
        </div>
      )}

      {groups.scheduled.length ? (
        <section aria-labelledby="scheduled-h" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <h2 id="scheduled-h" className="pl-h2">Scheduled</h2>
          <div className="pl-grid">{groups.scheduled.map(d => <PostCard key={d.id} draft={d} run={run} busy={busy} />)}</div>
        </section>
      ) : null}

      {groups.shared.length ? (
        <section aria-labelledby="shared-h" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <h2 id="shared-h" className="pl-h2">Shared by you</h2>
          <div className="pl-grid">{groups.shared.map(d => <PostCard key={d.id} draft={d} run={run} busy={busy} />)}</div>
        </section>
      ) : null}

      {groups.archived.length ? (
        <details className="pl-panel">
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>Skipped posts ({groups.archived.length})</summary>
          <ul style={{ listStyle: "none", padding: 0, margin: "16px 0 0", display: "flex", flexDirection: "column", gap: 12 }}>
            {groups.archived.map(d => (
              <li key={d.id} style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
                <span className="pl-muted">“{d.quote_text}” — {d.author_name || "a customer"}</span>
                <button type="button" className="pl-btn" disabled={busy} onClick={() => void run("/api/drafts/status", d, { status: "draft" })}><Icon name="undo" size={16} />Bring it back</button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}
