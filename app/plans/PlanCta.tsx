"use client";
import { signIn } from "next-auth/react";
import { useBusiness } from "../AppShell";

// The plans page is public. The bottom call to action signs in with Google rather
// than linking to an owner-only screen. Nothing here starts a checkout.
export default function PlanCta({ label }: { label: string }) {
  return (
    <button type="button" className="pl-btn pl-btn-primary pl-btn-lg" onClick={() => signIn("google", { callbackUrl: "/approval" })}>
      {label}
    </button>
  );
}

// Pro's upgrade button only sends a signed-in owner to /account, where checkout
// runs behind step-up. A signed-out visitor signs in first; checkout never starts
// from this public page.
export function ProPlanCta() {
  // The shared AppShell session state avoids adding a second session provider:
  // /plans is rendered inside the shell, and "ready" means signed in.
  const { status } = useBusiness();
  const next = () => {
    if (status === "ready") { window.location.assign("/account?plan=pro"); return; }
    void signIn("google", { callbackUrl: "/account?plan=pro" });
  };
  return (
    <button type="button" className="pl-btn pl-btn-primary" onClick={next} disabled={status === "loading"}>
      Upgrade to Pro
    </button>
  );
}
