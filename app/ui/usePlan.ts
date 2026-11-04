"use client";
import { useCallback, useEffect, useState } from "react";
import type { EntitlementsWithUsage } from "../../lib/planDisplay";
import { apiFetch } from "../apiFetch";

// Reads the server's plan and this week's usage; the app never recomputes limits.
// Returns null while loading or if the request fails, so callers fall back to
// their plain wording rather than blocking the page. It goes through apiFetch so an
// expired session sends the owner to sign-in even when this is the only request a
// page makes (the Plan page has no polling to notice it otherwise).
export function usePlan() {
  const [plan, setPlan] = useState<EntitlementsWithUsage | null>(null);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion(value => value + 1), []);
  useEffect(() => {
    let current = true;
    apiFetch("/api/entitlements")
      .then(async response => {
        if (!response.ok) throw new Error("plan unavailable");
        const data: EntitlementsWithUsage = await response.json();
        if (current) { setPlan(data); setFailed(false); }
      })
      .catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [version]);
  return { plan, failed, reload };
}
