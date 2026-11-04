// Pure wording for the "is posting set up?" banner on the web approval and schedule
// pages (#205). No fetch and no DOM: the banner renders this and the tests exercise it.

export type PostingGate = "off" | "draft" | "live";
export type SetupState = "off" | "not_connected" | "needs_reconnect" | "no_channel" | "personal_instagram" | "ready";

export type PostingSetup = { state: SetupState; mode: PostingGate; channelName: string | null; channelService: string | null };

export type SetupBanner = {
  tone: "info" | "warn";
  headline: string;
  detail: string;
  link: { href: string; label: string } | null;
};

const CONNECTIONS = "/connections";

/** The banner to show, or null when posting is live and nothing needs the owner's attention. */
export function setupBanner(setup: PostingSetup): SetupBanner | null {
  switch (setup.state) {
    case "off":
      return { tone: "info", headline: "Posting is switched off for now.", detail: "Approved posts are lined up in your schedule, but nothing is sent until posting is turned on.", link: null };
    case "not_connected":
      return { tone: "warn", headline: "Posting isn’t connected yet.", detail: "Approved posts are lined up in your schedule, but nothing goes live until you connect Buffer and choose where to post.", link: { href: CONNECTIONS, label: "Connect Buffer" } };
    case "needs_reconnect":
      return { tone: "warn", headline: "Buffer needs to be reconnected.", detail: "Lined-up posts are held until you reconnect.", link: { href: CONNECTIONS, label: "Reconnect Buffer" } };
    case "no_channel":
      return { tone: "warn", headline: "Choose where this business posts.", detail: "Buffer is connected, but no channel is chosen for this business, so nothing can be sent.", link: { href: CONNECTIONS, label: "Choose a channel" } };
    case "personal_instagram":
      return { tone: "warn", headline: "This Instagram account can’t be posted to.", detail: "Buffer can only post to a Business Instagram account. Switch the account or choose another channel.", link: { href: CONNECTIONS, label: "Change channel" } };
    case "ready":
      if (setup.mode === "draft") {
        const where = setup.channelName ? ` for ${setup.channelName}` : "";
        return { tone: "info", headline: "Test mode: posts are saved as drafts.", detail: `Lined-up posts are saved as drafts in Buffer${where}. Nothing is published.`, link: { href: CONNECTIONS, label: "Connections" } };
      }
      return null;
  }
}

/** Decides the state from facts the server already has. Order matters: the most actionable problem wins. */
export function setupState(input: { mode: PostingGate; connection: "active" | "needs_reconnect" | null; channel: { service: string; type: string } | null }): SetupState {
  if (input.mode === "off") return "off";
  if (!input.connection) return "not_connected";
  if (input.connection === "needs_reconnect") return "needs_reconnect";
  if (!input.channel) return "no_channel";
  if (input.channel.service === "instagram" && input.channel.type !== "business") return "personal_instagram";
  return "ready";
}
