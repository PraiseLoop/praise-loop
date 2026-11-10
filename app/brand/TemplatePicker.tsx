"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "../apiFetch";
import { QUOTE_TEMPLATES, QUOTE_TEMPLATE_NAMES, type QuoteTemplate } from "../../lib/branding";

type Props = {
  value: QuoteTemplate;
  onChange: (template: QuoteTemplate) => void;
  primary: string;
  secondary: string;
  quoteSize: "standard" | "large";
  tone: string;
  /** How many designs the effective plan includes; the rest stay visible but locked. */
  allowed: number;
};

// Each option is rendered by the production previewer, so the picker shows the
// real design with the colours and text size currently on the form.
export default function TemplatePicker({ value, onChange, primary, secondary, quoteSize, tone, allowed }: Props) {
  const [previews, setPreviews] = useState<Partial<Record<QuoteTemplate, string>>>({});
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const urls: string[] = [];
    const timer = setTimeout(async () => {
      try {
        const next: Partial<Record<QuoteTemplate, string>> = {};
        for (const template of QUOTE_TEMPLATES) {
          const response = await apiFetch("/api/branding/preview", {
            method: "POST",
            signal: controller.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ brandTone: tone, brandColors: { primary, secondary, template, quoteSize } })
          });
          if (!response.ok) throw new Error("Preview unavailable");
          const url = URL.createObjectURL(await response.blob());
          urls.push(url);
          next[template] = url;
        }
        if (controller.signal.aborted) return;
        setPreviews(previous => {
          for (const url of Object.values(previous)) if (url) URL.revokeObjectURL(url);
          return next;
        });
        setError("");
      } catch {
        if (!controller.signal.aborted) setError("Design previews are unavailable. Check your connection and try again.");
      }
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [primary, secondary, quoteSize, tone]);

  const savedChoiceLocked = QUOTE_TEMPLATES.indexOf(value) >= allowed;
  return (
    <fieldset style={{ margin: 0, padding: 0, border: 0 }}>
      <legend style={{ padding: 0, marginBottom: 10, fontSize: 14, fontWeight: 600 }}>Quote-card design</legend>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 140px), 1fr))", gap: 10 }}>
        {QUOTE_TEMPLATES.map((template, index) => {
          const available = index < allowed;
          const selected = value === template;
          return (
            <button
              key={template}
              type="button"
              aria-pressed={selected}
              disabled={!available}
              onClick={() => { if (available) onChange(template); }}
              style={{
                display: "flex", flexDirection: "column", gap: 8, padding: 8, borderRadius: 12, textAlign: "left",
                border: selected ? "2px solid var(--pl-green)" : "1px solid var(--pl-field-line)",
                background: selected ? "var(--pl-green-soft)" : "var(--pl-surface)",
                cursor: available ? "pointer" : "not-allowed", opacity: available ? 1 : 0.55
              }}
            >
              <span style={{ aspectRatio: "1 / 1", display: "block", overflow: "hidden", borderRadius: 8, background: "var(--pl-line-soft)" }}>
                {previews[template]
                  ? <img src={previews[template]} alt={`${QUOTE_TEMPLATE_NAMES[template]} design preview`} width={1080} height={1080} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                  : <span className="pl-small pl-muted" style={{ display: "flex", height: "100%", alignItems: "center", justifyContent: "center" }}>Preview</span>}
              </span>
              <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                <span style={{ fontWeight: 600 }}>{QUOTE_TEMPLATE_NAMES[template]}</span>
                <span className="pl-small pl-muted" style={{ whiteSpace: "nowrap" }}>{available ? (index === 0 ? "Free" : "Pro") : "Pro"}</span>
              </span>
            </button>
          );
        })}
      </div>
      {error ? <p role="status" className="pl-small" style={{ margin: "8px 0 0" }}>{error}</p> : null}
      {savedChoiceLocked ? (
        <p className="pl-small pl-muted" style={{ margin: "8px 0 0" }}>
          Your saved {QUOTE_TEMPLATE_NAMES[value]} design needs a paid plan. It stays saved, but new posts use the Classic design until the plan allows it again.
        </p>
      ) : null}
    </fieldset>
  );
}
