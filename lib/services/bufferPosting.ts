import { createHash, randomBytes } from "node:crypto";
import { query, transaction } from "../db";
import { errorFields, log } from "../log";
import { BufferSchedulerAdapter, SchedulerAmbiguous, SchedulerAuthError, SchedulerRateLimited, SchedulerRejected } from "../integrations/buffer";
import {
  liveMetaClient,
  META_CREATE_TASKS,
  MetaAmbiguous,
  MetaAuthError,
  MetaRateLimited,
  MetaRejected,
  MetaSchedulerAdapter,
  metaCaptionProblem,
  type MetaPage,
  type MetaPublishingClient,
  type MetaTarget
} from "../integrations/metaPublishing";
import type { SchedulePayload, ScheduleReceipt, SchedulerAdapter } from "../integrations/scheduler";
import { availableImage, providerDraftTransition } from "./draftLifecycle";
import { BufferConnectionError, getBufferAccessToken } from "./bufferConnection";
import { entitlementsFor } from "./entitlements";
import { ensureDraftJpeg } from "./imageRenderer";
import { getMetaPageCredentials, markMetaTargetNeedsReconnect, MetaConnectionError } from "./metaConnection";
import { postingMode, selectPostingProvider, type PostingMode, type PostingProvider } from "./postingGate";

// Posting through Buffer (#29 part 3) and direct Instagram/Facebook publishing (#234).
// The schedule lives in PraiseLoop. An owner who assigns a slot is explicitly
// authorizing that one approved post for that time (docs/decisions.md); nothing is
// ever posted without it. The worker sends the post when the time comes. The gate
// and the per-business provider choice are shared with the web routes
// (lib/services/postingGate.ts).

export type { PostingMode };
export { postingMode };

/** The worker may be down at the due time. Past this window the post is not sent late. */
export const LATE_WINDOW_MS = 2 * 60 * 60 * 1000;
/** A claim stuck in `submitting` is an unproven outcome (crash mid-call). */
export const STALE_SUBMITTING_MS = 10 * 60 * 1000;
/** Buffer's free plan allows 1,000 requests per channel per month, so status checks back off. */
export const CHECK_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
export const MAX_STATUS_CHECKS = 14;
/** A public image link never outlives these, even if nothing revokes it first. */
export const LIVE_IMAGE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
export const DRAFT_IMAGE_TTL_MS = 60 * 60 * 1000;
/** Bounded attempts for a retryable Meta failure; a rate limit cannot loop forever. */
export const MAX_SUBMIT_ATTEMPTS = 5;
export const MAX_RETRY_WAIT_MS = 60 * 60 * 1000;
/** Instagram may still be processing a freshly created container. */
export const CONTAINER_POLL_MS = 60_000;
const BATCH = 10;

export function hashImageToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
/** 256 random bits, unrelated to the draft id or filename. Only the hash is stored. */
export function newImageToken(): string {
  return randomBytes(32).toString("base64url");
}
export const IMAGE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Absolute HTTPS URL a provider fetches. Null (so nothing is sent) unless the base is https. */
export function publicMediaUrl(token: string, extension: "png" | "jpg", env: Env = process.env): string | null {
  try {
    const base = new URL(env.NEXTAUTH_URL ?? "");
    if (base.protocol !== "https:" || base.username || base.password) return null;
    return `${base.origin}/api/public-media/${token}.${extension}`;
  } catch {
    return null;
  }
}
export function publicImageUrl(token: string, env: Env = process.env): string | null {
  return publicMediaUrl(token, "png", env);
}
/** Direct Meta publishing uses the deterministic JPEG variant. */
export function publicMetaImageUrl(token: string, env: Env = process.env): string | null {
  return publicMediaUrl(token, "jpg", env);
}

/**
 * The media filename a public token may fetch, or null. Only a claim that is awaiting
 * submission or publication and has not expired serves its image; a revoked, finished
 * or unknown token is indistinguishable from a wrong one. `format` picks the stored
 * PNG or the deterministic JPEG variant served to Meta.
 */
export async function resolvePublicImage(token: string, format: "png" | "jpg" = "png"): Promise<string | null> {
  if (!IMAGE_TOKEN_PATTERN.test(token)) return null;
  const result = await query<{ image_path: string | null }>(
    `SELECT d.image_path FROM posting_slot_claims c JOIN draft_posts d ON d.id=c.draft_id
     WHERE c.image_token_hash=$1 AND c.image_expires_at>now() AND c.state IN ('submitting','submitted','unknown','drafted')`,
    [hashImageToken(token)]
  );
  const path = result.rows[0]?.image_path;
  const name = path?.match(/^\/api\/media\/([A-Za-z0-9][A-Za-z0-9._-]*\.png)$/)?.[1];
  if (!name) return null;
  if (format === "png") return name;
  const jpeg = await ensureDraftJpeg(`/api/media/${name}`);
  return jpeg?.name ?? null;
}

type Env = Record<string, string | undefined>;
type Tx = Parameters<Parameters<typeof transaction>[0]>[0];

async function audit(c: { query: (sql: string, params?: unknown[]) => Promise<unknown> }, action: string, reason: string) {
  await c.query("SELECT set_config('app.actor_id','worker',true),set_config('app.action',$1,true),set_config('app.reason',$2,true)", [action, reason]);
}

/** Ends a claim and moves its draft; a no-op if the claim already left `from`. */
async function settle(
  c: Tx,
  draftId: number,
  from: string[],
  state: string,
  draftStatus: string,
  fields: { errorCode?: string; bufferStatus?: string | null; revoke?: boolean; provider?: PostingProvider } = {}
) {
  const moved = await c.query(
    `UPDATE posting_slot_claims SET state=$2,error_code=$3,buffer_status=coalesce($4,buffer_status),
       image_token_hash=CASE WHEN $5 THEN NULL ELSE image_token_hash END,updated_at=now()
     WHERE draft_id=$1 AND state=ANY($6) RETURNING draft_id`,
    [draftId, state, fields.errorCode ?? null, fields.bufferStatus ?? null, fields.revoke ?? false, from]
  );
  if (!moved.rowCount) return false;
  (state === "error" || state === "missed" || state === "unknown" ? log.warn : log.info)("posting_claim_settled", { draftId, to: state, draftStatus, errorCode: fields.errorCode, providerStatus: fields.bufferStatus ?? undefined, provider: fields.provider });
  await audit(c, "posting", `posting:${fields.provider ? `${fields.provider}:` : ""}${state}${fields.errorCode ? `:${fields.errorCode}` : ""}`);
  // The same rule as draftMutation: only the current row moves, and the trigger
  // appends one draft_events row for the transition. A concurrent owner edit wins.
  await providerDraftTransition(c, draftId, draftStatus, "scheduled");
  return true;
}

export type PostingTickResult = { mode: PostingMode; missed: number; submitted: number; drafted: number; failed: number; unknown: number; requeued: number; checked: number; sent: number };

export type MetaPostingDeps = {
  /** Builds the Meta client. Tests inject a fake; production fails closed. */
  client?: MetaPublishingClient;
  /** Resolves the Page and its decrypted token. Tests inject a fake Page. */
  pageFor?: (args: { ownerId: string; businessId: number; metaPageId: number }) => Promise<MetaPage>;
};

export type PostingDeps = {
  mode?: PostingMode;
  now?: () => number;
  env?: Env;
  /** Builds the Buffer client for one owner's channel. Tests inject a fake. */
  adapterFor?: (args: { ownerId: string; channelId: string; service?: string; mode: "draft" | "live" }) => Promise<SchedulerAdapter>;
  /** Direct Meta publishing dependencies (#234). */
  meta?: MetaPostingDeps;
};

async function defaultAdapterFor({ ownerId, channelId, service, mode }: { ownerId: string; channelId: string; service?: string; mode: "draft" | "live" }) {
  return new BufferSchedulerAdapter({ accessToken: await getBufferAccessToken(ownerId), channelId, service, mode });
}

async function defaultMetaPage({ ownerId, metaPageId }: { ownerId: string; businessId: number; metaPageId: number }): Promise<MetaPage> {
  const credentials = await getMetaPageCredentials(ownerId, metaPageId);
  return {
    id: credentials.pageId,
    name: credentials.name,
    accessToken: credentials.accessToken,
    instagramBusinessAccountId: credentials.instagramBusinessAccountId,
    tasks: credentials.tasks
  };
}

async function metaAdapterFor(reserved: Reserved, mode: "draft" | "live", deps: PostingDeps): Promise<MetaSchedulerAdapter> {
  if (reserved.metaPageId === null || reserved.target === null) throw new MetaConnectionError("not_connected", 409);
  const page = await (deps.meta?.pageFor ?? defaultMetaPage)({
    ownerId: reserved.ownerId,
    businessId: reserved.businessId,
    metaPageId: reserved.metaPageId
  });
  return new MetaSchedulerAdapter({ target: reserved.target, page, client: deps.meta?.client ?? liveMetaClient() });
}

/** One pass of the posting worker: expire stale work, submit what is due, then check what was sent. */
export async function postingTick(deps: PostingDeps = {}): Promise<PostingTickResult> {
  const mode = deps.mode ?? postingMode(deps.env);
  const now = deps.now ?? Date.now;
  const result: PostingTickResult = { mode, missed: 0, submitted: 0, drafted: 0, failed: 0, unknown: 0, requeued: 0, checked: 0, sent: 0 };
  const staleBefore = new Date(now() - STALE_SUBMITTING_MS).toISOString();

  // A Meta Instagram submission is resumable: the container checkpoint is committed
  // before publishing, and creating a container alone never publishes anything. A
  // crash after the create is safe to requeue and continue with the same container,
  // but a claim that keeps crashing still stops at the retry bound.
  const exhausted = await query<{ draft_id: string }>(
    `SELECT draft_id FROM posting_slot_claims
     WHERE state='submitting' AND provider='meta' AND provider_target='instagram'
       AND updated_at < $1 AND submit_attempts >= $2`,
    [staleBefore, MAX_SUBMIT_ATTEMPTS]
  );
  for (const row of exhausted.rows) {
    const done = await transaction((c) => settle(c, Number(row.draft_id), ["submitting"], "error", "failed", { errorCode: "retry_exhausted", revoke: true, provider: "meta" }));
    if (done) result.failed += 1;
  }
  const resumable = await query<{ draft_id: string }>(
    `UPDATE posting_slot_claims SET state='queued',error_code=NULL,next_attempt_at=$2,updated_at=now()
     WHERE state='submitting' AND provider='meta' AND provider_target='instagram'
       AND updated_at < $1 AND submit_attempts < $3
     RETURNING draft_id`,
    [staleBefore, new Date(now()).toISOString(), MAX_SUBMIT_ATTEMPTS]
  );
  result.requeued += resumable.rowCount ?? 0;
  if (resumable.rowCount) log.warn("posting_resumed_meta_containers", { count: resumable.rowCount });

  // Everything else keeps the existing rule: a crash mid-call leaves an unproven
  // outcome. Never resubmit (Buffer and Facebook do not deduplicate for us).
  const stale = await query<{ draft_id: string }>(
    `UPDATE posting_slot_claims SET state='unknown',error_code='interrupted',updated_at=now()
     WHERE state='submitting' AND updated_at < $1
       AND (provider IS DISTINCT FROM 'meta' OR provider_target IS DISTINCT FROM 'instagram')
     RETURNING draft_id`,
    [staleBefore]
  );
  result.unknown += stale.rowCount ?? 0;
  if (stale.rowCount) log.warn("posting_interrupted_submissions", { count: stale.rowCount });
  log.debug("posting_tick_start", { mode });

  // A post that waited past the lateness window is shown as failed rather than going out at a surprising time.
  const late = await query<{ draft_id: string }>(
    "SELECT draft_id FROM posting_slot_claims WHERE state='queued' AND instant < $1",
    [new Date(now() - LATE_WINDOW_MS).toISOString()]
  );
  for (const row of late.rows) {
    const done = await transaction((c) => settle(c, Number(row.draft_id), ["queued"], "missed", "failed", { errorCode: "late" }));
    if (done) result.missed += 1;
  }

  if (mode === "off") { log.debug("posting_gate_off", { note: "BUFFER_POSTING_MODE is not draft or live, so nothing is sent to any provider" }); return result; }
  for (let i = 0; i < BATCH; i++) {
    const outcome = await submitNextDue(mode, now, deps);
    if (!outcome) break;
    result[outcome] += 1;
    // A provider asked us to slow down: leave the rest for a later tick instead of asking again right away.
    if (outcome === "requeued") break;
  }
  await reconcileSubmitted(now, deps, result);
  return result;
}

type SubmitOutcome = "submitted" | "drafted" | "failed" | "unknown" | "requeued";
type Reserved = {
  draftId: number; businessId: number; ownerId: string; caption: string;
  mode: "draft" | "live"; provider: PostingProvider; target: MetaTarget | null;
  metaPageId: number | null; containerId: string | null; submitAttempts: number;
  /** Buffer's channel, when the Buffer provider was chosen. */
  channelId: string | null; service: string | null;
  /** A fresh token, or null when resuming an existing Instagram container. */
  token: string | null; imageUrl: string | null;
};

async function submitNextDue(mode: "draft" | "live", now: () => number, deps: PostingDeps): Promise<SubmitOutcome | null> {
  const reserved = await transaction(async (c): Promise<Reserved | "failed" | null> => {
    const row = (await c.query(
      `SELECT c.draft_id,c.business_id,c.instant,b.owner_id,d.caption_text,d.image_path,d.status AS draft_status,
              c.provider AS claim_provider,c.provider_target AS claim_target,c.container_id,c.submit_attempts
       FROM posting_slot_claims c JOIN draft_posts d ON d.id=c.draft_id JOIN businesses b ON b.id=c.business_id
       WHERE c.state='queued' AND c.instant<=$1 AND (c.next_attempt_at IS NULL OR c.next_attempt_at<=$1)
       ORDER BY c.instant
       FOR UPDATE OF c SKIP LOCKED LIMIT 1`,
      [new Date(now()).toISOString()]
    )).rows[0];
    if (!row) return null;
    const draftId = Number(row.draft_id);
    const fail = async (code: string) => { await settle(c, draftId, ["queued"], "error", "failed", { errorCode: code }); return "failed" as const; };

    // Everything is re-checked now, under the claim lock: the owner may have changed their mind or their provider.
    if (row.draft_status !== "scheduled" || !String(row.caption_text).trim() || !(await availableImage(row.image_path))) return fail("draft_unavailable");
    // Automatic posting is a paid feature. A lapsed plan fails the queued post closed; it is never sent or resubmitted.
    if (!(await entitlementsFor(row.owner_id)).limits.automaticPosting) return fail("plan_required");

    const meta = (await c.query(
      `SELECT t.target,p.id AS meta_page_id,p.status AS page_status,p.instagram_business_account_id,p.tasks,c.status AS connection_status
       FROM business_meta_targets t JOIN meta_pages p ON p.id=t.meta_page_id
       JOIN meta_connections c ON c.id=p.connection_id WHERE t.business_id=$1`,
      [row.business_id]
    )).rows[0];
    const channel = (await c.query(
      `SELECT ch.channel_id,ch.service,ch.channel_type,bc.status FROM business_buffer_channels ch
       JOIN buffer_connections bc ON bc.id=ch.connection_id WHERE ch.business_id=$1 AND bc.owner_id=$2`,
      [row.business_id, row.owner_id]
    )).rows[0];

    // A claim keeps the provider it was first handed to. Otherwise Meta wins over
    // Buffer for a business that has both (lib/services/postingGate.ts).
    const provider = (row.claim_provider as PostingProvider | null)
      ?? selectPostingProvider({ metaTarget: !!meta, bufferChannel: !!channel });
    // Neither a Meta target nor a Buffer channel: keep the existing Buffer wording
    // for claims that predate provider selection.
    if (!provider) return fail("no_channel");

    let target: MetaTarget | null = null, metaPageId: number | null = null;
    if (provider === "meta") {
      if (!meta) return fail("not_connected");
      target = (row.claim_target as MetaTarget | null) ?? (meta.target as MetaTarget);
      // The target must still be the one the claim started with: never publish a
      // different account than the one the owner confirmed.
      if (!target || target !== meta.target) return fail("needs_reconnect");
      metaPageId = Number(meta.meta_page_id);
      if (meta.page_status !== "active" || meta.connection_status !== "active") return fail("needs_reconnect");
      if (!(meta.tasks ?? []).some((task: string) => META_CREATE_TASKS.has(task))) return fail("page_cannot_publish");
      if (target === "instagram" && !meta.instagram_business_account_id) return fail("instagram_unavailable");
      const captionProblem = metaCaptionProblem(target, row.caption_text);
      if (captionProblem) return fail(captionProblem);
      // Keep the deterministic JPEG ready before handing Meta a URL.
      if (!(await ensureDraftJpeg(row.image_path))) return fail("draft_unavailable");
    } else {
      if (!channel) return fail("no_channel");
      if (channel.status !== "active") return fail("needs_reconnect");
      if (channel.service === "instagram" && channel.channel_type !== "business") return fail("personal_instagram");
    }

    const resumeContainer = provider === "meta" && !!row.container_id;
    const token = resumeContainer ? null : newImageToken();
    const imageUrl = token
      ? provider === "meta" ? publicMetaImageUrl(token, deps.env) : publicImageUrl(token, deps.env)
      : null;
    if (!resumeContainer && !imageUrl) return fail("media_url_unavailable");

    const idempotencyKey = `meta:${draftId}:${new Date(row.instant).toISOString()}`;
    await c.query(
      `UPDATE posting_slot_claims SET state='submitting',mode=$2,provider=$3,provider_target=$4,
         image_token_hash=coalesce($5,image_token_hash),
         image_expires_at=CASE WHEN $5::text IS NULL THEN image_expires_at ELSE $6 END,
         submitted_at=coalesce(submitted_at,now()),idempotency_key=coalesce(idempotency_key,$7),
         next_attempt_at=NULL,submit_attempts=submit_attempts+1,updated_at=now()
       WHERE draft_id=$1`,
      [
        draftId, mode, provider, target, token ? hashImageToken(token) : null,
        token ? new Date(now() + (mode === "draft" ? DRAFT_IMAGE_TTL_MS : LIVE_IMAGE_TTL_MS)).toISOString() : null,
        provider === "meta" ? idempotencyKey : null
      ]
    );
    return {
      draftId, businessId: Number(row.business_id), ownerId: row.owner_id, caption: row.caption_text,
      mode, provider, target, metaPageId, containerId: row.container_id ?? null,
      channelId: channel?.channel_id ?? null, service: channel?.service ?? null,
      submitAttempts: Number(row.submit_attempts ?? 0) + 1, token, imageUrl
    };
  });
  if (reserved === null) return null;
  if (reserved === "failed") return "failed";

  // "submitting" is committed. From here on nothing may submit this post a second time.
  log.info("posting_submit_started", { draftId: reserved.draftId, mode, provider: reserved.provider });
  const finish = async (fn: (c: Tx) => Promise<unknown>): Promise<boolean> => {
    try { await transaction(async (c) => { await fn(c); }); return true; } catch { return false; }
  };
  return reserved.provider === "meta"
    ? submitMeta(reserved, now, deps, finish)
    : submitBuffer(reserved, now, deps, finish);
}

async function submitBuffer(reserved: Reserved, now: () => number, deps: PostingDeps, finish: (fn: (c: Tx) => Promise<unknown>) => Promise<boolean>): Promise<SubmitOutcome> {
  const mode = reserved.mode;
  try {
    if (!reserved.channelId) {
      await finish((c) => settle(c, reserved.draftId, ["submitting"], "error", "failed", { errorCode: "no_channel", revoke: true, provider: "buffer" }));
      return "failed";
    }
    const adapter = await (deps.adapterFor ?? defaultAdapterFor)({
      ownerId: reserved.ownerId, channelId: reserved.channelId, service: reserved.service ?? undefined, mode
    });
    const receipt = await adapter.submitPost(payload(reserved));
    log.info("posting_submit_accepted", { draftId: reserved.draftId, mode, providerStatus: receipt.status });
    if (mode === "draft") {
      // Saved as a Buffer draft: nothing was published, so the post returns to "approved".
      await finish(async (c) => {
        await c.query("UPDATE posting_slot_claims SET external_id=$2 WHERE draft_id=$1", [reserved.draftId, receipt.externalId]);
        await settle(c, reserved.draftId, ["submitting"], "drafted", "approved", { bufferStatus: receipt.status, provider: "buffer" });
      });
      return "drafted";
    }
    const saved = await finish(async (c) => {
      const moved = await c.query(
        `UPDATE posting_slot_claims SET state='submitted',external_id=$2,buffer_status=$3,next_check_at=$4,check_count=0,updated_at=now()
         WHERE draft_id=$1 AND state='submitting' RETURNING draft_id`,
        [reserved.draftId, receipt.externalId, receipt.status, new Date(now() + CHECK_BACKOFF_MS[0]).toISOString()]
      );
      if (!moved.rowCount) throw new Error("claim changed");
    });
    // Accepted by Buffer but not recorded here: it stays "submitting" and the sweep marks it unknown.
    return saved ? "submitted" : "unknown";
  } catch (error) {
    log.warn("posting_submit_failed", { draftId: reserved.draftId, mode, provider: "buffer", kind: error instanceof Error ? error.constructor.name : "unknown", ...errorFields(error) });
    if (error instanceof SchedulerRateLimited) {
      // Rejected before processing: safe to try again on a later tick, within the lateness window.
      await finish((c) => c.query("UPDATE posting_slot_claims SET state='queued',image_token_hash=NULL,next_attempt_at=NULL,updated_at=now() WHERE draft_id=$1 AND state='submitting'", [reserved.draftId]));
      return "requeued";
    }
    if (error instanceof BufferConnectionError) {
      // Getting a token failed, so nothing was sent. A passing failure (a network blip during refresh) is
      // retried on a later tick within the lateness window; a state the owner must fix is a visible failure.
      if (error.code === "failed" || error.code === "expired") {
        await finish((c) => c.query("UPDATE posting_slot_claims SET state='queued',image_token_hash=NULL,next_attempt_at=NULL,updated_at=now() WHERE draft_id=$1 AND state='submitting'", [reserved.draftId]));
        return "requeued";
      }
      await finish((c) => settle(c, reserved.draftId, ["submitting"], "error", "failed", { errorCode: error.code, revoke: true, provider: "buffer" }));
      return "failed";
    }
    if (error instanceof SchedulerAuthError) {
      await finish((c) => settle(c, reserved.draftId, ["submitting"], "error", "failed", { errorCode: "needs_reconnect", revoke: true, provider: "buffer" }));
      return "failed";
    }
    if (error instanceof SchedulerRejected) {
      await finish((c) => settle(c, reserved.draftId, ["submitting"], "error", "failed", { errorCode: "rejected", revoke: true, provider: "buffer" }));
      return "failed";
    }
    // Ambiguous or anything unexpected: the post may exist. Keep the link alive and never resubmit.
    const code = error instanceof SchedulerAmbiguous ? "ambiguous" : "unexpected";
    await finish((c) => settle(c, reserved.draftId, ["submitting"], "unknown", "scheduled", { errorCode: code, provider: "buffer" }));
    return "unknown";
  }
}

function payload(reserved: Reserved): SchedulePayload {
  if (!reserved.imageUrl) throw new SchedulerRejected("image link is unavailable");
  return { draftPostId: reserved.draftId, businessId: reserved.businessId, captionText: reserved.caption, mediaUrl: reserved.imageUrl };
}

/**
 * Direct Meta publishing (#234). Instagram is two provider calls: create a
 * container, persist its id, then publish. The persisted id is the idempotency
 * checkpoint, so a crash between the steps resumes instead of creating a second
 * post. Facebook has one call and no provider-side idempotency key, so an
 * ambiguous outcome is never resubmitted.
 */
async function submitMeta(reserved: Reserved, now: () => number, deps: PostingDeps, finish: (fn: (c: Tx) => Promise<unknown>) => Promise<boolean>): Promise<SubmitOutcome> {
  if (reserved.mode === "draft") {
    // Meta has no draft post type. Test mode still sends nothing: the preflight
    // ran, nothing was created or published, and the draft returns to "approved".
    const done = await finish((c) => settle(c, reserved.draftId, ["submitting"], "drafted", "approved", { bufferStatus: "draft", revoke: true, provider: "meta" }));
    return done ? "drafted" : "unknown";
  }

  let stage: "create" | "publish" | "facebook" = reserved.target === "instagram"
    ? reserved.containerId ? "publish" : "create"
    : "facebook";
  try {
    const adapter = await metaAdapterFor(reserved, reserved.mode, deps);
    if (reserved.target === "instagram") {
      let containerId = reserved.containerId;
      if (!containerId) {
        if (!reserved.imageUrl) throw new MetaRejected("image link is unavailable");
        const created = await adapter.createInstagramContainer({ caption: reserved.caption, imageUrl: reserved.imageUrl });
        // Commit the provider-side id BEFORE publishing. Publishing this same
        // container again cannot create a second post.
        const saved = await finish((c) => c.query(
          `UPDATE posting_slot_claims SET container_id=$2,updated_at=now()
           WHERE draft_id=$1 AND state='submitting' AND container_id IS NULL`,
          [reserved.draftId, created.containerId]
        ));
        if (!saved) return "unknown";
        containerId = created.containerId;
        stage = "publish";
      }
      // Confirm before publishing: after a crash between publish and recording the
      // receipt, the container is already published and must not be sent again.
      const status = await adapter.getContainerStatus(containerId);
      if (status.status === "published") {
        if (!status.externalId) return "unknown";
        return settlePublished(reserved, { provider: "meta", externalId: status.externalId, status: "published" }, status.externalLink, finish);
      }
      if (status.status === "error" || status.status === "expired") {
        await finish((c) => settle(c, reserved.draftId, ["submitting"], "error", "failed", { errorCode: "container_unavailable", revoke: true, provider: "meta" }));
        return "failed";
      }
      if (status.status === "in_progress") {
        // Instagram is still fetching/processing the image. Keep the token alive
        // and come back; this is not a failure and cannot double-post.
        return retryLater(reserved, CONTAINER_POLL_MS, now, finish, "retry_exhausted", true);
      }
      const receipt = await adapter.publishInstagramContainer(containerId);
      return settlePublished(reserved, receipt, receipt.externalLink ?? null, finish);
    }
    const receipt = await adapter.submitPost(payload(reserved));
    return settlePublished(reserved, receipt, receipt.externalLink ?? null, finish);
  } catch (error) {
    log.warn("posting_submit_failed", {
      draftId: reserved.draftId, mode: reserved.mode, provider: "meta", target: reserved.target, stage,
      kind: error instanceof Error ? error.constructor.name : "unknown", ...errorFields(error)
    });
    if (error instanceof MetaAuthError) {
      // Surface "reconnect needed" once; do not retry in a loop.
      if (reserved.metaPageId !== null) {
        try { await markMetaTargetNeedsReconnect(reserved.ownerId, reserved.metaPageId); } catch { /* the claim still fails visibly */ }
      }
      await finish((c) => settle(c, reserved.draftId, ["submitting"], "error", "failed", { errorCode: "needs_reconnect", revoke: true, provider: "meta" }));
      return "failed";
    }
    if (error instanceof MetaConnectionError) {
      const code = error.code === "needs_reconnect" ? "needs_reconnect" : "not_connected";
      await finish((c) => settle(c, reserved.draftId, ["submitting"], "error", "failed", { errorCode: code, revoke: true, provider: "meta" }));
      return "failed";
    }
    if (error instanceof MetaRateLimited) {
      // Meta refused the request, so nothing was posted. Wait, within a bound.
      return retryLater(reserved, error.retryAfterMs, now, finish, "rate_limited", true);
    }
    if (error instanceof MetaRejected) {
      await finish((c) => settle(c, reserved.draftId, ["submitting"], "error", "failed", { errorCode: "rejected", revoke: true, provider: "meta" }));
      return "failed";
    }
    if (error instanceof MetaAmbiguous) {
      if (stage === "create") {
        // A container may or may not exist, but creating one never publishes.
        return retryLater(reserved, CONTAINER_POLL_MS, now, finish, "retry_exhausted", false);
      }
      // Publishing may have been accepted. Never resubmit; keep the image link.
      await finish((c) => settle(c, reserved.draftId, ["submitting"], "unknown", "scheduled", { errorCode: "ambiguous", provider: "meta" }));
      return "unknown";
    }
    // Unexpected errors after a create step are retried (no post can exist yet).
    // After a publish step the outcome is unproven, exactly like MetaAmbiguous.
    if (stage === "create") return retryLater(reserved, CONTAINER_POLL_MS, now, finish, "retry_exhausted", false);
    await finish((c) => settle(c, reserved.draftId, ["submitting"], "unknown", "scheduled", { errorCode: "unexpected", provider: "meta" }));
    return "unknown";
  }
}

async function settlePublished(
  reserved: Reserved,
  receipt: ScheduleReceipt & { externalLink?: string | null },
  externalLink: string | null,
  finish: (fn: (c: Tx) => Promise<unknown>) => Promise<boolean>
): Promise<SubmitOutcome> {
  const saved = await finish(async (c) => {
    if (!(await settle(c, reserved.draftId, ["submitting"], "sent", "published", { bufferStatus: receipt.status, revoke: true, provider: "meta" }))) {
      throw new Error("claim changed");
    }
    await c.query(
      "UPDATE posting_slot_claims SET external_id=$2,external_link=$3,sent_at=coalesce(sent_at,now()) WHERE draft_id=$1",
      [reserved.draftId, receipt.externalId, externalLink]
    );
  });
  // Published, but the receipt could not be recorded. The container checkpoint
  // lets the next tick confirm it instead of posting again.
  return saved ? "submitted" : "unknown";
}

/** A retryable failure: requeue with backoff, or fail visibly after the bound. */
async function retryLater(
  reserved: Reserved,
  delayMs: number,
  now: () => number,
  finish: (fn: (c: Tx) => Promise<unknown>) => Promise<boolean>,
  exhaustedCode: "rate_limited" | "retry_exhausted",
  preserveImage: boolean
): Promise<SubmitOutcome> {
  if (reserved.submitAttempts >= MAX_SUBMIT_ATTEMPTS) {
    await finish((c) => settle(c, reserved.draftId, ["submitting"], "error", "failed", { errorCode: exhaustedCode, revoke: true, provider: "meta" }));
    return "failed";
  }
  const wait = Math.min(Math.max(delayMs, 1000), MAX_RETRY_WAIT_MS);
  const queued = await finish((c) => c.query(
    `UPDATE posting_slot_claims SET state='queued',image_token_hash=CASE WHEN $3 THEN image_token_hash ELSE NULL END,
       next_attempt_at=$2,updated_at=now()
     WHERE draft_id=$1 AND state='submitting'`,
    [reserved.draftId, new Date(now() + wait).toISOString(), preserveImage]
  ));
  return queued ? "requeued" : "unknown";
}

async function reconcileSubmitted(now: () => number, deps: PostingDeps, result: PostingTickResult) {
  for (let i = 0; i < BATCH; i++) {
    // Lease the claim by pushing its next check out before the network call, so two workers never poll it together.
    const claim = await transaction(async (c) => {
      const row = (await c.query(
        `SELECT c.draft_id,c.external_id,c.check_count,c.mode,b.owner_id,ch.channel_id
         FROM posting_slot_claims c JOIN businesses b ON b.id=c.business_id
         LEFT JOIN business_buffer_channels ch ON ch.business_id=c.business_id
         WHERE c.state='submitted' AND (c.provider IS NULL OR c.provider='buffer') AND c.next_check_at<=$1 ORDER BY c.next_check_at
         FOR UPDATE OF c SKIP LOCKED LIMIT 1`,
        [new Date(now()).toISOString()]
      )).rows[0];
      if (!row) return null;
      await c.query("UPDATE posting_slot_claims SET next_check_at=$2 WHERE draft_id=$1", [row.draft_id, new Date(now() + CHECK_BACKOFF_MS[CHECK_BACKOFF_MS.length - 1]).toISOString()]);
      return row as { draft_id: string; external_id: string; check_count: number; mode: "draft" | "live"; owner_id: string; channel_id: string | null };
    });
    if (!claim) return;
    result.checked += 1;
    const draftId = Number(claim.draft_id), checks = claim.check_count + 1;
    try {
      const adapter = await (deps.adapterFor ?? defaultAdapterFor)({ ownerId: claim.owner_id, channelId: claim.channel_id ?? "", mode: claim.mode });
      const status = await adapter.getPostStatus(claim.external_id);
      log.debug("posting_status_checked", { draftId, check: checks, providerStatus: status.status });
      if (status.status === "sent") {
        await transaction(async (c) => {
          if (await settle(c, draftId, ["submitted"], "sent", "published", { bufferStatus: status.status, revoke: true, provider: "buffer" })) {
            await c.query("UPDATE posting_slot_claims SET external_link=$2,sent_at=coalesce($3::timestamptz,now()) WHERE draft_id=$1", [draftId, status.externalLink, status.sentAt]);
          }
        });
        result.sent += 1;
        continue;
      }
      if (status.status === "error") {
        await transaction((c) => settle(c, draftId, ["submitted"], "error", "failed", { errorCode: "buffer_error", bufferStatus: status.status, revoke: true, provider: "buffer" }));
        result.failed += 1;
        continue;
      }
      await recheckLater(draftId, checks, status.status, now, result);
    } catch (error) {
      // A failed status read changes nothing about the post. Try again later, within the budget.
      log.warn("posting_status_check_failed", { draftId, check: checks, ...errorFields(error) });
      await recheckLater(draftId, checks, null, now, result);
    }
  }
}

async function recheckLater(draftId: number, checks: number, bufferStatus: string | null, now: () => number, result: PostingTickResult) {
  if (checks >= MAX_STATUS_CHECKS) {
    // Out of budget without an answer: the owner decides what happened. The link stays so Buffer can still finish.
    await transaction((c) => settle(c, draftId, ["submitted"], "unknown", "scheduled", { errorCode: "no_final_status", bufferStatus, provider: "buffer" }));
    result.unknown += 1;
    return;
  }
  const wait = CHECK_BACKOFF_MS[Math.min(checks, CHECK_BACKOFF_MS.length - 1)];
  await query(
    "UPDATE posting_slot_claims SET check_count=$2,buffer_status=coalesce($3,buffer_status),next_check_at=$4,updated_at=now() WHERE draft_id=$1 AND state='submitted'",
    [draftId, checks, bufferStatus, new Date(now() + wait).toISOString()]
  );
}
