// Pure wording and action rules for the posting status on the web approval cards
// (#29 part 4). No fetch and no DOM: the card renders these and the tests exercise
// them directly.

export type PostingTone = "info" | "good" | "warn" | "bad";
export type PostingAction = "cancel" | "posted" | "not_posted" | "approve_again";

export type PostingView = {
  tone: PostingTone;
  headline: string;
  detail: string | null;
  link: string | null;
  actions: PostingAction[];
};

export type PostingDraft = {
  status?: string | null;
  provider_state?: string | null;
  posting_provider?: string | null;
  posting_mode?: string | null;
  posting_error_code?: string | null;
  posting_link?: string | null;
  posting_sent_at?: string | null;
  scheduled_for?: string | null;
};

// The only codes an owner sees are the sentences below; an unknown code falls
// back to a plain sentence rather than putting the raw value on the page.
const POSTING_ERRORS: Record<string, string> = {
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

// Direct Meta publishing (#234) uses the same claim/status fields but never says
// "Buffer" to an owner who connected Instagram or Facebook.
const META_POSTING_ERRORS: Record<string, string> = {
  late: "It was more than 2 hours past its time, so it wasn’t sent.",
  needs_reconnect: "Instagram or Facebook needs to be reconnected.",
  no_connection: "Instagram or Facebook isn’t connected for this business.",
  not_connected: "Instagram or Facebook isn’t connected for this business.",
  no_channel: "No Instagram or Facebook account is chosen for this business.",
  rejected: "Instagram or Facebook didn’t accept this post.",
  page_cannot_publish: "The Facebook Page doesn’t allow this app to publish.",
  instagram_unavailable: "The Facebook Page has no linked Instagram account.",
  container_unavailable: "The Instagram upload expired before it could be published.",
  caption_too_long: "The caption is too long for Instagram (2,200 characters).",
  too_many_hashtags: "Instagram accepts at most 30 hashtags in a caption.",
  rate_limited: "Instagram or Facebook is limiting how often we can post. It wasn’t sent.",
  retry_exhausted: "Instagram or Facebook kept failing. This post wasn’t sent.",
  draft_unavailable: "The caption or image changed before it was sent.",
  media_url_unavailable: "The image link couldn’t be made.",
  plan_required: "Automatic posting is included in Pro and Business. This post wasn’t sent.",
  owner_reported_not_posted: "You told us it wasn’t posted."
};

// Buffer returns a link to the post. Only an absolute HTTPS address is shown.
function httpsLink(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

export function postingView(draft: PostingDraft): PostingView | null {
  const state = draft.provider_state;
  const meta = draft.posting_provider === "meta";

  if (state === "queued" && draft.status === "scheduled") {
    return {
      tone: "info",
      headline: "Waiting for its time",
      detail: meta
        ? "It will be sent to Instagram or Facebook at the scheduled time."
        : "It will be sent to Buffer at the scheduled time.",
      link: null,
      actions: ["cancel"]
    };
  }

  if (state === "submitting") {
    return {
      tone: "info",
      headline: meta ? "Sending to Instagram or Facebook…" : "Sending to Buffer…",
      detail: null, link: null, actions: []
    };
  }

  if (state === "submitted") {
    return {
      tone: "info",
      headline: meta ? "Sent — waiting for it to go out" : "Sent to Buffer — waiting for it to go out",
      detail: null, link: null, actions: []
    };
  }

  if (state === "unknown" && draft.status === "scheduled") {
    return {
      tone: "warn",
      headline: "We couldn’t confirm this post",
      detail: meta
        ? "Check your Instagram or Facebook, then tell us what happened."
        : "Check your Instagram or Buffer, then tell us what happened.",
      link: null,
      actions: ["posted", "not_posted"]
    };
  }

  if (state === "sent" && draft.status === "published") {
    return {
      tone: "good",
      headline: "Posted",
      detail: null,
      link: httpsLink(draft.posting_link),
      actions: []
    };
  }

  if (state === "drafted" && draft.status === "approved") {
    return meta
      ? {
          tone: "info",
          headline: "Test mode: nothing was posted",
          detail: "Automatic posting to Instagram or Facebook is in test mode, so this post was not sent.",
          link: null,
          actions: []
        }
      : {
          tone: "info",
          headline: "Saved as a draft in Buffer",
          detail: "Test mode: nothing was posted. Find it in Buffer.",
          link: null,
          actions: []
        };
  }

  if (draft.status === "failed" && (state === "error" || state === "missed")) {
    const errors = meta ? META_POSTING_ERRORS : POSTING_ERRORS;
    return {
      tone: "bad",
      headline: "Not posted",
      detail: (draft.posting_error_code ? errors[draft.posting_error_code] : undefined) ?? "Something went wrong sending it.",
      link: null,
      actions: ["approve_again"]
    };
  }

  return null;
}
