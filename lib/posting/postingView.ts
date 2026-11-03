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

  if (state === "queued" && draft.status === "scheduled") {
    return {
      tone: "info",
      headline: "Waiting for its time",
      detail: "It will be sent to Buffer at the scheduled time.",
      link: null,
      actions: ["cancel"]
    };
  }

  if (state === "submitting") {
    return { tone: "info", headline: "Sending to Buffer…", detail: null, link: null, actions: [] };
  }

  if (state === "submitted") {
    return { tone: "info", headline: "Sent to Buffer — waiting for it to go out", detail: null, link: null, actions: [] };
  }

  if (state === "unknown" && draft.status === "scheduled") {
    return {
      tone: "warn",
      headline: "We couldn’t confirm this post",
      detail: "Check your Instagram or Buffer, then tell us what happened.",
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
    return {
      tone: "info",
      headline: "Saved as a draft in Buffer",
      detail: "Test mode: nothing was posted. Find it in Buffer.",
      link: null,
      actions: []
    };
  }

  if (draft.status === "failed" && (state === "error" || state === "missed")) {
    return {
      tone: "bad",
      headline: "Not posted",
      detail: (draft.posting_error_code ? POSTING_ERRORS[draft.posting_error_code] : undefined) ?? "Something went wrong sending it.",
      link: null,
      actions: ["approve_again"]
    };
  }

  return null;
}
