"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../apiFetch";
import { useBusiness } from "../AppShell";
import PostingBanner from "../ui/PostingBanner";
import PostingSlots from "./PostingSlots";
import type { LineupDraft } from "../../lib/posting/lineup";

type Draft = LineupDraft & { author_name?: string | null; status: string };

export default function SchedulePage() {
  const { business, status } = useBusiness();
  const businessId = business?.id;
  const [drafts, setDrafts] = useState<Draft[]>([]);

  const load = useCallback(async (id: number | string, isCurrent: () => boolean = () => true) => {
    const response = await apiFetch(`/api/drafts?businessId=${id}`);
    if (!response.ok || !isCurrent()) return;
    setDrafts((await response.json()).drafts ?? []);
  }, []);
  useEffect(() => {
    setDrafts([]);
    if (!businessId) return;
    let current = true;
    void load(businessId, () => current);
    // The worker moves posts along on its own, so keep the statuses fresh.
    const timer = setInterval(() => void load(businessId, () => current), 5000);
    return () => { current = false; clearInterval(timer); };
  }, [businessId, load]);

  if (status === "loading") return <p className="pl-muted" role="status">Loading your schedule…</p>;
  if (!business) return <div className="pl-empty"><h2>Set up your business first</h2><Link href="/onboarding" className="pl-btn pl-btn-primary">Get started</Link></div>;

  return (
    <>
      <header className="pl-header">
        <div className="pl-header-text">
          <h1 className="pl-title">Schedule</h1>
          <p className="pl-lede">Approved posts fill your next open times. Times are in {business.timezone}.</p>
        </div>
      </header>

      <PostingBanner key={business.id} businessId={business.id} />

      <PostingSlots key={business.id} businessId={business.id} approved={drafts.filter(d => d.status === "approved")} drafts={drafts} onAssigned={() => void load(business.id)} />
    </>
  );
}
