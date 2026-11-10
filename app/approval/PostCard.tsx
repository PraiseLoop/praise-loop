"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "../apiFetch";
import Icon from "../ui/Icon";
import { postingView } from "../../lib/posting/postingView";
import {
  confirmShared,
  declineShared,
  fallbackCopy,
  fallbackDownload,
  FALLBACK_HINT,
  markShared,
  PASTE_HINT,
  prepareShare,
  SHARED_HINT,
  type ShareImage,
  type ShareOutcome,
  type WebShareDeps,
  type WebShareState
} from "../../lib/posting/webShare";

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
export type RunResult = {
  ok: boolean;
  status: number;
  data: { draft?: Draft; error?: string; message?: string; [key: string]: unknown };
};
export type Action = (path: string, draft: Draft, extra?: Record<string, unknown>) => Promise<RunResult>;

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

  // Web Share API (#274). The PNG is fetched as soon as an approved card
  // renders so the Post button can call navigator.share immediately on click;
  // iOS Safari rejects a share that happens after a long await.
  const [shareSupported, setShareSupported] = useState<boolean | null>(null);
  const [shareState, setShareState] = useState<WebShareState>({ step: "idle" });
  const [shareImage, setShareImage] = useState<ShareImage | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [prefetchAttempt, setPrefetchAttempt] = useState(0);
  const [sharing, setSharing] = useState(false);

  useEffect(() => {
    try {
      if (typeof navigator === "undefined" || typeof navigator.canShare !== "function" || typeof navigator.share !== "function") {
        setShareSupported(false);
        return;
      }
      const probe = new File([new Blob([""], { type: "image/png" })], "probe.png", { type: "image/png" });
      setShareSupported(navigator.canShare({ files: [probe] }));
    } catch {
      setShareSupported(false);
    }
  }, []);

  useEffect(() => {
    if (!shareSupported || stage !== "approved" || !draft.image_path) {
      setShareImage(null);
      setImageLoading(false);
      return;
    }
    let cancelled = false;
    setImageLoading(true);
    apiFetch(draft.image_path)
      .then(async response => {
        if (!response.ok) throw new Error("image");
        return response.blob();
      })
      .then(blob => { if (!cancelled) setShareImage({ blob, filename: `praiseloop-${draft.id}.png` }); })
      .catch(() => { if (!cancelled) setShareImage(null); })
      .finally(() => { if (!cancelled) setImageLoading(false); });
    return () => { cancelled = true; };
  }, [shareSupported, stage, draft.id, draft.image_path, draft.version, prefetchAttempt]);

  // A version change means the draft moved on (or was edited elsewhere): the
  // confirmation question is about the old version, so start over.
  useEffect(() => { setShareState({ step: "idle" }); }, [draft.version, draft.status]);

  const shareDeps: WebShareDeps = {
    canShare: () => shareSupported === true,
    loadImage: async () => {
      if (!shareImage) throw new Error("image not ready");
      return shareImage;
    },
    copyCaption: async text => {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
    },
    share: async (item): Promise<ShareOutcome> => {
      const file = new File([item.blob], item.filename, { type: "image/png" });
      try {
        await navigator.share({ files: [file] });
        return "shared";
      } catch (error) {
        // AbortError is the owner closing the sheet; anything else is a failure.
        if (typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError") return "cancelled";
        throw error;
      }
    },
    downloadImage: async item => {
      if (!item.image_path) throw new Error("no image");
      const response = await apiFetch(item.image_path);
      if (!response.ok) throw new Error("download");
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `praiseloop-${item.id}.png`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    },
    markShared: async item => {
      const result = await run("/api/drafts/status", { ...draft, ...item }, { status: "shared" });
      if (result.ok) return { ok: true, draft: result.data.draft ?? { ...item, status: "shared" } };
      if (result.status === 409) return { ok: false, reason: "conflict" };
      if (result.status === 401) return { ok: false, reason: "signedOut" };
      return { ok: false, reason: "generic" };
    }
  };

  async function startShare() {
    setSharing(true);
    setShareState({ step: "preparing" });
    try {
      setShareState(await prepareShare(draft, shareDeps));
    } finally {
      setSharing(false);
    }
  }

  async function answerPosted() {
    setSharing(true);
    try {
      setShareState(await confirmShared(shareState, shareDeps));
    } finally {
      setSharing(false);
    }
  }

  async function downloadFallback() {
    setSharing(true);
    try {
      setShareState(await fallbackDownload(draft, shareDeps));
    } finally {
      setSharing(false);
    }
  }

  async function copyFallback() {
    setSharing(true);
    try {
      setShareState(await fallbackCopy(draft, shareDeps));
    } finally {
      setSharing(false);
    }
  }

  async function markFallbackPosted() {
    setSharing(true);
    try {
      setShareState(await markShared(draft, shareDeps));
    } finally {
      setSharing(false);
    }
  }

  async function saveCaption() {
    if ((await run("/api/drafts/caption", draft, { captionText: caption })).ok) setEditing(false);
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

        {stage === "approved" && shareSupported !== null ? (
          <div role="group" aria-label="Post this draft">
            {shareState.step === "confirm" ? (
              <>
                <p className="pl-caption-text"><strong>Did you post it?</strong></p>
                <p className="pl-small pl-muted">{SHARED_HINT}</p>
                <div className="pl-card-actions">
                  <button type="button" className="pl-btn pl-btn-primary pl-grow" disabled={busy || sharing} onClick={() => void answerPosted()}>Yes, I posted it</button>
                  <button type="button" className="pl-btn" disabled={busy || sharing} onClick={() => setShareState(declineShared())}>No, not yet</button>
                </div>
              </>
            ) : (
              <>
                <p className="pl-small pl-muted">{shareSupported ? PASTE_HINT : FALLBACK_HINT}</p>
                {shareState.step === "error" ? <p className="pl-small pl-error" role="status">{shareState.message}</p> : null}
                {shareState.step === "fallback" && shareState.notice ? <p className="pl-small" role="status">{shareState.notice}</p> : null}
                {shareState.step === "done" ? <p className="pl-small" role="status">Marked as posted.</p> : null}
                <div className="pl-card-actions">
                  {shareSupported ? (
                    <>
                      <button type="button" className="pl-btn pl-btn-primary pl-grow" disabled={busy || sharing || !shareImage} onClick={() => void startShare()}>
                        {imageLoading ? "Getting the image ready…" : "Post"}
                      </button>
                      {!shareImage && !imageLoading ? (
                        <button type="button" className="pl-btn" disabled={busy || sharing} onClick={() => setPrefetchAttempt(n => n + 1)}>Try loading the image again</button>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <button type="button" className="pl-btn pl-grow" disabled={busy || sharing} onClick={() => void downloadFallback()}>Download image</button>
                      <button type="button" className="pl-btn pl-grow" disabled={busy || sharing} onClick={() => void copyFallback()}>Copy caption</button>
                      <button type="button" className="pl-btn pl-btn-primary pl-grow" disabled={busy || sharing} onClick={() => void markFallbackPosted()}>Mark as posted</button>
                    </>
                  )}
                </div>
              </>
            )}
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
