// The automatic-posting gate and provider choice, shared by the web routes and the
// worker (#29 part 3, #234). Buffer and direct Meta publishing use the same gate:
// an owner who confirms a specific approved post for a specific slot authorises
// that one post, and nothing else. The environment variable keeps its historical
// Buffer-specific name so existing deployments do not change behaviour.
type Env = Record<string, string | undefined>;
export type PostingMode = "off" | "draft" | "live";

/** `off` (the default, and what any unknown value means) never calls a provider. */
export function postingMode(env: Env = process.env): PostingMode {
  const value = (env.BUFFER_POSTING_MODE ?? "").trim().toLowerCase();
  return value === "draft" || value === "live" ? value : "off";
}

/** Provider-neutral name for the same gate. */
export const automaticPostingMode = postingMode;

export type PostingProvider = "buffer" | "meta";

/**
 * Which provider a business uses. Meta wins when both a Meta target and a Buffer
 * channel exist: choosing a Meta target is the explicit action from #234, and
 * "prefer the newest explicit target" cannot change under a write race the way
 * ordering by created_at could. A business with neither has no provider.
 */
export function selectPostingProvider(input: { metaTarget: boolean; bufferChannel: boolean }): PostingProvider | null {
  if (input.metaTarget) return "meta";
  if (input.bufferChannel) return "buffer";
  return null;
}
