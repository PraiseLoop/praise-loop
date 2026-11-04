"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "../apiFetch";
export default function BrandPreview(props: { primary: string; secondary: string; quoteSize: string; tone: string; template: string }) {
  const [src, setSrc] = useState(""), [error, setError] = useState("");
  const { primary, secondary, quoteSize, tone, template } = props;
  useEffect(() => {
    const controller = new AbortController();
    let url = "";
    const timer = setTimeout(async () => {
      try {
        const response = await apiFetch("/api/branding/preview", { method: "POST", signal: controller.signal,
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brandTone: tone,
            brandColors: { primary, secondary, template, quoteSize } }) });
        if (!response.ok) throw new Error("Preview unavailable. Check settings or sign in.");
        url = URL.createObjectURL(await response.blob()); setSrc(url); setError("");
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Preview failed"); }
    }, 400);
    return () => { clearTimeout(timer); controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [primary, secondary, quoteSize, tone, template]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ aspectRatio: "1 / 1", borderRadius: 16, overflow: "hidden", background: "var(--pl-line-soft)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        {error ? <p role="alert" className="pl-muted" style={{ padding: 24, textAlign: "center" }}>{error}</p>
          : src ? <img src={src} width={1080} height={1080} style={{ width: "100%", height: "auto", display: "block" }} alt="Synthetic quote preview of selected brand settings" />
          : <p className="pl-muted">Preparing sample…</p>}
      </div>
      <p className="pl-small pl-muted" style={{ margin: 0 }}>Sample quote card. Text color is picked automatically for contrast.</p>
    </div>
  );
}
