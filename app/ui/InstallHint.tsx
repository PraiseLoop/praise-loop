"use client";
import { useCallback, useEffect, useState } from "react";
import {
  detectInstallPlatform,
  INSTALL_HINT_DISMISSED_KEY,
  shouldShowInstallHint,
  type InstallPlatform
} from "../../lib/installHint";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice?: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function readDismissed() {
  try { return localStorage.getItem(INSTALL_HINT_DISMISSED_KEY) === "1"; } catch { return false; }
}

function writeDismissed() {
  try { localStorage.setItem(INSTALL_HINT_DISMISSED_KEY, "1"); } catch { /* per-device convenience only */ }
}

function isStandalone() {
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia?.("(display-mode: standalone)").matches === true;
}

// A dismissible "Add to Home Screen" hint for signed-in phone visitors (#273).
// Android gets the real browser prompt; iOS Safari gets Share → Add to Home
// Screen instructions because it has no install prompt. Dismissal is stored in
// localStorage so the hint never nags.
export default function InstallHint({ signedIn }: { signedIn: boolean }) {
  const [platform, setPlatform] = useState<InstallPlatform>("other");
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(true);
  const [standalone, setStandalone] = useState(true);

  useEffect(() => {
    setPlatform(detectInstallPlatform(navigator.userAgent));
    setDismissed(readDismissed());
    setStandalone(isStandalone());
    const capturePrompt = (event: Event) => {
      // Keep the event for our own button instead of the browser's mini-infobar.
      event.preventDefault();
      setPrompt(event as BeforeInstallPromptEvent);
    };
    const installed = () => { setPrompt(null); setStandalone(true); };
    window.addEventListener("beforeinstallprompt", capturePrompt);
    window.addEventListener("appinstalled", installed);
    return () => {
      window.removeEventListener("beforeinstallprompt", capturePrompt);
      window.removeEventListener("appinstalled", installed);
    };
  }, []);

  const dismiss = useCallback(() => {
    writeDismissed();
    setDismissed(true);
  }, []);

  async function install() {
    if (!prompt) return;
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } catch {
      // No prompt is possible any more; hide it rather than asking again.
    } finally {
      dismiss();
    }
  }

  if (!shouldShowInstallHint({
    signedIn,
    standalone,
    dismissed,
    platform,
    promptAvailable: prompt !== null
  })) return null;

  const ios = platform === "ios-safari";
  return (
    <aside className="pl-install-hint" role="region" aria-label="Add PraiseLoop to your home screen">
      <div className="pl-install-hint-copy">
        <strong>Add PraiseLoop to your home screen</strong>
        <span>
          {ios
            ? "Tap the Share button, then choose “Add to Home Screen”."
            : "Open it like an app, without the browser bars."}
        </span>
      </div>
      <div className="pl-install-hint-actions">
        {ios
          ? <button type="button" className="pl-btn pl-btn-primary" onClick={dismiss}>Got it</button>
          : <button type="button" className="pl-btn pl-btn-primary" onClick={() => void install()}>Install</button>}
        {ios ? null : <button type="button" className="pl-btn" onClick={dismiss}>Not now</button>}
      </div>
      <button type="button" className="pl-install-hint-close" aria-label="Dismiss install hint" onClick={dismiss}>×</button>
    </aside>
  );
}
