// Pure rules for the onboarding "Making your first posts" step (#246). Kept
// out of the React page so the stuck-job decision and the plural wording can be
// tested without a renderer. No database or client imports.

/** How long a queued, running or auto-retrying job may hold step 3 before we admit it is stuck. */
export const STUCK_JOB_MS = 2 * 60 * 1000;

export type JobNoticeKind = "waiting" | "retrying" | "slow" | "failed" | "ready";
export type JobAction = "retry" | "leave";

export type JobNotice = {
  kind: JobNoticeKind;
  text: string;
  /** Actions the row should offer: retry a terminal failure, or leave for This week. */
  actions: JobAction[];
};

type JobInput = { job_state?: string | null; status?: string | null; error_code?: string | null };

const inFlight = new Set(["pending", "running", "retry"]);

/**
 * What step 3 should say for one generation job.
 * `elapsedMs` is how long this page has watched the draft hold its current
 * in-flight state, so a retry starts a fresh clock instead of inheriting the
 * age of the draft.
 */
export function jobNotice(job: JobInput, elapsedMs = 0, thresholdMs = STUCK_JOB_MS): JobNotice {
  const state = job.job_state ?? "";
  const retrying = inFlight.has(state);
  // The worker marks the draft failed while it retries automatically, so only a
  // non-in-flight job state is terminal.
  if (state === "failed" || (job.status === "failed" && !retrying)) {
    return {
      kind: "failed",
      text: `Needs attention${job.error_code ? ` (${job.error_code})` : ""}. Check your brand settings, then try again.`,
      actions: state === "failed" ? ["retry"] : []
    };
  }
  if (retrying) {
    if (elapsedMs >= thresholdMs) {
      return {
        kind: "slow",
        text: "This post has been waiting longer than usual. The generation worker may be paused; it will keep going in the background.",
        actions: ["leave"]
      };
    }
    if (state === "running") return { kind: "waiting", text: "Writing the caption and designing the image…", actions: [] };
    if (state === "retry") {
      return {
        kind: "retrying",
        text: job.error_code ? "Needs attention — trying again automatically…" : "Hit a snag — trying again automatically…",
        actions: []
      };
    }
    return { kind: "waiting", text: "Waiting its turn…", actions: [] };
  }
  return { kind: "ready", text: "Ready", actions: [] };
}

/** "1 post", "2 posts": the same wording everywhere in the wizard. */
export function postCount(count: number) {
  return `${count} post${count === 1 ? "" : "s"}`;
}

/** The step 3 footer, with the verb agreeing with the count. */
export function readyFooter(target: number) {
  return `We’ll move on as soon as all ${postCount(target)} ${target === 1 ? "is" : "are"} ready.`;
}
