"use client";
import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import { apiFetch } from "../apiFetch";
import { useBusiness } from "../AppShell";
import BrandPreview from "./BrandPreview";
import TemplatePicker from "./TemplatePicker";
import { ColorPicker, readLogo, timezones, TonePicker, type BrandTone } from "./options";
import { usePlan } from "../ui/usePlan";
import { planName } from "../../lib/planDisplay";
import { isQuoteTemplate, QUOTE_TEMPLATES, QUOTE_TEMPLATE, templateWithinLimit, type QuoteTemplate } from "../../lib/branding";

export default function BrandPage() {
  const { business, status, reload } = useBusiness();
  const [name, setName] = useState(""), [timezone, setTimezone] = useState("America/Toronto");
  const [primary, setPrimary] = useState("#1f2937"), [secondary, setSecondary] = useState("#374151");
  const [tone, setTone] = useState<BrandTone>("friendly"), [quoteSize, setQuoteSize] = useState<"standard" | "large">("standard");
  const [template, setTemplate] = useState<QuoteTemplate>(QUOTE_TEMPLATE);
  const [logo, setLogo] = useState(""), [weeklyTarget, setWeeklyTarget] = useState(3);
  const [voice, setVoice] = useState(""), [voiceUrl, setVoiceUrl] = useState("");
  const [voiceBusy, setVoiceBusy] = useState(false), [voiceMessage, setVoiceMessage] = useState("");
  // What the server holds. The voice actions update it from their own responses instead of reloading the
  // business, which would repopulate (and so discard unsaved edits to) the rest of the form.
  const [storedVoice, setStoredVoice] = useState<string | null>(null), [voiceSource, setVoiceSource] = useState<string | null>(null);
  const [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const { plan } = usePlan();
  // The business on screen now, and what each business's voice is after this page changed it. AppShell
  // keeps the business objects it loaded, so switching away and back would otherwise show the old voice,
  // and a response for a business the owner has since left must not touch the editor now showing another.
  const activeBusinessId = useRef<string | null>(null);
  const voiceOverrides = useRef<Record<string, { voice: string | null; source: string | null }>>({});

  function applyVoice(businessId: string, nextVoice: string | null, nextSource: string | null) {
    voiceOverrides.current[businessId] = { voice: nextVoice, source: nextSource };
    if (activeBusinessId.current !== businessId) return;
    setVoice(nextVoice ?? "");
    setVoiceUrl(nextSource ?? "");
    setStoredVoice(nextVoice);
    setVoiceSource(nextSource);
  }

  useEffect(() => {
    if (!business) return;
    activeBusinessId.current = String(business.id);
    const changed = voiceOverrides.current[String(business.id)];
    const shownVoice = changed ? changed.voice : business.brand_voice ?? null;
    const shownSource = changed ? changed.source : business.brand_voice_source_url ?? null;
    setName(business.name);
    setTimezone(business.timezone || "America/Toronto");
    setPrimary(business.brand_colors.primary);
    setSecondary(business.brand_colors.secondary);
    setTone((business.brand_tone as BrandTone) ?? "friendly");
    setQuoteSize(business.brand_colors.quoteSize === "large" ? "large" : "standard");
    setTemplate(isQuoteTemplate(business.brand_colors.template) ? business.brand_colors.template : QUOTE_TEMPLATE);
    setLogo(business.logo_url ?? "");
    setWeeklyTarget(business.weekly_target ?? 3);
    setVoice(shownVoice ?? "");
    setVoiceUrl(shownSource ?? "");
    setStoredVoice(shownVoice);
    setVoiceSource(shownSource);
    setMessage("");
    setVoiceMessage("");
    setVoiceBusy(false);
  }, [business]);

  async function learnVoice() {
    if (!business || !voiceUrl.trim()) return;
    setVoiceBusy(true);
    setVoiceMessage("");
    try {
      const response = await apiFetch(`/api/businesses/${business.id}/brand-voice`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: voiceUrl.trim() })
      });
      const data = await response.json().catch(() => null);
      if (activeBusinessId.current !== String(business.id)) {
        if (response.ok) applyVoice(String(business.id), data?.voice ?? null, data?.sourceUrl ?? null);
        return;
      }
      if (!response.ok) { setVoiceMessage(`Couldn’t learn your voice: ${data?.error ?? "unknown error"}`); return; }
      applyVoice(String(business.id), data.voice ?? null, data.sourceUrl ?? null);
      setVoiceMessage("Voice learned and saved. Edit it if you like, then save again.");
    } catch {
      if (activeBusinessId.current === String(business.id)) setVoiceMessage("Connection problem — nothing was saved. Try again.");
    } finally { if (activeBusinessId.current === String(business.id)) setVoiceBusy(false); }
  }

  async function saveVoice() {
    if (!business) return;
    const trimmed = voice.trim();
    if (!trimmed) { setVoiceMessage("Enter a voice profile or reset to the tone setting."); return; }
    setVoiceBusy(true);
    setVoiceMessage("");
    try {
      const response = await apiFetch(`/api/businesses/${business.id}/brand-voice`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ voice: trimmed })
      });
      const data = await response.json().catch(() => null);
      if (activeBusinessId.current !== String(business.id)) {
        if (response.ok) applyVoice(String(business.id), data?.voice ?? trimmed, data?.sourceUrl ?? null);
        return;
      }
      if (!response.ok) { setVoiceMessage(`Couldn’t save: ${data?.error ?? "unknown error"}`); return; }
      applyVoice(String(business.id), data.voice ?? trimmed, data.sourceUrl ?? null);
      setVoiceMessage("Voice saved. New captions will use it.");
    } catch {
      if (activeBusinessId.current === String(business.id)) setVoiceMessage("Connection problem — your changes weren’t saved. Try again.");
    } finally { if (activeBusinessId.current === String(business.id)) setVoiceBusy(false); }
  }

  async function resetVoice() {
    if (!business) return;
    setVoiceBusy(true);
    setVoiceMessage("");
    try {
      const response = await apiFetch(`/api/businesses/${business.id}/brand-voice`, { method: "DELETE" });
      const data = await response.json().catch(() => null);
      if (activeBusinessId.current !== String(business.id)) {
        if (response.ok) applyVoice(String(business.id), null, null);
        return;
      }
      if (!response.ok) { setVoiceMessage(`Couldn’t reset: ${data?.error ?? "unknown error"}`); return; }
      applyVoice(String(business.id), null, null);
      setVoiceMessage("Reset. Captions use the tone setting again.");
    } catch {
      if (activeBusinessId.current === String(business.id)) setVoiceMessage("Connection problem — nothing was changed. Try again.");
    } finally { if (activeBusinessId.current === String(business.id)) setVoiceBusy(false); }
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!business) return;
    setBusy(true);
    try {
      const response = await apiFetch(`/api/businesses/${business.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name, timezone, logoUrl: logo.trim() || null, brandTone: tone, weeklyTarget,
          brandColors: { primary, secondary, template, quoteSize }
        })
      });
      const data = await response.json();
      if (!response.ok) { setMessage(`Couldn’t save: ${data.error ?? "unknown error"}`); return; }
      await reload();
      setMessage("Saved. New posts will use these settings.");
    } catch {
      setMessage("Connection problem — your changes weren’t saved. Try again.");
    } finally { setBusy(false); }
  }

  if (status === "loading") return <p className="pl-muted" role="status">Loading your brand…</p>;
  if (!business) return <div className="pl-empty"><h2>Set up your business first</h2><Link href="/onboarding" className="pl-btn pl-btn-primary">Get started</Link></div>;

  // The saved choice stays in the form, but the preview shows what new posts
  // will actually use while the plan does not include that design.
  const previewTemplate = plan && !templateWithinLimit(template, plan.limits.templates) ? QUOTE_TEMPLATE : template;

  return (
    <>
      <header className="pl-header">
        <div className="pl-header-text">
          <h1 className="pl-title">Brand</h1>
          <p className="pl-lede">How your posts look and sound.</p>
        </div>
      </header>

      <p role="status" className="pl-toast">{message}</p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 32, alignItems: "flex-start" }}>
        <form onSubmit={save} className="pl-panel" style={{ flex: "1 1 420px", minWidth: 0, display: "flex", flexDirection: "column", gap: 22 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
            <label className="pl-field">Business name<input className="pl-input" required maxLength={120} value={name} onChange={e => setName(e.target.value)} /></label>
            <label className="pl-field">Time zone
              <select className="pl-select" value={timezone} onChange={e => setTimezone(e.target.value)}>
                {timezones(timezone).map(zone => <option key={zone} value={zone}>{zone.replaceAll("_", " ")}</option>)}
              </select>
            </label>
          </div>

          <ColorPicker label="Background color" value={primary} onChange={setPrimary} />
          <ColorPicker label="Accent color" value={secondary} onChange={setSecondary} />

          <fieldset style={{ margin: 0, padding: 0, border: 0 }}>
            <legend style={{ padding: 0, marginBottom: 10, fontSize: 14, fontWeight: 600 }}>Logo</legend>
            <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              {logo.startsWith("data:image/")
                ? <img src={logo} alt="Selected business logo" width={56} height={56} style={{ objectFit: "contain", borderRadius: 12, border: "1px solid var(--pl-line)", background: "#FFFFFF" }} />
                : logo ? <span className="pl-small pl-muted">Replace the stored logo with an upload, or remove it before saving.</span>
                : <span className="pl-small pl-muted">No logo</span>}
              <label className="pl-btn" style={{ position: "relative" }}>
                {logo ? "Replace" : "Upload logo"}
                <input key={business.id} type="file" aria-label="Logo upload" accept="image/png,image/jpeg,image/webp" onChange={e => readLogo(e.target.files?.[0], setLogo, setMessage)}
                  style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer" }} />
              </label>
              {logo ? <button type="button" className="pl-btn pl-btn-danger" onClick={() => setLogo("")}>Remove logo</button> : null}
            </div>
            <p className="pl-small pl-muted" style={{ margin: "8px 0 0" }}>PNG, JPEG or WebP, up to 256 KB.</p>
          </fieldset>

          <TonePicker name="brand-tone" value={tone} onChange={setTone} />

          <fieldset style={{ margin: 0, padding: 0, border: 0 }}>
            <legend style={{ padding: 0, marginBottom: 10, fontSize: 14, fontWeight: 600 }}>Brand voice</legend>
            {plan && !plan.limits.brandVoice ? (
              <p className="pl-small pl-muted" style={{ margin: 0 }}>
                Brand voice is a Pro feature. Your {planName(plan.plan)} plan uses the tone setting above.{" "}
                <Link href="/account">See your plan</Link>
              </p>
            ) : null}
            {plan && !plan.limits.brandVoice && storedVoice ? (
              <div style={{ marginTop: 10 }}>
                <p className="pl-small pl-muted" style={{ margin: "0 0 8px" }}>A voice profile from an earlier plan is still saved. Reset it to go back to the tone setting.</p>
                <button type="button" className="pl-btn" onClick={() => void resetVoice()} disabled={voiceBusy}>Reset to tone setting</button>
                {voiceMessage ? <p role="status" className="pl-small" style={{ margin: "10px 0 0" }}>{voiceMessage}</p> : null}
              </div>
            ) : null}
            {plan && !plan.limits.brandVoice ? null : (
              <>
                <p className="pl-small pl-muted" style={{ margin: "0 0 10px" }}>
                  Paste your own website and we’ll learn how your business sounds. We read one public page; nothing from social accounts.
                </p>
                <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
                  <label className="pl-field" style={{ flex: "1 1 240px" }}>Website URL
                    <input className="pl-input" type="url" placeholder="https://yourbusiness.com" value={voiceUrl} onChange={e => setVoiceUrl(e.target.value)} />
                  </label>
                  <button type="button" className="pl-btn" onClick={() => void learnVoice()} disabled={voiceBusy || !voiceUrl.trim()}>
                    {voiceBusy ? "Working…" : "Learn my voice"}
                  </button>
                </div>
                <label className="pl-field" style={{ marginTop: 12 }}>Voice profile
                  <textarea
                    className="pl-input"
                    style={{ minHeight: 120, resize: "vertical" }}
                    maxLength={1200}
                    value={voice}
                    onChange={e => setVoice(e.target.value)}
                    placeholder="A few sentences about how your business sounds, with example phrases."
                  />
                  <span className="pl-small pl-muted" style={{ fontWeight: 400 }}>
                    {voice.length}/1200 characters.{voiceSource ? ` Learned from ${voiceSource}.` : ""}
                  </span>
                </label>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button type="button" className="pl-btn pl-btn-primary" onClick={() => void saveVoice()} disabled={voiceBusy || !voice.trim()}>Save voice</button>
                  <button type="button" className="pl-btn" onClick={() => void resetVoice()} disabled={voiceBusy || (!voice && !storedVoice)}>Reset to tone setting</button>
                </div>
                {voiceMessage ? <p role="status" className="pl-small" style={{ margin: "10px 0 0" }}>{voiceMessage}</p> : null}
              </>
            )}
          </fieldset>

          <TemplatePicker
            value={template}
            onChange={setTemplate}
            primary={primary}
            secondary={secondary}
            quoteSize={quoteSize}
            tone={tone}
            allowed={plan ? plan.limits.templates : QUOTE_TEMPLATES.length}
          />

          <fieldset style={{ margin: 0, padding: 0, border: 0 }}>
            <legend style={{ padding: 0, marginBottom: 10, fontSize: 14, fontWeight: 600 }}>Quote text size</legend>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
              {([["standard", "Standard", "Fits most reviews"], ["large", "Large", "Bolder, skips long reviews"]] as const).map(([value, label, hint]) => (
                <label key={value} className="pl-chip" style={{ borderRadius: 12, alignItems: "flex-start", padding: 14 }}>
                  <input type="radio" name="quote-size" checked={quoteSize === value} onChange={() => setQuoteSize(value)} style={{ marginTop: 3 }} />
                  <span style={{ display: "flex", flexDirection: "column" }}><span>{label}</span><span className="pl-small pl-muted" style={{ fontWeight: 400 }}>{hint}</span></span>
                </label>
              ))}
            </div>
          </fieldset>

          <label className="pl-field" style={{ maxWidth: 240 }}>Posts per week
            <input className="pl-input" type="number" min={1} max={5} value={weeklyTarget} onChange={e => setWeeklyTarget(Number(e.target.value))} />
            <span className="pl-small pl-muted" style={{ fontWeight: 400 }}>
              Takes effect next week.
              {plan ? ` Your ${planName(plan.plan)} plan allows up to ${plan.limits.postsPerWeek} a week${weeklyTarget > plan.limits.postsPerWeek ? `, so ${plan.limits.postsPerWeek} will be made` : ""}.` : ""}
              {plan ? <> <Link href="/account">See your plan</Link></> : null}
            </span>
          </label>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", paddingTop: 14, borderTop: "1px solid var(--pl-line-soft)" }}>
            <button type="submit" className="pl-btn pl-btn-primary pl-btn-lg" disabled={busy}>Save changes</button>
            <span className="pl-small pl-muted" style={{ flex: "1 1 240px" }}>Posts already made keep their look. Use “Make a new version” on a post to apply changes.</span>
          </div>
        </form>

        <aside aria-label="Preview" style={{ flex: "1 1 320px", maxWidth: 460, display: "flex", flexDirection: "column", gap: 12 }}>
          <span className="pl-eyebrow" style={{ fontSize: 13 }}>Live preview</span>
          <BrandPreview primary={primary} secondary={secondary} quoteSize={quoteSize} tone={tone} template={previewTemplate} />
        </aside>
      </div>
    </>
  );
}
