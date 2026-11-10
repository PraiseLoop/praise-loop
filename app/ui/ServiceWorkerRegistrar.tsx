"use client";
import { useEffect } from "react";

// Register only the no-cache service worker needed for installability (#273).
// Development stays unregistered so a stale worker cannot shadow `next dev`.
export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Installation keeps working as a browser bookmark; nothing to do.
    });
  }, []);
  return null;
}
