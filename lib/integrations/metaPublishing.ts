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

export type MetaPublishReceipt = ScheduleReceipt & { provider: "meta"; externalLink?: string | null };

// Instagram's published caption limit is 2,200 characters and 30 hashtags; a
// Facebook Page post allows 63,206 characters. Refuse instead of cutting a
// caption silently, so the owner sees why nothing was sent.
export const INSTAGRAM_CAPTION_LIMIT = 2200;
export const INSTAGRAM_HASHTAG_LIMIT = 30;
export const FACEBOOK_CAPTION_LIMIT = 63206;

export type MetaCaptionProblem = "caption_too_long" | "too_many_hashtags" | null;

export function metaCaptionProblem(target: MetaTarget, caption: string): MetaCaptionProblem {
  if (!caption.trim()) return "caption_too_long";
  if (target === "instagram") {
    // Spread by code point so an emoji counts once, like Meta's limit.
    if ([...caption].length > INSTAGRAM_CAPTION_LIMIT) return "caption_too_long";
    const hashtags = caption.match(/(^|\s)#[^\s#]+/g)?.length ?? 0;
    if (hashtags > INSTAGRAM_HASHTAG_LIMIT) return "too_many_hashtags";
  } else if (caption.length > FACEBOOK_CAPTION_LIMIT) {
    return "caption_too_long";
  }
  return null;
}

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

export type MetaContainerStatusCode = "in_progress" | "finished" | "published" | "error" | "expired";
export type MetaContainerStatusReceipt = {
  status: MetaContainerStatusCode;
  /** Present only once the container was published. */
  externalId: string | null;
  externalLink: string | null;
};

export interface MetaPublishingClient {
  /** Connect step: exchange a long-lived User token for the owner's Pages and linked Instagram accounts. */
  listPages(userAccessToken: string): Promise<MetaPage[]>;
  /**
   * Step 1 of the Instagram flow. Creating a container never publishes it, so a
   * retry after a lost response cannot create a second post.
   */
  createInstagramContainer(page: MetaPage, input: MetaPublishInput): Promise<{ containerId: string }>;
  /**
   * Step 2. Publishing the same container twice must never create a second post;
   * resume uses the recorded container id instead of a new container.
   */
  publishInstagramContainer(page: MetaPage, containerId: string): Promise<MetaPublishReceipt>;
  /** Read-only check used to resume after a crash between the two steps. */
  getContainerStatus(page: MetaPage, containerId: string): Promise<MetaContainerStatusReceipt>;
  /** Convenience for callers that want both steps in one call. */
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
    createInstagramContainer: unavailable,
    publishInstagramContainer: unavailable,
    getContainerStatus: unavailable,
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
export const META_CREATE_TASKS = new Set([
  "CREATE_CONTENT",
  "MANAGE",
  "PROFILE_PLUS_CREATE_CONTENT",
  "PROFILE_PLUS_FULL_CONTROL"
]);

function assertCanCreate(page: MetaPage): void {
  if (!page.tasks.some(task => META_CREATE_TASKS.has(task))) {
    throw new MetaRejected("the connected user cannot create content on this Page");
  }
}

/** Explicit local/test fake. It never calls Meta and never logs content. */
export class FakeMetaPublishingClient implements MetaPublishingClient {
  readonly calls: FakeCall[] = [];
  private sequence = 0;
  private containerSequence = 0;
  private failure: FakeMetaFailure;
  private readonly containers = new Map<string, { externalId: string | null; externalLink: string | null }>();

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

  async createInstagramContainer(page: MetaPage, input: MetaPublishInput): Promise<{ containerId: string }> {
    validPublishInput(input);
    assertCanCreate(page);
    if (!page.instagramBusinessAccountId) throw new MetaRejected("the Page has no linked Instagram professional account");
    this.assertAuth(page);
    this.containerSequence += 1;
    const containerId = `fake_container_${this.containerSequence}`;
    this.containers.set(containerId, { externalId: null, externalLink: null });
    return { containerId };
  }

  async publishInstagramContainer(page: MetaPage, containerId: string): Promise<MetaPublishReceipt> {
    const container = this.containers.get(containerId);
    if (!container) throw new MetaRejected("unknown Instagram container");
    // Publishing an already-published container returns the first post, never a
    // second one; the worker relies on this when resuming.
    if (container.externalId) return { provider: "meta", externalId: container.externalId, status: "published" };
    this.assertAuth(page);
    this.sequence += 1;
    container.externalId = `fake_ig_${this.sequence}`;
    this.calls.push({ method: "instagram", pageId: page.id });
    return { provider: "meta", externalId: container.externalId, status: "published" };
  }

  async getContainerStatus(_page: MetaPage, containerId: string): Promise<MetaContainerStatusReceipt> {
    const container = this.containers.get(containerId);
    if (!container) throw new MetaRejected("unknown Instagram container");
    return container.externalId
      ? { status: "published", externalId: container.externalId, externalLink: container.externalLink }
      : { status: "finished", externalId: null, externalLink: null };
  }

  async publishInstagramImage(page: MetaPage, input: MetaPublishInput): Promise<MetaPublishReceipt> {
    const { containerId } = await this.createInstagramContainer(page, input);
    return this.publishInstagramContainer(page, containerId);
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

  async createInstagramContainer(input: MetaPublishInput): Promise<{ containerId: string }> {
    if (this.options.target !== "instagram") throw new MetaRejected("this target is not Instagram");
    return this.options.client.createInstagramContainer(this.options.page, input);
  }

  async publishInstagramContainer(containerId: string): Promise<MetaPublishReceipt> {
    if (this.options.target !== "instagram") throw new MetaRejected("this target is not Instagram");
    return this.options.client.publishInstagramContainer(this.options.page, containerId);
  }

  async getContainerStatus(containerId: string): Promise<MetaContainerStatusReceipt> {
    if (this.options.target !== "instagram") throw new MetaRejected("this target is not Instagram");
    return this.options.client.getContainerStatus(this.options.page, containerId);
  }

  async getPostStatus(externalId: string): Promise<PostStatusReceipt> {
    return this.options.client.getPostStatus(externalId, this.options.page);
  }
}
