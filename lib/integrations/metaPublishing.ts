import type { PostStatusReceipt, SchedulePayload, ScheduleReceipt, SchedulerAdapter } from "./scheduler";

// Direct Instagram professional-account and Facebook Page publishing (#234).
// Feasibility is recorded in docs/integrations.md. The live client is not built:
// Advanced Access needs Meta App Review and Business Verification, which are
// owner tasks, so every live call fails closed. The fake adapter follows the
// Buffer adapter's shape so connection and posting work can land and be tested
// before access exists.
export type MetaTarget = "instagram" | "facebook";

export type MetaPage = {
  id: string;
  name: string;
  /** Long-lived Page token. It has no time expiry but Meta can invalidate it. */
  accessToken: string;
  /** The linked Instagram professional account, when the Page has one. */
  instagramBusinessAccountId: string | null;
  /** Page tasks such as CREATE_CONTENT and MANAGE. Publishing needs one of those. */
  tasks: string[];
};

export type MetaPublishInput = {
  caption: string;
  /** Public, direct HTTPS URL. Meta fetches it with no session or signature. */
  imageUrl: string;
};

export type MetaPublishReceipt = ScheduleReceipt & { provider: "meta" };

export class MetaAccessNotApproved extends Error {
  constructor() {
    super("Meta App Review and Business Verification are not complete; direct publishing is not available");
    this.name = "MetaAccessNotApproved";
  }
}

export class MetaAuthError extends Error {
  constructor() {
    super("Meta rejected the Page token; reconnect the Page and Instagram account");
    this.name = "MetaAuthError";
  }
}

export class MetaRateLimited extends Error {
  constructor(readonly retryAfterMs: number) {
    super("Meta rate limit reached; wait before trying again");
    this.name = "MetaRateLimited";
  }
}

/** Meta refused the post before creating anything, so a retry is safe. */
export class MetaRejected extends Error {
  constructor(message: string) {
    super(`Meta rejected the post (${message}); nothing was posted`);
    this.name = "MetaRejected";
  }
}

/** The request may have been accepted. Never resubmit without checking. */
export class MetaAmbiguous extends Error {
  constructor(message: string) {
    super(`Meta outcome unknown (${message}); check the account before retrying`);
    this.name = "MetaAmbiguous";
  }
}

export interface MetaPublishingClient {
  /** Connect step: exchange a long-lived User token for the owner's Pages and linked Instagram accounts. */
  listPages(userAccessToken: string): Promise<MetaPage[]>;
  publishInstagramImage(page: MetaPage, input: MetaPublishInput): Promise<MetaPublishReceipt>;
  publishPagePhoto(page: MetaPage, input: MetaPublishInput): Promise<MetaPublishReceipt>;
  getPostStatus(externalId: string, page: MetaPage): Promise<PostStatusReceipt>;
}

/**
 * The live client is deliberately absent until App Review exists. Every method
 * throws the named error rather than returning a fake success, so no caller can
 * mistake a missing integration for a published post.
 */
export function liveMetaClient(): MetaPublishingClient {
  const unavailable = async (): Promise<never> => { throw new MetaAccessNotApproved(); };
  return {
    listPages: unavailable,
    publishInstagramImage: unavailable,
    publishPagePhoto: unavailable,
    getPostStatus: unavailable
  };
}

export type FakeMetaFailure = "auth" | "rate_limit" | "rejected" | "ambiguous" | null;

type FakeMetaOptions = {
  pages?: MetaPage[];
  /** Make the next publish, and only that publish, fail in this way. */
  failure?: FakeMetaFailure;
  retryAfterMs?: number;
};

type FakeCall = { method: "listPages" | "instagram" | "facebook" | "status"; pageId: string | null };

function validPublishInput(input: MetaPublishInput): void {
  if (!input.caption.trim()) throw new MetaRejected("caption is required");
  let url: URL;
  try { url = new URL(input.imageUrl); } catch { throw new MetaRejected("image URL is required"); }
  if (url.protocol !== "https:") throw new MetaRejected("image URL must be public HTTPS");
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    throw new MetaRejected("meta cannot fetch a local image URL");
  }
}

// Meta only lets a Page post when the connected user can create content there.
// The connection layer checks this too; the adapter must not rely on the UI.
// Older tokens report CREATE_CONTENT/MANAGE, newer Page settings report the
// PROFILE_PLUS_* names, so accept both.
const CREATE_TASKS = new Set([
  "CREATE_CONTENT",
  "MANAGE",
  "PROFILE_PLUS_CREATE_CONTENT",
  "PROFILE_PLUS_FULL_CONTROL"
]);

function assertCanCreate(page: MetaPage): void {
  if (!page.tasks.some(task => CREATE_TASKS.has(task))) {
    throw new MetaRejected("the connected user cannot create content on this Page");
  }
}

/** Explicit local/test fake. It never calls Meta and never logs content. */
export class FakeMetaPublishingClient implements MetaPublishingClient {
  readonly calls: FakeCall[] = [];
  private sequence = 0;
  private failure: FakeMetaFailure;

  constructor(private readonly options: FakeMetaOptions = {}) {
    this.failure = options.failure ?? null;
  }

  private takeFailure(): FakeMetaFailure {
    const failure = this.failure;
    this.failure = null;
    return failure;
  }

  private assertAuth(page: MetaPage): void {
    if (!page.accessToken) throw new MetaAuthError();
    const failure = this.takeFailure();
    if (failure === "auth") throw new MetaAuthError();
    if (failure === "rate_limit") throw new MetaRateLimited(this.options.retryAfterMs ?? 60_000);
    if (failure === "rejected") throw new MetaRejected("synthetic rejection");
    if (failure === "ambiguous") throw new MetaAmbiguous("synthetic timeout");
  }

  async listPages(userAccessToken: string): Promise<MetaPage[]> {
    if (!userAccessToken || userAccessToken === "revoked") throw new MetaAuthError();
    this.calls.push({ method: "listPages", pageId: null });
    return this.options.pages ?? [];
  }

  async publishInstagramImage(page: MetaPage, input: MetaPublishInput): Promise<MetaPublishReceipt> {
    validPublishInput(input);
    assertCanCreate(page);
    if (!page.instagramBusinessAccountId) throw new MetaRejected("the Page has no linked Instagram professional account");
    this.assertAuth(page);
    this.calls.push({ method: "instagram", pageId: page.id });
    this.sequence += 1;
    return { provider: "meta", externalId: `fake_ig_${this.sequence}`, status: "published" };
  }

  async publishPagePhoto(page: MetaPage, input: MetaPublishInput): Promise<MetaPublishReceipt> {
    validPublishInput(input);
    assertCanCreate(page);
    this.assertAuth(page);
    this.calls.push({ method: "facebook", pageId: page.id });
    this.sequence += 1;
    return { provider: "meta", externalId: `fake_fb_${this.sequence}`, status: "published" };
  }

  async getPostStatus(_externalId: string): Promise<PostStatusReceipt> {
    this.calls.push({ method: "status", pageId: null });
    return {
      status: "published",
      externalLink: null,
      sentAt: null,
      errorMessage: null
    };
  }
}

type MetaSchedulerOptions = {
  target: MetaTarget;
  page: MetaPage;
  client: MetaPublishingClient;
};

/**
 * The same scheduler shape Buffer uses, so the draft lifecycle and approval do
 * not care which provider posts. The connection layer decides the target and the
 * Page; this adapter only translates a due post into one provider call.
 */
export class MetaSchedulerAdapter implements SchedulerAdapter {
  constructor(private readonly options: MetaSchedulerOptions) {}

  async submitPost(payload: SchedulePayload): Promise<MetaPublishReceipt> {
    const input = { caption: payload.captionText, imageUrl: payload.mediaUrl };
    return this.options.target === "instagram"
      ? this.options.client.publishInstagramImage(this.options.page, input)
      : this.options.client.publishPagePhoto(this.options.page, input);
  }

  async getPostStatus(externalId: string): Promise<PostStatusReceipt> {
    return this.options.client.getPostStatus(externalId, this.options.page);
  }
}
