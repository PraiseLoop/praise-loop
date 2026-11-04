// Pure helpers for the Schedule page's "lined up" view (#206): which drafts hold a slot,
// which show a past posting result, and the order the slot tiles appear in. No fetch, no DOM.
import { postingView, type PostingDraft } from "./postingView";

export type LineupDraft = PostingDraft & { id: number; version: number; quote_text: string };

// A post that holds (or is waiting on) its slot: the worker has not finished with it.
const HOLDING = new Set(["queued", "submitting", "submitted", "unknown"]);

export function holdsSlot(draft: LineupDraft): boolean {
  return draft.status === "scheduled" && !!draft.scheduled_for && HOLDING.has(String(draft.provider_state));
}

/** Posts that have an outcome to show (posted, saved as a Buffer draft, or not posted), newest first. */
export function recentResults(drafts: LineupDraft[]): LineupDraft[] {
  return drafts
    .filter(d => !holdsSlot(d) && postingView(d) !== null && ["published", "approved", "failed"].includes(String(d.status)))
    .sort((a, b) => String(b.posting_sent_at ?? b.scheduled_for ?? "").localeCompare(String(a.posting_sent_at ?? a.scheduled_for ?? "")))
    .slice(0, 5);
}

/** The drafts API returns Postgres text timestamps ("2026-11-04 14:17:00+00"); make them ISO so Date parses them everywhere. */
export function toIso(value: string): string | null {
  const text = value.trim().replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const time = new Date(text).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export type Tile = { instant: string; draft: LineupDraft | null };

/** Open slots and the slots that already hold a post, in time order, so a taken slot stays visible. */
export function slotTiles(openSlots: string[], lined: LineupDraft[]): Tile[] {
  const taken: Tile[] = [];
  for (const draft of lined.filter(holdsSlot)) {
    const instant = toIso(draft.scheduled_for!);
    if (instant) taken.push({ instant, draft });
  }
  const open: Tile[] = openSlots.map(instant => ({ instant, draft: null }));
  return [...taken, ...open].sort((a, b) => a.instant.localeCompare(b.instant));
}
