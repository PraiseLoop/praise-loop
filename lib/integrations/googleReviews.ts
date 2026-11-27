import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { query, transaction } from "../db";
import { GoogleApiError, googleBusinessClient, googleBusinessConfig } from "./googleBusiness";

type Env = Record<string, string | undefined>;

// The REST client owns the error class and the shared read-only contract; the
// sync keeps importing them from here so existing callers do not change.
export { GoogleApiError };
export type { GoogleReview, GoogleReviewsClient } from "./googleBusiness";
import type { GoogleReviewsClient } from "./googleBusiness";

/**
 * Connect and sync stay off until the operator opt-ins: the flag must be `1` and
 * the Business Profile OAuth client must be configured. Read at request time so
 * switching the flag off hides the UI and fails every write path closed.
 */
export function googleReviewSyncEnabled(env: Env = process.env): boolean {
  return env.GOOGLE_REVIEW_SYNC === "1" && googleBusinessConfig(env) !== null;
}

/** Read-only view of the Business Profile review API (#46), live when configured. */
export function liveClient(): GoogleReviewsClient {
  const config = googleBusinessConfig();
  if (!config) throw new Error("google_business_not_configured");
  return googleBusinessClient({ config });
}

// Key management stays outside the repo: GOOGLE_TOKEN_KEY is 32 random bytes, base64.
function key() {
  const k = Buffer.from(process.env.GOOGLE_TOKEN_KEY ?? "", "base64");
  if (k.length !== 32) throw new Error("GOOGLE_TOKEN_KEY must be 32 base64 bytes");
  return k;
}
const aad = (owner: string, business: number) => Buffer.from(`google:${owner}:${business}`);
export function encryptToken(token: string, owner: string, business: number) {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key(), iv);
  c.setAAD(aad(owner, business));
  const body = Buffer.concat([c.update(token, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}
export function decryptToken(blob: string, owner: string, business: number) {
  const [v, iv, tag, body] = blob.split(".");
  if (v !== "v1") throw new Error("Unknown token envelope");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  d.setAAD(aad(owner, business)); d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8");
}

/** Owner-authorized connect. Returns null when the owner does not own the business. */
export async function connect(owner: string, businessId: number, location: string, refreshToken: string, locationTitle?: string | null) {
  const own = await query("SELECT 1 FROM businesses WHERE id=$1 AND owner_id=$2", [businessId, owner]);
  if (!own.rowCount) return null;
  const r = await query<{ id: string }>(
    `INSERT INTO google_connections(business_id,owner_id,location_name,encrypted_refresh_token,location_title)
     VALUES($1,$2,$3,$4,$5) ON CONFLICT(business_id) DO UPDATE SET location_name=$3, encrypted_refresh_token=$4,
     location_title=$5, status='active', page_checkpoint=NULL, last_error_code=NULL
     WHERE google_connections.owner_id=$2 RETURNING id`,
    [businessId, owner, location, encryptToken(refreshToken, owner, businessId), locationTitle ?? null]);
  return r.rows[0]?.id ?? null;
}

/** Stops sync and drops the stored credential first, then revokes at Google best-effort. */
export async function disconnect(client: GoogleReviewsClient, owner: string, businessId: number) {
  const row = (await query<{ encrypted_refresh_token: string | null }>(
    `UPDATE google_connections SET status='disconnected', encrypted_refresh_token=NULL, page_checkpoint=NULL
     WHERE business_id=$1 AND owner_id=$2 AND status<>'disconnected'
     RETURNING (SELECT encrypted_refresh_token FROM google_connections WHERE business_id=$1) AS encrypted_refresh_token`, [businessId, owner])).rows[0];
  if (!row) return false;
  if (row.encrypted_refresh_token) { try { await client.revoke(decryptToken(row.encrypted_refresh_token, owner, businessId)); } catch { /* token is already removed locally */ } }
  return true;
}

class StaleConnection extends Error {}
export type SyncResult = { status: "ok" | "revoked" | "failed" | "skipped"; imported: number; updated: number; errorCode?: string };
type Opts = { maxRetries?: number; sleep?: (ms: number) => Promise<void> };

async function withRetry<T>(run: () => Promise<T>, { maxRetries = 3, sleep = (ms) => new Promise(r => setTimeout(r, ms)) }: Opts) {
  for (let attempt = 0; ; attempt++) {
    try { return await run(); }
    catch (e) {
      const retryable = e instanceof GoogleApiError && (e.status === 429 || e.status >= 500);
      if (!retryable || attempt >= maxRetries) throw e;
      // A provider delay we are not willing to wait is surfaced, not shortened into a retry that cannot succeed.
      if (e instanceof GoogleApiError && e.retryAfterMs > 60000) throw e;
      await sleep(e.retryAfterMs || Math.min(500 * 2 ** attempt, 60000));
    }
  }
}

/**
 * Pull reviews page by page. Each page commits with its checkpoint, so an interrupted
 * scan resumes where it stopped. Re-running is idempotent: the unique identity key on
 * (business, source, source id) turns repeats into updates. Only the reviews row is
 * updated on edits; draft_posts keep the quote the owner approved. Deletions are not
 * inferred here (they need a full reconciliation, see integrations.md).
 */
export async function syncReviews(client: GoogleReviewsClient, businessId: number, opts: Opts = {}): Promise<SyncResult> {
  const conn = (await query<{ id: string; owner_id: string; location_name: string; encrypted_refresh_token: string | null; page_checkpoint: string | null }>(
    "SELECT id,owner_id,location_name,encrypted_refresh_token,page_checkpoint FROM google_connections WHERE business_id=$1 AND status='active'", [businessId])).rows[0];
  if (!conn?.encrypted_refresh_token) return { status: "skipped", imported: 0, updated: 0 };
  // Guarded by the credential this sync started with, so a stale sync cannot revoke or
  // mark failed a connection the owner reconnected while the request was in flight.
  const fail = async (code: string, status: "revoked" | "failed", n: { imported: number; updated: number }) => {
    await query(`UPDATE google_connections SET last_error_code=$2, status=CASE WHEN $3 THEN 'revoked' ELSE status END,
      encrypted_refresh_token=CASE WHEN $3 THEN NULL ELSE encrypted_refresh_token END
      WHERE id=$1 AND encrypted_refresh_token=$4`, [conn.id, code, status === "revoked", conn.encrypted_refresh_token]);
    return { status, errorCode: code, ...n };
  };
  const n = { imported: 0, updated: 0 };
  try {
    const access = await withRetry(() => client.refreshAccessToken(decryptToken(conn.encrypted_refresh_token!, conn.owner_id, businessId)), opts);
    let token = conn.page_checkpoint ?? undefined;
    do {
      const page = await withRetry(() => client.listReviews(access, conn.location_name, token), opts);
      const pageCounts = { imported: 0, updated: 0 };
      await transaction(async () => {
        // Revalidate under a row lock: a reconnect (new credential) or disconnect while the page was in flight
        // must not import into, or move the checkpoint of, the connection the owner now has.
        const current = await query("SELECT 1 FROM google_connections WHERE id=$1 AND status='active' AND encrypted_refresh_token=$2 AND location_name=$3 FOR UPDATE", [conn.id, conn.encrypted_refresh_token, conn.location_name]);
        if (!current.rowCount) throw new StaleConnection();
        for (const r of page.reviews) {
          if (!r.reviewId || !(r.rating >= 1 && r.rating <= 5)) continue;
          if (!r.comment?.trim()) {
            // A rating-only review is not importable, but an edit that removed the comment of an
            // imported review must clear the stale endorsement. Draft snapshots are untouched.
            const cleared = await query("UPDATE reviews SET text='', rating=$3 WHERE business_id=$1 AND source='google' AND source_review_id=$2 AND (text,rating) IS DISTINCT FROM ('',$3)", [businessId, r.reviewId, r.rating]);
            if (cleared.rowCount) pageCounts.updated++;
            continue;
          }
          const res = await query<{ inserted: boolean }>(
            `INSERT INTO reviews(business_id,source,source_review_id,rating,author_name,text,reviewed_at)
             VALUES($1,'google',$2,$3,$4,$5,$6)
             ON CONFLICT(business_id,source,identity_key) DO UPDATE SET rating=EXCLUDED.rating, text=EXCLUDED.text, author_name=EXCLUDED.author_name
             WHERE (reviews.rating,reviews.text,reviews.author_name) IS DISTINCT FROM (EXCLUDED.rating,EXCLUDED.text,EXCLUDED.author_name)
             RETURNING (xmax = 0) AS inserted`,
            [businessId, r.reviewId, r.rating, r.reviewerName, r.comment, r.createTime]);
          if (res.rows[0]?.inserted) pageCounts.imported++; else if (res.rowCount) pageCounts.updated++;
        }
        await query("UPDATE google_connections SET page_checkpoint=$2 WHERE id=$1", [conn.id, page.nextPageToken ?? null]);
      });
      n.imported += pageCounts.imported; n.updated += pageCounts.updated; // only once the page has committed
      token = page.nextPageToken;
    } while (token);
    await query("UPDATE google_connections SET last_sync_at=now(), last_sync_count=$2, last_error_code=NULL WHERE id=$1", [conn.id, n.imported + n.updated]);
    return { status: "ok", ...n };
  } catch (e) {
    if (e instanceof StaleConnection) return { status: "skipped", ...n };
    if (e instanceof GoogleApiError && e.code === "invalid_grant") return fail("access_revoked", "revoked", n);
    return fail(e instanceof GoogleApiError ? `google_${e.status}` : "sync_failed", "failed", n);
  }
}
