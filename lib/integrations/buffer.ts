import type { PostStatusReceipt, SchedulePayload, ScheduleReceipt, SchedulerAdapter } from "./scheduler";
// Buffer GraphQL adapter (https://developers.buffer.com, see docs/integrations.md).
// The mutation and query shapes were checked against Buffer's published schema by
// introspection on 2026-11-02 (CreatePostInput requires channelId, assets, mode,
// needsApproval and schedulingType). No post has been created against a live account yet:
// the first one is the owner-approved test in `draft` mode.
export class SchedulerAuthError extends Error { constructor() { super("Buffer rejected the credentials; reconnect the channel."); } }
export class SchedulerRateLimited extends Error { constructor(public retryAfterMs: number) { super("Buffer rate limit persisted after bounded retries; nothing was submitted."); } }
export class SchedulerRejected extends Error { constructor(m: string) { super(`Buffer rejected the post (${m}); nothing was posted.`); } }
// Request may have been accepted. Callers must persist an unknown outcome and reconcile
// manually or via the post-status API; they must NOT resubmit (no provider dedupe).
export class SchedulerAmbiguous extends Error { constructor(m: string) { super(`Buffer outcome unknown (${m}); check the channel before retrying.`); } }
export type PostingMode = "draft" | "live";
export type BufferOptions = { accessToken: string; channelId: string; mode: PostingMode; fetchImpl?: typeof fetch; timeoutMs?: number; maxRateLimitRetries?: number; sleep?: (ms: number) => Promise<void>; endpoint?: string };
const CREATE = `mutation($input: CreatePostInput!){ createPost(input:$input){ __typename ... on PostActionSuccess { post { id status } } ... on MutationError { message } } }`;
const STATUS = `query($input: PostInput!){ post(input:$input){ id status externalLink sentAt error { message } } }`;
// Error types Buffer returns for a request it refused before creating anything. Only these
// prove nothing was posted; UnexpectedError and RestProxyError may have had side effects.
const REFUSED = new Set(["InvalidInputError", "PostInvalidInputError", "NotFoundError", "PostChannelNotFoundError", "LimitReachedError", "PostLimitReachedError", "DuplicateError", "PostNotDeletableError"]);
type Json = { data?: Record<string, any>; errors?: { message?: string; extensions?: { code?: string } }[] };
export class BufferSchedulerAdapter implements SchedulerAdapter {
  constructor(private o: BufferOptions) {}
  private async call(body: string): Promise<Json> {
    const max = this.o.maxRateLimitRetries ?? 2, sleep = this.o.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await (this.o.fetchImpl ?? fetch)(this.o.endpoint ?? "https://api.buffer.com", { method: "POST", body, signal: AbortSignal.timeout(this.o.timeoutMs ?? 15000), headers: { "content-type": "application/json", authorization: `Bearer ${this.o.accessToken}` } });
      } catch { throw new SchedulerAmbiguous("timeout or network failure after send"); }
      if (res.status === 401 || res.status === 403) throw new SchedulerAuthError();
      if (res.status === 429) { // rejected before processing: safe to retry, bounded
        const wait = Math.max(Number(res.headers.get("retry-after")) || 1, 1) * 1000;
        // A window longer than we are willing to wait is surfaced as-is, not shortened into a retry that cannot succeed.
        if (attempt >= max || wait > 60000) throw new SchedulerRateLimited(wait);
        await sleep(wait); continue;
      }
      if (!res.ok) throw new SchedulerAmbiguous(`HTTP ${res.status}`);
      try { return await res.json() as Json; } catch { throw new SchedulerAmbiguous("unreadable response"); }
    }
  }
  /** Sends the post now (`live`) or saves it as a Buffer draft (`draft`). Never schedules in Buffer's queue. */
  async submitPost(p: SchedulePayload): Promise<ScheduleReceipt> {
    if (!p.captionText.trim() || !p.mediaUrl) throw new SchedulerRejected("incomplete draft: caption and provider-fetchable media required");
    const input = { channelId: this.o.channelId, text: p.captionText, schedulingType: "automatic", mode: "shareNow", needsApproval: false, saveToDraft: this.o.mode === "draft", assets: [{ image: { url: p.mediaUrl } }] };
    const json = await this.call(JSON.stringify({ query: CREATE, variables: { input } }));
    const r = json.data?.createPost;
    if (r?.post?.id) return { provider: "buffer", externalId: String(r.post.id), status: String(r.post.status ?? "") };
    if (json.errors?.length) {
      // GraphQL-level errors: only input/validation codes prove nothing was posted. Auth failures map to
      // the auth error; anything else (e.g. UNEXPECTED) may have had side effects, so it stays ambiguous.
      const codes = json.errors.map(e => e.extensions?.code ?? "");
      if (codes.some(c => c === "UNAUTHORIZED" || c === "FORBIDDEN")) throw new SchedulerAuthError();
      if (codes.every(c => c === "BAD_USER_INPUT" || c === "GRAPHQL_VALIDATION_FAILED")) throw new SchedulerRejected((json.errors[0].message ?? "error").slice(0, 120));
      throw new SchedulerAmbiguous(`GraphQL error ${codes[0] || "unknown"}`);
    }
    const type = String(r?.__typename ?? "");
    if (type === "UnauthorizedError" || type === "ChannelRefreshRequired") throw new SchedulerAuthError();
    if (r?.message && REFUSED.has(type)) throw new SchedulerRejected(String(r.message).slice(0, 120));
    throw new SchedulerAmbiguous(type ? `Buffer answered ${type}` : "response without post id");
  }
  /** Reads a submitted post's state. Read-only, so a failure here never risks a duplicate post. */
  async getPostStatus(externalId: string): Promise<PostStatusReceipt> {
    const json = await this.call(JSON.stringify({ query: STATUS, variables: { input: { id: externalId } } }));
    const post = json.data?.post;
    if (!post?.id || typeof post.status !== "string") throw new SchedulerAmbiguous("status response without a post");
    return { status: post.status, externalLink: typeof post.externalLink === "string" ? post.externalLink : null, sentAt: typeof post.sentAt === "string" ? post.sentAt : null, errorMessage: typeof post.error?.message === "string" ? post.error.message.slice(0, 200) : null };
  }
}
