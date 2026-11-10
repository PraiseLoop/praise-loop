"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../apiFetch";

type Business = { id: number; name: string };
type Draft = {
  id: number; version: number;
  review_id: number | null;
  quote_text: string;
  caption_text: string;
  image_path: string | null;
  status: string;
};
type CaptionSet = { friendly: string; premium: string; playful: string };

export default function QuotesPage() {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [businessId, setBusinessId] = useState("");
  const [limit, setLimit] = useState(3);
  const [message, setMessage] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [captionVariantsByDraft, setCaptionVariantsByDraft] = useState<Record<number, CaptionSet>>({});
  const [loadingDraftId, setLoadingDraftId] = useState<number | null>(null);
  const [renderingDraftId, setRenderingDraftId] = useState<number | null>(null);

  async function loadBusinesses() {
    const res = await apiFetch("/api/businesses");
    const data = await res.json();
    setBusinesses(data.businesses ?? []);
  }

  async function loadDrafts(id: string) {
    if (!id) return setDrafts([]);
    const res = await apiFetch(`/api/drafts?businessId=${id}`);
    const data = await res.json();
    setDrafts(data.drafts ?? []);
  }

  useEffect(() => {
    loadBusinesses();
  }, []);
  useEffect(() => {
    loadDrafts(businessId);
  }, [businessId]);

  async function runSelector() {
    if (!businessId) return;
    const res = await apiFetch("/api/quotes/select", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ businessId: Number(businessId), limit })
    });
    const data = await res.json();
    if (!res.ok) {
      setMessage(`Selector failed: ${data.error ?? "unknown error"}`);
      return;
    }
    setMessage(`Queued ${data.inserted} drafts: ${data.reason}. See approval for persisted progress.`);
    await loadDrafts(businessId);
  }

  async function generateCaptions(draftPostId: number) {
    setLoadingDraftId(draftPostId);
    try {
      const res = await apiFetch("/api/captions/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draftPostId, version: drafts.find(d=>d.id===draftPostId)?.version })
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(`Caption generation failed: ${data.error ?? "unknown error"}`);
        return;
      }
      setCaptionVariantsByDraft((prev) => ({ ...prev, [draftPostId]: data.captions }));
      setMessage(`Generated caption variants for draft #${draftPostId}`);
    } finally {
      setLoadingDraftId(null);
    }
  }

  async function chooseCaption(draftPostId: number, captionText: string) {
    const res = await apiFetch("/api/drafts/caption", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draftPostId, version: drafts.find(d=>d.id===draftPostId)?.version, captionText })
    });
    const data = await res.json();
    if (!res.ok) {
      setMessage(`Save caption failed: ${data.error ?? "unknown error"}`);
      return;
    }
    setMessage(`Saved caption to draft #${draftPostId}`);
    await loadDrafts(businessId);
  }

  async function renderImage(draftPostId: number) {
    setRenderingDraftId(draftPostId);
    try {
      const res = await apiFetch("/api/images/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draftPostId, version: drafts.find(d=>d.id===draftPostId)?.version })
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(`Render failed: ${data.error ?? "unknown error"}`);
        return;
      }
      setMessage(`Rendered image for draft #${draftPostId}`);
      await loadDrafts(businessId);
    } finally {
      setRenderingDraftId(null);
    }
  }

  return (
    <main style={{ fontFamily: "sans-serif", padding: 0, maxWidth: 960, minWidth: 0 }}>
      <h1>Quote selector + caption generation</h1>
      <p>Deterministic quote ranking + AI captions + branded image render.</p>

      <section style={{ marginBottom: 16, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <select className="pl-select" style={{ minWidth: 0, maxWidth: "100%" }} value={businessId} onChange={(e) => setBusinessId(e.target.value)}>
          <option value="">Select business…</option>
          {businesses.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>

        <input
          className="pl-input"
          type="number"
          min={1}
          max={5}
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value) || 3)}
          style={{ width: 88 }}
        />

        <button className="pl-btn pl-btn-primary" onClick={runSelector} disabled={!businessId}>
          Generate candidates
        </button>
      </section>

      {message ? (
        <p>
          <strong>{message}</strong>
        </p>
      ) : null}

      <section>
        <h2>Persisted draft candidates</h2>
        <ul>
          {drafts.map((d) => {
            const variants = captionVariantsByDraft[d.id];
            return (
              <li key={d.id} style={{ marginBottom: 20 }}>
                <div>
                  #{d.id} [{d.status}] {d.quote_text}
                </div>
                <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <button
                    className="pl-btn"
                    onClick={() => generateCaptions(d.id)}
                    disabled={loadingDraftId === d.id}
                  >
                    {loadingDraftId === d.id ? "Generating..." : "Generate captions"}
                  </button>
                  <button
                    className="pl-btn"
                    onClick={() => renderImage(d.id)}
                    disabled={renderingDraftId === d.id}
                  >
                    {renderingDraftId === d.id ? "Rendering..." : "Render image"}
                  </button>
                </div>

                {variants ? (
                  <ul>
                    {([
                      ["friendly", variants.friendly],
                      ["premium", variants.premium],
                      ["playful", variants.playful]
                    ] as const).map(([style, text]) => (
                      <li key={style} style={{ marginTop: 6 }}>
                        <strong>{style}:</strong> {text}{" "}
                        <button className="pl-btn pl-small" onClick={() => chooseCaption(d.id, text)} style={{ marginLeft: 8 }}>
                          Use this
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {d.caption_text ? (
                  <div style={{ marginTop: 6 }}>
                    <em>Saved caption:</em> {d.caption_text}
                  </div>
                ) : null}

                {d.image_path ? (
                  <div style={{ marginTop: 8 }}>
                    <img src={d.image_path} alt={`Draft ${d.id} graphic`} style={{ width: 240, maxWidth: "100%", height: "auto", border: "1px solid #ddd" }} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}
