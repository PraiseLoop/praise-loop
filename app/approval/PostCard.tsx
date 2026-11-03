"use client";
import { useEffect, useState } from "react";
import Icon from "../ui/Icon";
import { postingView } from "../../lib/posting/postingView";

export type Draft = {
  id: number; version: number;
  rating?: number | null; author_name?: string | null; reviewed_at?: string | null; source?: string | null; source_url?: string | null;
  provider_state?: string | null; job_state?: string | null; error_code?: string | null;
  posting_mode?: string | null; posting_error_code?: string | null; posting_link?: string | null; posting_sent_at?: string | null;
  review_id: number | null;
  quote_text: string;
  caption_text: string;
  image_path: string | null;
  status: string;
  scheduled_for?: string | null;
  shared_at?: string | null;
  created_at: string;
};

export type Stage = "making" | "failed" | "ready" | "approved" | "scheduled" | "shared" | "archived";
export type Action = (path: string, draft: Draft, extra?: Record<string, unknown>) => Promise<boolean>;

export function stageOf(draft: Draft): Stage {
  if (draft.status === "archived") return "archived";
  if (draft.status === "shared") return "shared";
  if (["scheduled", "published"].includes(draft.status)) return "scheduled";
  if (["pending", "running", "retry"].includes(draft.job_state ?? "")) return "making";
  if (draft.status === "failed" || draft.job_state === "failed") return "failed";
  if (draft.status === "approved") return "approved";
  return draft.caption_text.trim() && draft.image_path ? "ready" : "making";
}

const badges: Record<Stage, [string, string]> = {
  making: ["pl-badge-making", "Making this post"],
  failed: ["pl-badge-failed", "Needs attention"],
  ready: ["pl-badge-ready", "Ready for review"],
  approved: ["pl-badge-approved", "Approved"],
  scheduled: ["pl-badge-scheduled", "Scheduled"],
  shared: ["pl-badge-approved", "Shared by you"],
  archived: ["pl-badge-archived", "Skipped"]
};

const making: Record<string, string> = {
  pending: "Waiting its turn…",
  running: "Writing the caption and designing the image…",
  retry: "Hit a snag — trying again automatically…"
};

const failures: Record<string, string> = {
  worker_interrupted: "We were interrupted while making this post.",
  daily_limit: "You’ve reached today’s limit for making posts.",
  caption_empty: "The caption writer came back empty.",
  draft_not_editable: "This post changed while we were working on it.",
  generation_failed: "We couldn’t finish the caption or image.",
  archived: "This post was skipped before it was finished."
};

function reviewLine(draft: Draft) {
  const who = draft.author_name || "a customer";
  const stars = draft.rating ? `${draft.rating}-star ` : "";
  const when = draft.reviewed_at ? ` · ${new Date(draft.reviewed_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}` : "";
  return `From ${who}’s ${stars}review${when}`;
}

export default function PostCard({ draft, run, busy }: { draft: Draft; run: Action; busy: boolean }) {
  const stage = stageOf(draft);
  const [caption, setCaption] = useState(draft.caption_text);
  const [editing, setEditing] = useState(false);
  useEffect(() => setCaption(draft.caption_text), [draft.caption_text]);
  const changed = caption !== draft.caption_text;
  const editable = stage === "ready" || (stage === "approved" && editing);
  const [badgeClass, badgeText] = badges[stage];
  const posting = postingView(draft);

  async function saveCaption() {
    if (await run("/api/drafts/caption", draft, { captionText: caption })) setEditing(false);
  }

  return (
    <article className="pl-card" aria-label={`Post #${draft.id} from ${draft.author_name || "a customer"}`}>
      <div className="pl-card-media">
        {draft.image_path && stage !== "making" ? (
          <img src={draft.image_path} alt={`Quote card: ${draft.quote_text}`} />
        ) : stage === "failed" ? (
          <div className="pl-card-placeholder failed"><Icon name="alert" size={40} strokeWidth={1.8} />No image yet</div>
        ) : (
          <div className="pl-card-placeholder making" aria-hidden="true" />
        )}
      </div>
      <div className="pl-card-body">
        <div className="pl-card-meta">
          <span className={`pl-badge ${badgeClass}`}>{stage === "approved" ? <Icon name="check" size={13} strokeWidth={3} /> : null}{badgeText}</span>
          {draft.scheduled_for ? <span className="pl-small pl-muted">{new Date(draft.scheduled_for).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span> : null}
        </div>

        {stage === "making" ? <p className="pl-caption-text pl-muted">{making[draft.job_state ?? ""] ?? "Getting this post ready…"}</p> : null}
        {stage === "failed" && !posting ? (
          <p className="pl-caption-text">
            {failures[draft.error_code ?? ""] ?? "Something went wrong making this post."} Your quote is saved — try again.
            {draft.error_code ? <span className="pl-small pl-muted" style={{ display: "block", marginTop: 4 }}>Error code: {draft.error_code}</span> : null}
          </p>
        ) : null}

        {editable ? (
          <label className="pl-field">
            <span className="pl-muted pl-small">Caption</span>
            <textarea className="pl-textarea" rows={4} maxLength={200} aria-label={`Caption for draft ${draft.id}`} value={caption} onChange={e => setCaption(e.target.value)} />
          </label>
        ) : ["approved", "scheduled", "shared"].includes(stage) ? <p className="pl-caption-text">{draft.caption_text}</p> : null}

        {stage !== "making" ? (
          <details className="pl-review">
            <summary>{reviewLine(draft)}</summary>
            <p>“{draft.quote_text}”</p>
            {draft.source_url ? <p><a href={draft.source_url} target="_blank" rel="noreferrer">Open original review</a></p> : null}
          </details>
        ) : null}

        {posting ? (
          <div role="status">
            <p className="pl-caption-text"><strong>{posting.headline}</strong></p>
            {posting.detail ? <p className="pl-small pl-muted">{posting.detail}</p> : null}
            {posting.link ? <p className="pl-small"><a href={posting.link} target="_blank" rel="noreferrer">See the post</a></p> : null}
          </div>
        ) : null}

        <div className="pl-card-actions">
          {posting?.actions.includes("cancel") ? (
            <button type="button" className="pl-btn pl-grow" disabled={busy} onClick={() => void run("/api/posting-slots/cancel", draft)}>Cancel scheduling</button>
          ) : null}
          {posting?.actions.includes("posted") ? (
            <button type="button" className="pl-btn pl-grow" disabled={busy} onClick={() => void run("/api/posting-slots/resolve", draft, { outcome: "posted" })}>It was posted</button>
          ) : null}
          {posting?.actions.includes("not_posted") ? (
            <button type="button" className="pl-btn pl-grow" disabled={busy} onClick={() => void run("/api/posting-slots/resolve", draft, { outcome: "not_posted" })}>It wasn’t posted</button>
          ) : null}
          {posting?.actions.includes("approve_again") ? (
            <button type="button" className="pl-btn pl-btn-primary pl-grow" disabled={busy} onClick={() => void run("/api/drafts/status", draft, { status: "approved" })}>Approve again</button>
          ) : null}
          {editable && changed ? (
            <>
              <button type="button" className="pl-btn pl-btn-primary pl-grow" disabled={busy || !caption.trim()} onClick={() => void saveCaption()}>Save caption</button>
              <button type="button" className="pl-btn" disabled={busy} onClick={() => { setCaption(draft.caption_text); setEditing(false); }}>Cancel</button>
            </>
          ) : stage === "ready" ? (
            <button type="button" className="pl-btn pl-btn-primary pl-grow" disabled={busy} onClick={() => void run("/api/drafts/status", draft, { status: "approved" })}><Icon name="check" size={16} strokeWidth={2.4} />Approve</button>
          ) : stage === "approved" && !editing ? (
            <>
              <button type="button" className="pl-btn pl-grow" disabled={busy} onClick={() => setEditing(true)}>Edit caption</button>
              <button type="button" className="pl-btn" disabled={busy} onClick={() => void run("/api/drafts/status", draft, { status: "draft" })}>Unapprove</button>
            </>
          ) : stage === "failed" && draft.job_state === "failed" ? (
            <button type="button" className="pl-btn pl-btn-dark pl-grow" disabled={busy} onClick={() => void run("/api/generation/retry", draft)}><Icon name="refresh" size={16} />Try again</button>
          ) : null}
          {["ready", "failed"].includes(stage) && !changed ? (
            <button type="button" className="pl-btn pl-btn-icon" aria-label="Make a new version" title="Make a new version" disabled={busy} onClick={() => void run("/api/generation/regenerate", draft)}><Icon name="refresh" size={18} /></button>
          ) : null}
          {["ready", "failed", "making", "approved"].includes(stage) && !changed && !editing ? (
            <button type="button" className="pl-btn pl-btn-icon" aria-label="Skip this post" title="Skip this post" disabled={busy} onClick={() => void run("/api/drafts/status", draft, { status: "archived" })}><Icon name="archive" size={18} /></button>
          ) : null}
        </div>
      </div>
    </article>
  );
}
