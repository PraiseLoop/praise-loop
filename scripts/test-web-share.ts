import assert from "node:assert/strict";
import {
  confirmShared,
  declineShared,
  fallbackCopy,
  fallbackDownload,
  FALLBACK_HINT,
  markShared,
  PASTE_HINT,
  prepareShare,
  SHARED_HINT,
  type MarkSharedResult,
  type ShareImage,
  type WebShareDeps,
  type WebShareDraft,
  type WebShareState
} from "../lib/posting/webShare";

// Pure rules behind posting an approved draft through the Web Share API (#274).
// The browser wiring is a thin adapter around these functions; the browser suite
// covers the fallback UI and marking a draft shared.
const draft: WebShareDraft = {
  id: 12,
  version: 3,
  caption_text: "Thanks for saying so.",
  image_path: "/api/media/draft-12.png",
  status: "approved"
};

const image: ShareImage = { blob: new Blob(["png"], { type: "image/png" }), filename: "post-12.png" };

function harness(overrides: Partial<WebShareDeps> = {}) {
  const calls: string[] = [];
  const base: WebShareDeps = {
    canShare: () => true,
    loadImage: async item => { calls.push(`load:${item.id}`); return image; },
    copyCaption: async text => { calls.push(`copy:${text}`); },
    share: async item => { calls.push(`share:${item.filename}`); return "shared"; },
    downloadImage: async item => { calls.push(`download:${item.id}`); },
    markShared: async item => { calls.push(`mark:${item.id}`); return { ok: true, draft: { ...item, status: "shared", version: item.version + 1 } }; }
  };
  return { deps: { ...base, ...overrides }, calls };
}

async function prepared(overrides: Partial<WebShareDeps> = {}) {
  const h = harness(overrides);
  return { ...h, state: await prepareShare(draft, h.deps) };
}

function conflict(): MarkSharedResult {
  return { ok: false, reason: "conflict" };
}

function main() {
  // The hint has to be on screen before the share sheet, because the question
  // after it is too late for the owner to paste the caption.
  assert.match(PASTE_HINT, /paste/i);
  assert.match(PASTE_HINT, /instagram/i);
  assert.match(SHARED_HINT, /paste/i);
  assert.match(FALLBACK_HINT, /download/i);

  void (async () => {
    // Supported: load the prefetched image, copy the caption, open the sheet,
    // then ask instead of recording anything.
    {
      const { state, calls } = await prepared();
      assert.deepEqual(state, { step: "confirm", draft });
      assert.deepEqual(calls, ["load:12", "copy:Thanks for saying so.", "share:post-12.png"]);
    }

    // Unsupported: no image load, no clipboard write, no share attempt; the
    // card switches to the download/copy fallback.
    {
      const { state, calls } = await prepared({ canShare: () => false });
      assert.deepEqual(state, { step: "fallback", draft });
      assert.deepEqual(calls, []);
    }

    // A draft without an image can never be posted, on either path.
    {
      const { state, calls } = await (async () => {
        const h = harness();
        return { state: await prepareShare({ ...draft, image_path: null }, h.deps), calls: h.calls };
      })();
      assert.deepEqual(state, { step: "error", message: "This post has no image to share yet." });
      assert.deepEqual(calls, []);
    }

    // A failed image load keeps the caption and the sheet untouched.
    {
      const { state, calls } = await prepared({ loadImage: async () => { throw new Error("offline"); } });
      assert.deepEqual(state, { step: "error", message: "Couldn't load the image. Check your connection and try again." });
      assert.deepEqual(calls, []);
    }

    // A clipboard failure stops before sharing rather than opening a sheet the
    // owner cannot caption.
    {
      const { state, calls } = await prepared({ copyCaption: async () => { throw new Error("clipboard"); } });
      assert.deepEqual(state, { step: "error", message: "Couldn't copy the caption to the clipboard." });
      assert.deepEqual(calls, ["load:12"]);
    }

    // Any other share failure is shown; it is not treated as a cancel.
    {
      const { state } = await prepared({ share: async () => { throw new Error("no activity"); } });
      assert.deepEqual(state, { step: "error", message: "Couldn't open the share sheet." });
    }

    // AbortError (mapped to "cancelled" by the browser adapter) records nothing
    // and does not ask the owner anything.
    {
      const { state, calls } = await prepared({ share: async () => "cancelled" });
      assert.deepEqual(state, { step: "idle" });
      assert.deepEqual(calls, ["load:12", "copy:Thanks for saying so."]);
    }

    // Only a yes marks it shared, with the version the card holds.
    {
      const confirm: WebShareState = { step: "confirm", draft };
      const { deps, calls } = harness();
      const result = await confirmShared(confirm, deps);
      assert.equal(result.step, "done");
      assert.deepEqual(result, { step: "done", draft: { ...draft, status: "shared", version: 4 } });
      assert.deepEqual(calls, ["mark:12"]);
    }

    // No leaves it unrecorded.
    {
      const { deps, calls } = harness();
      assert.deepEqual(declineShared(), { step: "idle" });
      assert.deepEqual(await confirmShared({ step: "idle" }, deps), { step: "idle" });
      assert.deepEqual(await confirmShared({ step: "done", draft }, deps), { step: "done", draft });
      assert.deepEqual(calls, []);
    }

    // A stale version is a conflict, not a silent success.
    {
      const { deps } = harness({ markShared: async () => conflict() });
      assert.deepEqual(await confirmShared({ step: "confirm", draft }, deps), {
        step: "error",
        message: "This post changed somewhere else. Refresh and try again.",
        reason: "conflict"
      });
    }

    // Session and generic failures keep their own reasons.
    {
      const signedOut = harness({ markShared: async () => ({ ok: false, reason: "signedOut" }) });
      assert.deepEqual(await confirmShared({ step: "confirm", draft }, signedOut.deps), {
        step: "error",
        message: "Your session ended. Sign in again.",
        reason: "signedOut"
      });
      const generic = harness({ markShared: async () => ({ ok: false, reason: "generic" }) });
      assert.deepEqual(await confirmShared({ step: "confirm", draft }, generic.deps), {
        step: "error",
        message: "Couldn't record the post as shared.",
        reason: "generic"
      });
    }

    // Fallback download: success leaves the fallback on screen with a notice;
    // failure keeps the reason.
    {
      const { state, calls } = await (async () => {
        const h = harness();
        return { state: await fallbackDownload(draft, h.deps), calls: h.calls };
      })();
      assert.deepEqual(state, { step: "fallback", draft, notice: "Image downloaded." });
      assert.deepEqual(calls, ["download:12"]);
      const failed = await fallbackDownload(draft, harness({ downloadImage: async () => { throw new Error("offline"); } }).deps);
      assert.deepEqual(failed, { step: "error", message: "Couldn't download the image. Try again." });
    }

    // Fallback copy: success tells the owner to paste; failure says why.
    {
      const { state, calls } = await (async () => {
        const h = harness();
        return { state: await fallbackCopy(draft, h.deps), calls: h.calls };
      })();
      assert.deepEqual(state, { step: "fallback", draft, notice: SHARED_HINT });
      assert.deepEqual(calls, ["copy:Thanks for saying so."]);
      const failed = await fallbackCopy(draft, harness({ copyCaption: async () => { throw new Error("clipboard"); } }).deps);
      assert.deepEqual(failed, { step: "error", message: "Couldn't copy the caption to the clipboard." });
    }

    // The fallback's Mark as posted button records it just like the yes answer.
    {
      const { deps, calls } = harness();
      const result = await markShared(draft, deps);
      assert.deepEqual(result, { step: "done", draft: { ...draft, status: "shared", version: 4 } });
      assert.deepEqual(calls, ["mark:12"]);
    }

    console.log(JSON.stringify({ event: "web_share_flow" }));
  })().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

main();
