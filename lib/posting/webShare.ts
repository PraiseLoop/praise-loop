// Posting an approved draft from the phone browser through the Web Share API
// (#274). This mirrors the phone's share flow (mobile/src/posting/shareFlow.ts)
// but is pure: the browser wiring lives in app/approval/PostCard.tsx, so every
// state can be tested without a DOM, a browser or a real network.
//
// The share sheet must be opened directly from the button's click handler or
// iOS Safari rejects it. The card therefore prefetches the PNG and this module
// never fetches it: `loadImage` resolves from the prefetched blob.

export type WebShareDraft = {
  id: number;
  version: number;
  caption_text: string;
  image_path: string | null;
  status: string;
};

export type ShareImage = { blob: Blob; filename: string };

// navigator.share resolves when the sheet closes, whether or not the owner
// posted. AbortError means the sheet was dismissed, which is only a cancel.
export type ShareOutcome = "shared" | "cancelled";

export type MarkSharedResult =
  | { ok: true; draft: WebShareDraft }
  | { ok: false; reason: "conflict" | "signedOut" | "generic" };

export type WebShareDeps = {
  canShare: () => boolean;
  loadImage: (draft: WebShareDraft) => Promise<ShareImage>;
  copyCaption: (caption: string) => Promise<void>;
  share: (image: ShareImage) => Promise<ShareOutcome>;
  downloadImage: (draft: WebShareDraft) => Promise<void>;
  markShared: (draft: WebShareDraft) => Promise<MarkSharedResult>;
};

export type WebShareState =
  | { step: "idle" }
  | { step: "preparing" }
  // The browser cannot share files. The owner downloads the image and copies
  // the caption instead; they can still mark the post as shared.
  | { step: "fallback"; draft: WebShareDraft; notice?: string }
  // The share sheet has closed; the owner is answering "Did you post it?".
  | { step: "confirm"; draft: WebShareDraft }
  | { step: "done"; draft: WebShareDraft }
  | { step: "error"; message: string; reason?: "conflict" | "signedOut" | "generic" };

export const SHARED_HINT = "Caption copied — paste it in Instagram";

// Shown before the sheet opens. The confirmation question comes too late to
// tell the owner to paste the caption while they are composing the post.
export const PASTE_HINT = "Posting copies the caption and opens the share sheet. Paste it into Instagram before you publish.";

export const FALLBACK_HINT = "This browser can't open a share sheet. Download the image and copy the caption, then post it in Instagram or Facebook.";

const NO_IMAGE = "This post has no image to share yet.";
const IMAGE_FAILED = "Couldn't load the image. Check your connection and try again.";
const CAPTION_FAILED = "Couldn't copy the caption to the clipboard.";
const SHARE_FAILED = "Couldn't open the share sheet.";
const CONFLICT = "This post changed somewhere else. Refresh and try again.";
const SIGNED_OUT = "Your session ended. Sign in again.";
const MARK_FAILED = "Couldn't record the post as shared.";

// Fetch the prefetched PNG, copy the caption and open the share sheet. Nothing
// is recorded here: the owner is asked whether they actually posted.
export async function prepareShare(draft: WebShareDraft, deps: WebShareDeps): Promise<WebShareState> {
  if (!draft.image_path) return { step: "error", message: NO_IMAGE };
  if (!deps.canShare()) return { step: "fallback", draft };

  let image: ShareImage;
  try {
    image = await deps.loadImage(draft);
  } catch {
    return { step: "error", message: IMAGE_FAILED };
  }

  try {
    await deps.copyCaption(draft.caption_text);
  } catch {
    return { step: "error", message: CAPTION_FAILED };
  }

  let outcome: ShareOutcome;
  try {
    outcome = await deps.share(image);
  } catch {
    return { step: "error", message: SHARE_FAILED };
  }

  // A dismissed sheet means nothing was posted. Never infer posting from a
  // resolved sheet either: the owner answers the question in `confirmShared`.
  if (outcome === "cancelled") return { step: "idle" };
  return { step: "confirm", draft };
}

// Fallback: download the image through the owner-protected media route.
export async function fallbackDownload(draft: WebShareDraft, deps: WebShareDeps): Promise<WebShareState> {
  try {
    await deps.downloadImage(draft);
  } catch {
    return { step: "error", message: "Couldn't download the image. Try again." };
  }
  return { step: "fallback", draft, notice: "Image downloaded." };
}

// Fallback: copy the caption so the owner can paste it into Instagram.
export async function fallbackCopy(draft: WebShareDraft, deps: WebShareDeps): Promise<WebShareState> {
  try {
    await deps.copyCaption(draft.caption_text);
  } catch {
    return { step: "error", message: CAPTION_FAILED };
  }
  return { step: "fallback", draft, notice: SHARED_HINT };
}

// Only called after the owner says they posted it. Never inferred from the
// share result: the server records `shared` as owner-reported, not verified.
export async function confirmShared(state: WebShareState, deps: WebShareDeps): Promise<WebShareState> {
  if (state.step !== "confirm") return state;
  return markShared(state.draft, deps);
}

// Also used by the fallback's "Mark as posted" button.
export async function markShared(draft: WebShareDraft, deps: WebShareDeps): Promise<WebShareState> {
  const result = await deps.markShared(draft);
  if (result.ok) return { step: "done", draft: result.draft };
  if (result.reason === "conflict") return { step: "error", message: CONFLICT, reason: "conflict" };
  if (result.reason === "signedOut") return { step: "error", message: SIGNED_OUT, reason: "signedOut" };
  return { step: "error", message: MARK_FAILED, reason: "generic" };
}

export function declineShared(): WebShareState {
  return { step: "idle" };
}
