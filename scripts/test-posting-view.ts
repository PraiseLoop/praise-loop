import assert from "node:assert/strict";
import { postingView } from "../lib/posting/postingView";

// Pure rules behind the posting status on the web approval cards (#29 part 4).
// The API routes are covered elsewhere; this suite only checks the wording, the
// actions and the link safety of what the card renders.
function main() {
  // Waiting for its time: only a queued scheduled draft can be cancelled.
  assert.deepEqual(postingView({ status: "scheduled", provider_state: "queued" }), {
    tone: "info",
    headline: "Waiting for its time",
    detail: "It will be sent to Buffer at the scheduled time.",
    link: null,
    actions: ["cancel"]
  });
  assert.equal(postingView({ status: "approved", provider_state: "queued" }), null);

  // In flight: status only, no action while Buffer has it.
  assert.deepEqual(postingView({ status: "scheduled", provider_state: "submitting" }), {
    tone: "info",
    headline: "Sending to Buffer…",
    detail: null,
    link: null,
    actions: []
  });
  assert.deepEqual(postingView({ status: "scheduled", provider_state: "submitted" }), {
    tone: "info",
    headline: "Sent to Buffer — waiting for it to go out",
    detail: null,
    link: null,
    actions: []
  });

  // Unknown: the owner is the only one who can say what happened.
  assert.deepEqual(postingView({ status: "scheduled", provider_state: "unknown" }), {
    tone: "warn",
    headline: "We couldn’t confirm this post",
    detail: "Check your Instagram or Buffer, then tell us what happened.",
    link: null,
    actions: ["posted", "not_posted"]
  });
  assert.equal(postingView({ status: "failed", provider_state: "unknown" }), null);

  // Posted: only an absolute HTTPS link is shown.
  const posted = { status: "published", provider_state: "sent" };
  assert.deepEqual(postingView({ ...posted, posting_link: "https://buffer.com/x?y=1" }), {
    tone: "good",
    headline: "Posted",
    detail: null,
    link: "https://buffer.com/x?y=1",
    actions: []
  });
  for (const bad of ["javascript:alert(1)", "http://x", "//x", "", null, undefined]) {
    const view = postingView({ ...posted, posting_link: bad });
    assert.equal(view?.link, null, `refuses ${String(bad)}`);
  }
  assert.equal(postingView({ status: "scheduled", provider_state: "sent", posting_link: "https://buffer.com/x" }), null);

  // Test mode: saved in Buffer, nothing posted.
  assert.deepEqual(postingView({ status: "approved", provider_state: "drafted" }), {
    tone: "info",
    headline: "Saved as a draft in Buffer",
    detail: "Test mode: nothing was posted. Find it in Buffer.",
    link: null,
    actions: []
  });
  assert.equal(postingView({ status: "draft", provider_state: "drafted" }), null);

  // Failed: the posting error code gives the sentence, never the raw code.
  const errors: Record<string, string> = {
    late: "It was more than 2 hours past its time, so it wasn’t sent.",
    needs_reconnect: "Buffer needs to be reconnected.",
    no_connection: "Buffer isn’t connected.",
    not_connected: "Buffer isn’t connected.",
    no_channel: "No Buffer channel is chosen for this business.",
    personal_instagram: "Buffer can only post automatically to a Business Instagram account.",
    rejected: "Buffer didn’t accept this post.",
    buffer_error: "Buffer couldn’t post it.",
    draft_unavailable: "The caption or image changed before it was sent.",
    media_url_unavailable: "The image link couldn’t be made.",
    plan_required: "Automatic posting is included in Pro and Business. This post wasn’t sent.",
    owner_reported_not_posted: "You told us it wasn’t posted."
  };
  for (const [code, detail] of Object.entries(errors)) {
    for (const state of ["error", "missed"]) {
      assert.deepEqual(postingView({ status: "failed", provider_state: state, posting_error_code: code }), {
        tone: "bad",
        headline: "Not posted",
        detail,
        link: null,
        actions: ["approve_again"]
      });
      const view = postingView({ status: "failed", provider_state: state, posting_error_code: code });
      assert.ok(!view?.detail?.includes(code), `${code} does not leak the raw code`);
    }
  }
  const fallback = "Something went wrong sending it.";
  assert.equal(postingView({ status: "failed", provider_state: "error", posting_error_code: "not_a_code" })?.detail, fallback);
  assert.equal(postingView({ status: "failed", provider_state: "missed", posting_error_code: null })?.detail, fallback);
  assert.equal(postingView({ status: "failed", provider_state: "error" })?.detail, fallback);
  assert.equal(postingView({ status: "failed", provider_state: "queued" }), null);

  // Direct Meta publishing (#234) uses the same fields but never says "Buffer".
  assert.deepEqual(postingView({ status: "scheduled", provider_state: "queued", posting_provider: "meta" }), {
    tone: "info",
    headline: "Waiting for its time",
    detail: "It will be sent to Instagram or Facebook at the scheduled time.",
    link: null,
    actions: ["cancel"]
  });
  assert.deepEqual(postingView({ status: "scheduled", provider_state: "unknown", posting_provider: "meta" }), {
    tone: "warn",
    headline: "We couldn’t confirm this post",
    detail: "Check your Instagram or Facebook, then tell us what happened.",
    link: null,
    actions: ["posted", "not_posted"]
  });
  assert.deepEqual(postingView({ status: "approved", provider_state: "drafted", posting_provider: "meta" }), {
    tone: "info",
    headline: "Test mode: nothing was posted",
    detail: "Automatic posting to Instagram or Facebook is in test mode, so this post was not sent.",
    link: null,
    actions: []
  });
  for (const [code, detail] of Object.entries({
    needs_reconnect: "Instagram or Facebook needs to be reconnected.",
    not_connected: "Instagram or Facebook isn’t connected for this business.",
    rejected: "Instagram or Facebook didn’t accept this post.",
    page_cannot_publish: "The Facebook Page doesn’t allow this app to publish.",
    instagram_unavailable: "The Facebook Page has no linked Instagram account.",
    container_unavailable: "The Instagram upload expired before it could be published.",
    caption_too_long: "The caption is too long for Instagram (2,200 characters).",
    too_many_hashtags: "Instagram accepts at most 30 hashtags in a caption.",
    rate_limited: "Instagram or Facebook is limiting how often we can post. It wasn’t sent.",
    retry_exhausted: "Instagram or Facebook kept failing. This post wasn’t sent."
  })) {
    const view = postingView({ status: "failed", provider_state: "error", posting_provider: "meta", posting_error_code: code });
    assert.deepEqual(view, { tone: "bad", headline: "Not posted", detail, link: null, actions: ["approve_again"] });
    assert.ok(!view?.detail?.includes(code), `${code} does not leak the raw code`);
  }

  // Nothing to say: plain drafts, generation failures and shared drafts.
  assert.equal(postingView({}), null);
  assert.equal(postingView({ status: "draft" }), null);
  assert.equal(postingView({ status: "failed", posting_error_code: "generation_failed" }), null);
  assert.equal(postingView({ status: "shared", provider_state: "sent" }), null);
  assert.deepEqual(postingView({
    status: null,
    provider_state: null,
    posting_mode: null,
    posting_error_code: null,
    posting_link: null,
    posting_sent_at: null,
    scheduled_for: null
  }), null);

  console.log("posting view pure tests passed");
}
main();
