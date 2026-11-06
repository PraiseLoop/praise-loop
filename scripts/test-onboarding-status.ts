import assert from "node:assert/strict";
import { jobNotice, postCount, readyFooter, STUCK_JOB_MS } from "../lib/onboardingStatus";

// Pure rules behind onboarding step 3 (#246): the stuck-job threshold and the
// plural wording. The page and the worker are covered by their own suites.
function main() {
  // Waiting its turn: no action until the threshold.
  assert.deepEqual(jobNotice({ job_state: "pending" }), { kind: "waiting", text: "Waiting its turn…", actions: [] });
  assert.deepEqual(jobNotice({ job_state: "pending" }, STUCK_JOB_MS - 1), { kind: "waiting", text: "Waiting its turn…", actions: [] });

  // At the threshold the honest message appears with a way out.
  const stuckPending = jobNotice({ job_state: "pending" }, STUCK_JOB_MS);
  assert.equal(stuckPending.kind, "slow");
  assert.deepEqual(stuckPending.actions, ["leave"]);
  assert.match(stuckPending.text, /worker may be paused/);

  // Running jobs use the same threshold but their own copy before it.
  assert.deepEqual(jobNotice({ job_state: "running" }, 1000), {
    kind: "waiting",
    text: "Writing the caption and designing the image…",
    actions: []
  });
  assert.equal(jobNotice({ job_state: "running" }, STUCK_JOB_MS).kind, "slow");

  // Automatic retries are not terminal; a long wait is still stuck.
  assert.deepEqual(jobNotice({ job_state: "retry" }, 1000), {
    kind: "retrying",
    text: "Hit a snag — trying again automatically…",
    actions: []
  });
  assert.equal(jobNotice({ job_state: "retry", error_code: "generation_failed" }, 1000).text, "Needs attention — trying again automatically…");
  assert.equal(jobNotice({ job_state: "retry" }, STUCK_JOB_MS).kind, "slow");

  // A failed job is terminal and offers the bounded retry.
  const failed = jobNotice({ job_state: "failed", status: "failed", error_code: "caption_empty" });
  assert.equal(failed.kind, "failed");
  assert.deepEqual(failed.actions, ["retry"]);
  assert.match(failed.text, /\(caption_empty\)/);
  assert.equal(jobNotice({ job_state: "failed" }, STUCK_JOB_MS).kind, "failed", "a long-dead failed job is still failed, not slow");

  // The worker marks the draft failed while it retries; only a non-in-flight
  // state is terminal, matching the old page rule.
  assert.equal(jobNotice({ status: "failed", job_state: "pending" }, 1000).kind, "waiting");
  assert.equal(jobNotice({ status: "failed" }).kind, "failed");
  assert.deepEqual(jobNotice({ status: "failed" }).actions, [], "no job row means nothing the retry route can queue");

  // Ready states and a caller-supplied threshold.
  assert.deepEqual(jobNotice({ job_state: "complete" }), { kind: "ready", text: "Ready", actions: [] });
  assert.deepEqual(jobNotice({}), { kind: "ready", text: "Ready", actions: [] });
  assert.equal(jobNotice({ job_state: "pending" }, 5000, 5000).kind, "slow");

  // "1 post", "2 posts" and the footer's verb agreement.
  assert.equal(postCount(0), "0 posts");
  assert.equal(postCount(1), "1 post");
  assert.equal(postCount(2), "2 posts");
  assert.equal(readyFooter(1), "We’ll move on as soon as all 1 post is ready.");
  assert.equal(readyFooter(2), "We’ll move on as soon as all 2 posts are ready.");
  assert.equal(readyFooter(3), "We’ll move on as soon as all 3 posts are ready.");

  console.log("onboarding status/stuck-job/plural tests passed");
}
main();
