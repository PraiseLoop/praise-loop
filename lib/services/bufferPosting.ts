import { createHash, randomBytes } from "node:crypto";
import { query, transaction } from "../db";
import { errorFields, log } from "../log";
import { BufferSchedulerAdapter, SchedulerAmbiguous, SchedulerAuthError, SchedulerRateLimited, SchedulerRejected } from "../integrations/buffer";
import type { SchedulerAdapter } from "../integrations/scheduler";
import { availableImage } from "./draftLifecycle";
import { BufferConnectionError, getBufferAccessToken } from "./bufferConnection";

// Posting through Buffer (#29 part 3). The schedule lives in PraiseLoop. An owner who assigns a
// slot is explicitly authorizing that one approved post for that time (docs/decisions.md);
// nothing is ever posted without it. The worker sends the post to Buffer when the time comes.

/**
 * The safety gate. `off` (the default, and what any unknown value means) never calls Buffer.
 * `draft` sends the post to Buffer as a DRAFT, so nothing is published. `live` publishes.
 */
type Env = Record<string, string | undefined>;
export type PostingMode = "off" | "draft" | "live";
export function postingMode(env: Env = process.env): PostingMode {
  const value = (env.BUFFER_POSTING_MODE ?? "").trim().toLowerCase();
  return value === "draft" || value === "live" ? value : "off";
}

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
const BATCH = 10;

export function hashImageToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
/** 256 random bits, unrelated to the draft id or filename. Only the hash is stored. */
export function newImageToken(): string {
  return randomBytes(32).toString("base64url");
}
export const IMAGE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Absolute HTTPS URL Buffer fetches. Null (so nothing is sent) unless the base is https. */
export function publicImageUrl(token: string, env: Env = process.env): string | null {
  try {
    const base = new URL(env.NEXTAUTH_URL ?? "");
    if (base.protocol !== "https:" || base.username || base.password) return null;
    return `${base.origin}/api/public-media/${token}.png`;
  } catch {
    return null;
  }
}

/**
 * The media filename a public token may fetch, or null. Only a claim that is awaiting
 * submission or publication and has not expired serves its image; a revoked, finished
 * or unknown token is indistinguishable from a wrong one.
 */
export async function resolvePublicImage(token: string): Promise<string | null> {
  if (!IMAGE_TOKEN_PATTERN.test(token)) return null;
  const result = await query<{ image_path: string | null }>(
    `SELECT d.image_path FROM posting_slot_claims c JOIN draft_posts d ON d.id=c.draft_id
     WHERE c.image_token_hash=$1 AND c.image_expires_at>now() AND c.state IN ('submitting','submitted','unknown','drafted')`,
    [hashImageToken(token)]
  );
  const path = result.rows[0]?.image_path;
  const name = path?.match(/^\/api\/media\/([A-Za-z0-9][A-Za-z0-9._-]*\.png)$/)?.[1];
  return name ?? null;
}

async function audit(c: { query: (sql: string, params?: unknown[]) => Promise<unknown> }, action: string, reason: string) {
  await c.query("SELECT set_config('app.actor_id','worker',true),set_config('app.action',$1,true),set_config('app.reason',$2,true)", [action, reason]);
}

type Tx = Parameters<Parameters<typeof transaction>[0]>[0];
/** Ends a claim and moves its draft; a no-op if the claim already left `from`. */
async function settle(c: Tx, draftId: number, from: string[], state: string, draftStatus: string, fields: { errorCode?: string; bufferStatus?: string | null; revoke?: boolean } = {}) {
  const moved = await c.query(
    `UPDATE posting_slot_claims SET state=$2,error_code=$3,buffer_status=coalesce($4,buffer_status),
       image_token_hash=CASE WHEN $5 THEN NULL ELSE image_token_hash END,updated_at=now()
     WHERE draft_id=$1 AND state=ANY($6) RETURNING draft_id`,
    [draftId, state, fields.errorCode ?? null, fields.bufferStatus ?? null, fields.revoke ?? false, from]
  );
  if (!moved.rowCount) return false;
  (state === "error" || state === "missed" || state === "unknown" ? log.warn : log.info)("posting_claim_settled", { draftId, to: state, draftStatus, errorCode: fields.errorCode, bufferStatus: fields.bufferStatus ?? undefined });
  await audit(c, "posting", `${state}${fields.errorCode ? `:${fields.errorCode}` : ""}`);
  await c.query("UPDATE draft_posts SET status=$2,updated_at=now() WHERE id=$1 AND status='scheduled'", [draftId, draftStatus]);
  return true;
}

export type PostingTickResult = { mode: PostingMode; missed: number; submitted: number; drafted: number; failed: number; unknown: number; requeued: number; checked: number; sent: number };

export type PostingDeps = {
  mode?: PostingMode;
  now?: () => number;
  env?: Env;
  /** Builds the Buffer client for one owner's channel. Tests inject a fake. */
  adapterFor?: (args: { ownerId: string; channelId: string; service?: string; mode: "draft" | "live" }) => Promise<SchedulerAdapter>;
};

async function defaultAdapterFor({ ownerId, channelId, service, mode }: { ownerId: string; channelId: string; service?: string; mode: "draft" | "live" }) {
  return new BufferSchedulerAdapter({ accessToken: await getBufferAccessToken(ownerId), channelId, service, mode });
}

/** One pass of the posting worker: expire stale work, submit what is due, then check what was sent. */
export async function postingTick(deps: PostingDeps = {}): Promise<PostingTickResult> {
  const mode = deps.mode ?? postingMode(deps.env);
  const now = deps.now ?? Date.now;
  const result: PostingTickResult = { mode, missed: 0, submitted: 0, drafted: 0, failed: 0, unknown: 0, requeued: 0, checked: 0, sent: 0 };

  // A crash between "submitting" and the answer leaves an unproven outcome. Never resubmit it.
  const stale = await query<{ draft_id: string }>(
    `UPDATE posting_slot_claims SET state='unknown',error_code='interrupted',updated_at=now()
     WHERE state='submitting' AND updated_at < $1 RETURNING draft_id`,
    [new Date(now() - STALE_SUBMITTING_MS).toISOString()]
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

  if (mode === "off") { log.debug("posting_gate_off", { note: "BUFFER_POSTING_MODE is not draft or live, so nothing is sent to Buffer" }); return result; }
  for (let i = 0; i < BATCH; i++) {
    const outcome = await submitNextDue(mode, now, deps);
    if (!outcome) break;
    result[outcome] += 1;
    // Buffer asked us to slow down: leave the rest for a later tick instead of asking again right away.
    if (outcome === "requeued") break;
  }
  await reconcileSubmitted(now, deps, result);
  return result;
}

type SubmitOutcome = "submitted" | "drafted" | "failed" | "unknown" | "requeued";
type Reserved = { draftId: number; businessId: number; ownerId: string; caption: string; channelId: string; service: string; token: string };

async function submitNextDue(mode: "draft" | "live", now: () => number, deps: PostingDeps): Promise<SubmitOutcome | null> {
  const reserved = await transaction(async (c): Promise<Reserved | "failed" | null> => {
    const row = (await c.query(
      `SELECT c.draft_id,c.business_id,b.owner_id,d.caption_text,d.image_path,d.status AS draft_status
       FROM posting_slot_claims c JOIN draft_posts d ON d.id=c.draft_id JOIN businesses b ON b.id=c.business_id
       WHERE c.state='queued' AND c.instant<=$1 ORDER BY c.instant
       FOR UPDATE OF c SKIP LOCKED LIMIT 1`,
      [new Date(now()).toISOString()]
    )).rows[0];
    if (!row) return null;
    const draftId = Number(row.draft_id);
    const fail = async (code: string) => { await settle(c, draftId, ["queued"], "error", "failed", { errorCode: code }); return "failed" as const; };

    // Everything is re-checked now, under the claim lock: the owner may have changed their mind or their Buffer.
    if (row.draft_status !== "scheduled" || !String(row.caption_text).trim() || !(await availableImage(row.image_path))) return fail("draft_unavailable");
    const channel = (await c.query(
      `SELECT ch.channel_id,ch.service,ch.channel_type,bc.status FROM business_buffer_channels ch
       JOIN buffer_connections bc ON bc.id=ch.connection_id WHERE ch.business_id=$1 AND bc.owner_id=$2`,
      [row.business_id, row.owner_id]
    )).rows[0];
    if (!channel) return fail("no_channel");
    if (channel.status !== "active") return fail("needs_reconnect");
    if (channel.service === "instagram" && channel.channel_type !== "business") return fail("personal_instagram");

    const token = newImageToken();
    if (!publicImageUrl(token, deps.env)) return fail("media_url_unavailable");
    await c.query(
      `UPDATE posting_slot_claims SET state='submitting',mode=$2,image_token_hash=$3,image_expires_at=$4,submitted_at=now(),updated_at=now()
       WHERE draft_id=$1`,
      [draftId, mode, hashImageToken(token), new Date(now() + (mode === "draft" ? DRAFT_IMAGE_TTL_MS : LIVE_IMAGE_TTL_MS)).toISOString()]
    );
    return { draftId, businessId: Number(row.business_id), ownerId: row.owner_id, caption: row.caption_text, channelId: channel.channel_id, service: String(channel.service ?? ""), token };
  });
  if (reserved === null) return null;
  if (reserved === "failed") return "failed";

  // "submitting" is committed. From here on nothing may submit this post a second time.
  log.info("posting_submit_started", { draftId: reserved.draftId, mode });
  const finish = async (fn: (c: Tx) => Promise<unknown>): Promise<boolean> => {
    try { await transaction(async (c) => { await fn(c); }); return true; } catch { return false; }
  };
  try {
    const adapter = await (deps.adapterFor ?? defaultAdapterFor)({ ownerId: reserved.ownerId, channelId: reserved.channelId, service: reserved.service, mode });
    const receipt = await adapter.submitPost({ draftPostId: reserved.draftId, businessId: reserved.businessId, captionText: reserved.caption, mediaUrl: publicImageUrl(reserved.token, deps.env)! });
    log.info("posting_submit_accepted", { draftId: reserved.draftId, mode, bufferStatus: receipt.status });
    if (mode === "draft") {
      // Saved as a Buffer draft: nothing was published, so the post returns to "approved".
      await finish(async (c) => {
        await c.query("UPDATE posting_slot_claims SET external_id=$2 WHERE draft_id=$1", [reserved.draftId, receipt.externalId]);
        await settle(c, reserved.draftId, ["submitting"], "drafted", "approved", { bufferStatus: receipt.status });
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
    log.warn("posting_submit_failed", { draftId: reserved.draftId, mode, kind: error instanceof Error ? error.constructor.name : "unknown", ...errorFields(error) });
    if (error instanceof SchedulerRateLimited) {
      // Rejected before processing: safe to try again on a later tick, within the lateness window.
      await finish((c) => c.query("UPDATE posting_slot_claims SET state='queued',image_token_hash=NULL,updated_at=now() WHERE draft_id=$1 AND state='submitting'", [reserved.draftId]));
      return "requeued";
    }
    if (error instanceof BufferConnectionError) {
      // Getting a token failed, so nothing was sent. A passing failure (a network blip during refresh) is
      // retried on a later tick within the lateness window; a state the owner must fix is a visible failure.
      if (error.code === "failed" || error.code === "expired") {
        await finish((c) => c.query("UPDATE posting_slot_claims SET state='queued',image_token_hash=NULL,updated_at=now() WHERE draft_id=$1 AND state='submitting'", [reserved.draftId]));
        return "requeued";
      }
      await finish((c) => settle(c, reserved.draftId, ["submitting"], "error", "failed", { errorCode: error.code, revoke: true }));
      return "failed";
    }
    if (error instanceof SchedulerAuthError) {
      await finish((c) => settle(c, reserved.draftId, ["submitting"], "error", "failed", { errorCode: "needs_reconnect", revoke: true }));
      return "failed";
    }
    if (error instanceof SchedulerRejected) {
      await finish((c) => settle(c, reserved.draftId, ["submitting"], "error", "failed", { errorCode: "rejected", revoke: true }));
      return "failed";
    }
    // Ambiguous or anything unexpected: the post may exist. Keep the link alive and never resubmit.
    const code = error instanceof SchedulerAmbiguous ? "ambiguous" : "unexpected";
    await finish((c) => settle(c, reserved.draftId, ["submitting"], "unknown", "scheduled", { errorCode: code }));
    return "unknown";
  }
}

async function reconcileSubmitted(now: () => number, deps: PostingDeps, result: PostingTickResult) {
  for (let i = 0; i < BATCH; i++) {
    // Lease the claim by pushing its next check out before the network call, so two workers never poll it together.
    const claim = await transaction(async (c) => {
      const row = (await c.query(
        `SELECT c.draft_id,c.external_id,c.check_count,c.mode,b.owner_id,ch.channel_id
         FROM posting_slot_claims c JOIN businesses b ON b.id=c.business_id
         LEFT JOIN business_buffer_channels ch ON ch.business_id=c.business_id
         WHERE c.state='submitted' AND c.next_check_at<=$1 ORDER BY c.next_check_at
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
      log.debug("posting_status_checked", { draftId, check: checks, bufferStatus: status.status });
      if (status.status === "sent") {
        await transaction(async (c) => {
          if (await settle(c, draftId, ["submitted"], "sent", "published", { bufferStatus: status.status, revoke: true })) {
            await c.query("UPDATE posting_slot_claims SET external_link=$2,sent_at=coalesce($3::timestamptz,now()) WHERE draft_id=$1", [draftId, status.externalLink, status.sentAt]);
          }
        });
        result.sent += 1;
        continue;
      }
      if (status.status === "error") {
        await transaction((c) => settle(c, draftId, ["submitted"], "error", "failed", { errorCode: "buffer_error", bufferStatus: status.status, revoke: true }));
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
    await transaction((c) => settle(c, draftId, ["submitted"], "unknown", "scheduled", { errorCode: "no_final_status", bufferStatus }));
    result.unknown += 1;
    return;
  }
  const wait = CHECK_BACKOFF_MS[Math.min(checks, CHECK_BACKOFF_MS.length - 1)];
  await query(
    "UPDATE posting_slot_claims SET check_count=$2,buffer_status=coalesce($3,buffer_status),next_check_at=$4,updated_at=now() WHERE draft_id=$1 AND state='submitted'",
    [draftId, checks, bufferStatus, new Date(now() + wait).toISOString()]
  );
}
