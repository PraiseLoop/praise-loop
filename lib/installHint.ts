export const INSTALL_HINT_DISMISSED_KEY = "praise-install-hint-dismissed";

export type InstallPlatform = "ios-safari" | "android" | "other";

// Add to Home Screen exists in Safari on iOS and in browsers that fire
// beforeinstallprompt on Android. In-app browsers (Instagram, Facebook) and
// third-party iOS browsers cannot install, so they get no hint.
const IOS_NON_SAFARI = /CriOS|FxiOS|EdgiOS|OPiOS|GSA|FBAN|FBAV|Instagram|Line\//i;

export function detectInstallPlatform(userAgent: string): InstallPlatform {
  if (/iPhone|iPod|iPad/i.test(userAgent)) return IOS_NON_SAFARI.test(userAgent) ? "other" : "ios-safari";
  if (/Android/i.test(userAgent)) return "android";
  return "other";
}

export type InstallHintState = {
  signedIn: boolean;
  /** Already opened from the home screen (`display-mode: standalone` or iOS `navigator.standalone`). */
  standalone: boolean;
  dismissed: boolean;
  platform: InstallPlatform;
  /** Android only: the browser has offered its install prompt. */
  promptAvailable: boolean;
};

// One rule for the whole hint, so the component and its tests cannot drift.
export function shouldShowInstallHint(state: InstallHintState): boolean {
  if (!state.signedIn || state.standalone || state.dismissed) return false;
  if (state.platform === "ios-safari") return true;
  if (state.platform === "android") return state.promptAvailable;
  return false;
}
