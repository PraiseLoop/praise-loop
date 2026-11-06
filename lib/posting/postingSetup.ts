// Pure wording for the "is posting set up?" banner on the web approval and schedule
// pages (#205) and the provider-neutral connected-state rule shared by both posting
// providers (#234). No fetch and no DOM: the banner renders this and the tests
// exercise it directly.
import { META_CREATE_TASKS } from "../integrations/metaPublishing";
import { selectPostingProvider, type PostingProvider } from "../services/postingGate";

export type PostingGate = "off" | "draft" | "live";
export type SetupState = "off" | "not_connected" | "needs_reconnect" | "no_channel" | "personal_instagram" | "page_cannot_publish" | "ready";

export type PostingSetup = {
  state: SetupState;
  mode: PostingGate;
  /** Which provider the worker will use, or null when the business has no target yet. */
  provider: PostingProvider | null;
  channelName: string | null;
  channelService: string | null;
};

export type SetupBanner = {
  tone: "info" | "warn";
  headline: string;
  detail: string;
  link: { href: string; label: string } | null;
};

export type SetupBufferInput = {
  connection: "active" | "needs_reconnect" | null;
  channel: { service: string; type: string } | null;
};
export type SetupMetaInput = {
  connection: "active" | "needs_reconnect" | null;
  target: { target: "instagram" | "facebook"; pageStatus: "active" | "needs_reconnect"; tasks: string[] } | null;
};

const CONNECTIONS = "/connections";

function metaCanPublish(tasks: string[]): boolean {
  return tasks.some(task => META_CREATE_TASKS.has(task));
}

/**
 * Decides the state from facts the server already has. The provider choice is the
 * same `selectPostingProvider` rule the scheduler and worker use, so the banner can
 * never disagree with who would actually receive the post. Order matters: the most
 * actionable problem wins.
 */
export function setupState(input: { mode: PostingGate; buffer: SetupBufferInput; meta: SetupMetaInput }): SetupState {
  if (input.mode === "off") return "off";
  const provider = selectPostingProvider({
    metaTarget: !!input.meta.target,
    bufferChannel: !!input.buffer.channel
  });

  if (provider === "meta") {
    if (!input.meta.connection) return "not_connected";
    if (input.meta.connection !== "active" || input.meta.target?.pageStatus !== "active") return "needs_reconnect";
    if (!metaCanPublish(input.meta.target.tasks)) return "page_cannot_publish";
    return "ready";
  }

  if (provider === "buffer") {
    if (!input.buffer.connection) return "not_connected";
    if (input.buffer.connection !== "active") return "needs_reconnect";
    if (input.buffer.channel?.service === "instagram" && input.buffer.channel.type !== "business") return "personal_instagram";
    return "ready";
  }

  // A flagged connection is actionable even before a target exists; a working
  // connection without a target is still "connected", so ask for the target
  // instead of claiming nothing is connected.
  if (input.buffer.connection === "needs_reconnect" || input.meta.connection === "needs_reconnect") return "needs_reconnect";
  if (input.buffer.connection || input.meta.connection) return "no_channel";
  return "not_connected";
}

/** The banner to show, or null when posting is live and nothing needs the owner's attention. */
export function setupBanner(setup: PostingSetup): SetupBanner | null {
  const meta = setup.provider === "meta";
  switch (setup.state) {
    case "off":
      return { tone: "info", headline: "Posting is switched off for now.", detail: "Approved posts are lined up in your schedule, but nothing is sent until posting is turned on.", link: null };
    case "not_connected":
      return { tone: "warn", headline: "Posting isn’t connected yet.", detail: "Approved posts are lined up in your schedule, but nothing goes live until you connect Instagram, Facebook or Buffer and choose where to post.", link: { href: CONNECTIONS, label: "Connect Instagram or Facebook" } };
    case "needs_reconnect":
      if (meta) return { tone: "warn", headline: "Instagram or Facebook needs to be reconnected.", detail: "Lined-up posts are held until you reconnect.", link: { href: CONNECTIONS, label: "Reconnect Instagram or Facebook" } };
      if (setup.provider === "buffer") return { tone: "warn", headline: "Buffer needs to be reconnected.", detail: "Lined-up posts are held until you reconnect.", link: { href: CONNECTIONS, label: "Reconnect Buffer" } };
      // No target is chosen yet, so either provider could be the flagged one.
      return { tone: "warn", headline: "A posting connection needs to be reconnected.", detail: "Lined-up posts are held until you reconnect Instagram, Facebook or Buffer.", link: { href: CONNECTIONS, label: "Manage connections" } };
    case "no_channel":
      return { tone: "warn", headline: "Choose where this business posts.", detail: "A posting connection is ready, but no target is chosen for this business, so nothing can be sent.", link: { href: CONNECTIONS, label: "Choose a target" } };
    case "personal_instagram":
      return { tone: "warn", headline: "This Instagram account can’t be posted to.", detail: "Buffer can only post to a Business Instagram account. Switch the account or choose another channel.", link: { href: CONNECTIONS, label: "Change channel" } };
    case "page_cannot_publish":
      return { tone: "warn", headline: "This Facebook Page can’t publish.", detail: "The Page doesn’t give PraiseLoop permission to publish. Reconnect and choose another Page, or use Buffer.", link: { href: CONNECTIONS, label: "Change target" } };
    case "ready":
      if (setup.mode === "draft") {
        const where = setup.channelName ? ` for ${setup.channelName}` : "";
        return meta
          ? { tone: "info", headline: "Test mode: nothing is published.", detail: `Automatic posting to Instagram or Facebook is in test mode, so lined-up posts${where} are not sent.`, link: { href: CONNECTIONS, label: "Connections" } }
          : { tone: "info", headline: "Test mode: posts are saved as drafts.", detail: `Lined-up posts are saved as drafts in Buffer${where}. Nothing is published.`, link: { href: CONNECTIONS, label: "Connections" } };
      }
      return null;
  }
}
