import { query } from "../db";
import {
  googleReviewSyncEnabled,
  liveClient,
  syncReviews,
  type GoogleReviewsClient,
  type SyncResult
} from "../integrations/googleReviews";
import { log } from "../log";
import { entitlementsFor } from "./entitlements";

// Scheduled Google Business Profile review sync (#46 part 3). The worker ticks
// this beside email. The database is the authority: a connection is claimed with
// last_attempt_at before any provider call, so two workers cannot sync one
// location and a failure backs off for a whole interval instead of retrying on
// every tick. A lapsed plan is skipped, never deleted; reconnecting clears the
// claim so the owner sees fresh reviews promptly.

type Env = Record<string, string | undefined>;

export type GoogleSyncDeps = {
  /** An injected read-only client for offline tests; the worker uses the live one. */
  client?: GoogleReviewsClient;
  /** A factory, so tests can assert that no client is built when there is no work. */
  clientFactory?: () => GoogleReviewsClient;
  /** The sync engine, injectable so an unexpected throw can be exercised offline. */
  sync?: (client: GoogleReviewsClient, businessId: number) => Promise<SyncResult>;
  env?: Env;
};

export type GoogleSyncCounts = {
  /** Rows claimed this tick (the due ones the worker actually attempted). */
  due: number;
  synced: number;
  failed: number;
  revoked: number;
  /** Claimed rows on a plan without reviewSync, plus skipped sync results. */
  skipped: number;
  imported: number;
  updated: number;
};

const DEFAULT_INTERVAL_HOURS = 6;
const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 168;
const DEFAULT_BATCH = 3;

const emptyCounts = (): GoogleSyncCounts => ({
  due: 0, synced: 0, failed: 0, revoked: 0, skipped: 0, imported: 0, updated: 0
});

/** Out-of-range numbers are clamped; unparseable ones fall back to the default. */
export function googleSyncIntervalHours(env: Env = process.env): number {
  const raw = env.GOOGLE_SYNC_INTERVAL_HOURS?.trim();
  if (!raw) return DEFAULT_INTERVAL_HOURS;
  const hours = Number(raw);
  if (!Number.isFinite(hours)) return DEFAULT_INTERVAL_HOURS;
  return Math.min(MAX_INTERVAL_HOURS, Math.max(MIN_INTERVAL_HOURS, hours));
}

/** A positive integer batch, or the default when the value is missing or invalid. */
export function googleSyncBatchSize(env: Env = process.env): number {
  const raw = env.GOOGLE_SYNC_BATCH?.trim();
  if (!raw) return DEFAULT_BATCH;
  const size = Number(raw);
  if (!Number.isSafeInteger(size) || size < 1) return DEFAULT_BATCH;
  return size;
}

type DueRow = { id: string; business_id: string | number; owner_id: string };

/**
 * Claim and sync at most one batch of due connections, one at a time. Nothing is
 * logged except counts, business ids and short status/error names — never a
 * token, ciphertext, OAuth code or provider error text.
 */
export async function googleSyncTick(deps: GoogleSyncDeps = {}): Promise<GoogleSyncCounts> {
  const env = deps.env ?? process.env;
  const counts = emptyCounts();
  // With the flag off, touch neither the database nor the provider client.
  if (!googleReviewSyncEnabled(env)) return counts;

  const interval = `${googleSyncIntervalHours(env)} hours`;
  const batch = googleSyncBatchSize(env);
  // Claim first, sync afterwards: SKIP LOCKED keeps a second worker off the same
  // row, and the timestamp is durable even if this process dies mid-sync. Rows on
  // a plan without reviewSync are claimed too, so they wait a whole interval
  // instead of being re-read (and re-logged) on every worker tick.
  const claimed = (await query<DueRow>(
    `UPDATE google_connections SET last_attempt_at=now()
     WHERE id IN (
       SELECT id FROM google_connections
       WHERE status='active' AND encrypted_refresh_token IS NOT NULL
         AND coalesce(last_attempt_at,'-infinity'::timestamptz) < now() - $1::interval
       ORDER BY coalesce(last_attempt_at,'-infinity'::timestamptz), id
       FOR UPDATE SKIP LOCKED
       LIMIT $2
     )
     RETURNING id,business_id,owner_id`,
    [interval, batch]
  )).rows;
  counts.due = claimed.length;
  if (!claimed.length) return counts;

  let client: GoogleReviewsClient | undefined = deps.client;
  const syncClient = (): GoogleReviewsClient => {
    if (!client) client = deps.clientFactory ? deps.clientFactory() : liveClient();
    return client;
  };

  for (const row of claimed) {
    const businessId = Number(row.business_id);
    try {
      // Entitlements come from the same function the routes use: a free or lapsed
      // plan is skipped (never deleted) and checked again after the interval.
      if (!(await entitlementsFor(row.owner_id)).limits.reviewSync) {
        counts.skipped += 1;
        continue;
      }
      const result = await (deps.sync ?? syncReviews)(syncClient(), businessId);
      if (result.status === "ok") counts.synced += 1;
      else if (result.status === "revoked") counts.revoked += 1;
      else if (result.status === "failed") counts.failed += 1;
      else counts.skipped += 1;
      counts.imported += result.imported;
      counts.updated += result.updated;
    } catch (error) {
      // One broken connection must not stop the batch. Log only a short name/code.
      counts.failed += 1;
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
      log.warn("google_sync_failed", {
        businessId,
        errorName: error instanceof Error ? error.name : typeof error,
        errorCode: typeof code === "string" || typeof code === "number" ? String(code).slice(0, 40) : "none"
      });
    }
  }
  return counts;
}
