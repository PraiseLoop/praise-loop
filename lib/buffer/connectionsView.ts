// Pure wording and state rules for the web Buffer connections screen (#29 part 2).
// No fetch and no DOM: the page renders these and the tests exercise them directly.

export type BufferChannel = { id: string; name: string; service: string; type: string };
export type BufferConnectionSummary = {
  connected: boolean;
  status: "active" | "needs_reconnect" | null;
  channels: BufferChannel[];
};
export type BufferConnectionView = "not_connected" | "active" | "needs_reconnect";

// The callback only puts a fixed outcome code in the URL. Unknown values show
// nothing, so a crafted link cannot put text on the page.
const OUTCOME_MESSAGES: Record<string, string> = {
  connected: "Buffer is connected.",
  denied: "You didn’t approve the connection in Buffer. You can try again.",
  expired: "That connection attempt took too long. Please start again.",
  failed: "We couldn’t finish connecting to Buffer. Please try again.",
  not_configured: "Buffer isn’t set up on this server yet.",
  plan_required: "Automatic posting is included in Pro and Business, so this plan can’t connect Buffer. Your phone share sheet and image download still work."
};

export function outcomeMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return OUTCOME_MESSAGES[code] ?? null;
}

// The channel routes answer with short codes; owners see a plain sentence.
const CHANNEL_ERRORS: Record<string, string> = {
  invalid_channel: "That channel can’t be used for this business. Pick another one.",
  not_found: "We couldn’t find that business. Reload the page and try again.",
  not_connected: "Buffer isn’t connected. Connect it again to choose a channel.",
  needs_reconnect: "Your Buffer connection stopped working. Reconnect Buffer to continue.",
  connection_changed: "Your Buffer account changed. Reload the page to see the current channels.",
  plan_required: "Automatic posting is included in Pro and Business, so this plan can’t choose a Buffer channel.",
  unknown: "We couldn’t save that channel. Try again."
};

export function channelErrorMessage(code: string | null | undefined): string {
  return (code ? CHANNEL_ERRORS[code] : undefined) ?? CHANNEL_ERRORS.unknown;
}

/** Both mean the channel list on screen is no longer trustworthy. */
export function shouldReloadConnection(code: string | null | undefined): boolean {
  return code === "needs_reconnect" || code === "connection_changed";
}

// Fail closed: a connection is only usable when the server says it is active.
export function connectionView(summary: BufferConnectionSummary): BufferConnectionView {
  if (!summary.connected) return "not_connected";
  return summary.status === "active" ? "active" : "needs_reconnect";
}

// The page sends the browser to whatever address the server returns. It is our own
// authenticated API, but only Buffer's sign-in page is a valid place to go, so anything
// else is refused rather than navigated to.
export function isBufferAuthorizeUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "auth.buffer.com" && url.pathname === "/auth" && !url.username && !url.password && !url.port;
  } catch {
    return false;
  }
}

export function isPersonalInstagram(channel: { service: string; type: string } | null | undefined): boolean {
  return channel?.service === "instagram" && channel.type !== "business";
}

export function channelOptionLabel(channel: BufferChannel): string {
  const service = channel.service === "instagram" ? "Instagram" : channel.service === "facebook" ? "Facebook" : channel.service;
  return `${channel.name} (${service})`;
}

export type RequestGuard = {
  /** Starts a request and returns its token. */
  begin(): number;
  /** True only for the most recently started request. */
  isLatest(token: number): boolean;
};

// One guard per business: a late response from an older selection must not
// overwrite the selection made after it.
export function createRequestGuard(): RequestGuard {
  let latest = 0;
  return {
    begin: () => ++latest,
    isLatest: (token: number) => token === latest
  };
}
