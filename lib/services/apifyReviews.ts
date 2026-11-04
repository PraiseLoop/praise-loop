import { query, transaction } from "../db";
import { chargeGeneration } from "../authorization";
import { log } from "../log";
import {
  ApifyError,
  apifyConfigured,
  apifyRunFailed,
  apifyRunInProgress,
  apifyToken,
  liveApifyClient,
  parseApifyPlace,
  type ApifyPlace,
  type ApifyReviewsClient,
  type ApifyRunView
} from "../integrations/apifyReviews";
import { entitlementsFor } from "./entitlements";
import { validateReviewRow } from "./reviewValidation";

// Owner-approved stopgap (#232): fetch only the owner's own place through Apify,
// one capped run at a time, then import the dataset through the same row checks
// as CSV import. Removed when the official sync (#46) is available.
const RUN_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// The dataset is untrusted even though one run is capped to a single place.
const MAX_DATASET_ITEMS = 10;
const MAX_REVIEWS_PER_ITEM = 200;

export type ApifyReviewErrorCode =
  | "unavailable"
  | "not_found"
  | "confirmation_required"
  | "invalid_place"
  | "run_in_progress"
  | "run_interval"
  | "daily_limit"
  | "provider_auth"
  | "provider_error";

export class ApifyReviewError extends Error {
  constructor(readonly code: ApifyReviewErrorCode, readonly status = 400) {
    super(code);
    this.name = "ApifyReviewError";
  }
}

export type ApifyDeps = {
  client?: ApifyReviewsClient;
  env?: Record<string, string | undefined>;
  now?: () => Date;
};

// Apify's run lookup needs no token, so its run ID never leaves the server.
export type ApifyRunResponse = {
  id: number;
  status: string;
  startedAt: string;
  importedAt: string | null;
  imported: number;
  duplicates: number;
  rejected: number;
  skipped: number;
  failedRows: number;
  errorCode: string | null;
  inProgress: boolean;
};

export type ApifyStatusResponse = {
  enabled: boolean;
  place: { input: string; kind: ApifyPlace["kind"]; confirmedAt: string } | null;
  run: ApifyRunResponse | null;
  canStart: boolean;
  nextRunAt: string | null;
  limits: { maxReviews: number; intervalHours: number };
};

type PlaceRow = {
  place_input: string;
  place_kind: ApifyPlace["kind"];
  confirmed_at: Date | string;
};

type RunRow = {
  id: number;
  run_id: string;
  dataset_id: string | null;
  status: string;
  started_at: Date | string;
  imported_at: Date | string | null;
  imported: number;
  duplicates: number;
  rejected: number;
  skipped: number;
  failed_rows: number;
  error_code: string | null;
};

export type ApifyImportSummary = {
  imported: number;
  duplicates: number;
  rejected: number;
  skipped: number;
  failedRows: number;
};

function positiveNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Reviews per run for a plan name; an unknown plan gets the Free cap. */
export function apifyReviewLimit(plan: string, env: Record<string, string | undefined> = process.env): number {
  const key = plan === "pro" ? "APIFY_REVIEW_LIMIT_PRO" : plan === "business" ? "APIFY_REVIEW_LIMIT_BUSINESS" : "APIFY_REVIEW_LIMIT_FREE";
  const fallback = plan === "pro" ? 10 : plan === "business" ? 15 : 5;
  return Math.max(1, Math.floor(positiveNumber(env[key], fallback)));
}

export function apifyMaxChargeUsd(env: Record<string, string | undefined> = process.env): number {
  return positiveNumber(env.APIFY_MAX_CHARGE_USD, 0.5);
}

export function apifyRunIntervalHours(env: Record<string, string | undefined> = process.env): number {
  return positiveNumber(env.APIFY_REVIEW_RUN_INTERVAL_HOURS, 24);
}

/** First name plus last initial with a dot; a single name is unchanged; empty is null. */
export function shortReviewerName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const first = parts[0].slice(0, 120);
  if (parts.length === 1) return first;
  const initial = Array.from(parts[parts.length - 1])[0];
  return initial ? `${first} ${initial.toUpperCase()}.`.slice(0, 140) : first;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function reviewId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function publishedIso(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
  }
  return "";
}

/**
 * Dataset items are untrusted: only known fields survive, and only after the row checks.
 * Each insert has its own savepoint, because a failed statement would otherwise abort the
 * whole transaction and the run could never finish importing.
 */
export function importApifyItems(businessId: number, items: unknown[]): Promise<ApifyImportSummary> {
  return transaction(() => importItems(businessId, items));
}

async function importItems(businessId: number, items: unknown[]): Promise<ApifyImportSummary> {
  const summary: ApifyImportSummary = { imported: 0, duplicates: 0, rejected: 0, skipped: 0, failedRows: 0 };
  for (const item of items.slice(0, MAX_DATASET_ITEMS)) {
    const place = asRecord(item);
    if (!place) continue;
    const reviews = Array.isArray(place.reviews) ? place.reviews.slice(0, MAX_REVIEWS_PER_ITEM) : [];
    for (const raw of reviews) {
      const review = asRecord(raw);
      if (!review) {
        summary.rejected += 1;
        continue;
      }
      const text = typeof review.text === "string" ? review.text : "";
      if (!text.trim()) {
        summary.skipped += 1;
        continue;
      }
      const checked = validateReviewRow({
        rating: review.stars === undefined || review.stars === null ? "" : String(review.stars),
        text,
        reviewedAt: publishedIso(review.publishedAtDate),
        authorName: shortReviewerName(review.name ?? review.reviewerName),
        sourceReviewId: reviewId(review.reviewId),
        // The review URL is deliberately discarded, as are the reviewer's id, profile and photo.
        sourceUrl: null
      });
      if (checked.status === "empty") {
        summary.skipped += 1;
        continue;
      }
      if (checked.status === "invalid") {
        summary.rejected += 1;
        continue;
      }
      await query("SAVEPOINT apify_review_row");
      try {
        const result = await query<{ inserted: boolean }>(
          `INSERT INTO reviews
           (business_id, source, source_review_id, rating, author_name, text, reviewed_at)
           VALUES ($1, 'apify_google', $2, $3, $4, $5, $6)
           ON CONFLICT (business_id, source, identity_key) DO NOTHING
           RETURNING (xmax = 0) AS inserted`,
          [
            businessId,
            checked.review.sourceReviewId,
            checked.review.rating,
            checked.review.authorName,
            checked.review.text,
            checked.review.reviewedAt.toISOString()
          ]
        );
        if (result.rows[0]?.inserted) summary.imported += 1;
        else summary.duplicates += 1;
        await query("RELEASE SAVEPOINT apify_review_row");
      } catch {
        await query("ROLLBACK TO SAVEPOINT apify_review_row");
        summary.failedRows += 1;
      }
    }
  }
  return summary;
}

async function assertOwned(owner: string, businessId: number): Promise<void> {
  const owned = await query("SELECT 1 FROM businesses WHERE id=$1 AND owner_id=$2", [businessId, owner]);
  if (!owned.rowCount) throw new ApifyReviewError("not_found", 404);
}

// The effective plan, so a lapsed paid plan gets the Free cap like every other limit.
async function ownerPlan(owner: string): Promise<string> {
  return (await entitlementsFor(owner)).plan;
}

async function placeFor(businessId: number): Promise<PlaceRow | null> {
  return (await query<PlaceRow>(
    "SELECT place_input,place_kind,confirmed_at FROM apify_review_places WHERE business_id=$1",
    [businessId]
  )).rows[0] ?? null;
}

async function latestRun(businessId: number): Promise<RunRow | null> {
  return (await query<RunRow>(
    `SELECT id,run_id,dataset_id,status,started_at,imported_at,imported,duplicates,rejected,skipped,failed_rows,error_code
     FROM apify_review_runs WHERE business_id=$1 ORDER BY started_at DESC, id DESC LIMIT 1`,
    [businessId]
  )).rows[0] ?? null;
}

/** Failed runs do not hold the interval open, so a timed-out or provider-failed run can be retried. */
async function lastCountedRun(businessId: number): Promise<RunRow | null> {
  return (await query<RunRow>(
    `SELECT id,run_id,dataset_id,status,started_at,imported_at,imported,duplicates,rejected,skipped,failed_rows,error_code
     FROM apify_review_runs
     WHERE business_id=$1 AND status NOT IN ('FAILED','TIMED-OUT','ABORTED')
     ORDER BY started_at DESC, id DESC LIMIT 1`,
    [businessId]
  )).rows[0] ?? null;
}

async function runById(id: number): Promise<RunRow | null> {
  return (await query<RunRow>(
    `SELECT id,run_id,dataset_id,status,started_at,imported_at,imported,duplicates,rejected,skipped,failed_rows,error_code
     FROM apify_review_runs WHERE id=$1`,
    [id]
  )).rows[0] ?? null;
}

async function updateRun(
  id: number,
  values: { status?: string; datasetId?: string | null; errorCode?: string | null; finished?: boolean }
): Promise<RunRow | null> {
  return (await query<RunRow>(
    `UPDATE apify_review_runs
     SET status=COALESCE($2,status),
         dataset_id=COALESCE($3,dataset_id),
         error_code=$4,
         finished_at=CASE WHEN $5 THEN now() ELSE finished_at END
     WHERE id=$1
     RETURNING id,run_id,dataset_id,status,started_at,imported_at,imported,duplicates,rejected,skipped,failed_rows,error_code`,
    [id, values.status ?? null, values.datasetId ?? null, values.errorCode ?? null, values.finished ?? false]
  )).rows[0] ?? null;
}

function failedRun(id: number, code: string): Promise<RunRow | null> {
  return updateRun(id, { status: "FAILED", errorCode: code, finished: true });
}

function providerError(error: unknown): ApifyReviewError {
  if (error instanceof ApifyReviewError) return error;
  if (error instanceof ApifyError) {
    if (error.code === "unavailable") return new ApifyReviewError("unavailable", 503);
    if (error.code === "auth") return new ApifyReviewError("provider_auth", 502);
  }
  return new ApifyReviewError("provider_error", 502);
}

function runResponse(row: RunRow | null): ApifyRunResponse | null {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    startedAt: new Date(row.started_at).toISOString(),
    importedAt: row.imported_at ? new Date(row.imported_at).toISOString() : null,
    imported: row.imported,
    duplicates: row.duplicates,
    rejected: row.rejected,
    skipped: row.skipped,
    failedRows: row.failed_rows,
    errorCode: row.error_code,
    inProgress: apifyRunInProgress(row.status)
  };
}

function response(
  enabled: boolean,
  place: PlaceRow | null,
  run: RunRow | null,
  canStart: boolean,
  nextRunAt: Date | null,
  limits: ApifyStatusResponse["limits"]
): ApifyStatusResponse {
  return {
    enabled,
    place: place ? {
      input: place.place_input,
      kind: place.place_kind,
      confirmedAt: new Date(place.confirmed_at).toISOString()
    } : null,
    run: runResponse(run),
    canStart,
    nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
    limits
  };
}

async function importSucceededRun(client: ApifyReviewsClient, businessId: number, run: RunRow): Promise<RunRow | null> {
  if (!run.dataset_id) return failedRun(run.id, "missing_dataset");
  const items = await client.getDatasetItems(run.dataset_id);
  return transaction(async () => {
    // The conditional claim is what stops two polls importing the same dataset.
    const claimed = await query<{ id: number }>(
      "UPDATE apify_review_runs SET imported_at=now() WHERE id=$1 AND imported_at IS NULL AND status='SUCCEEDED' RETURNING id",
      [run.id]
    );
    if (!claimed.rowCount) return runById(run.id);
    const summary = await importApifyItems(businessId, items);
    const updated = (await query<RunRow>(
      `UPDATE apify_review_runs
       SET imported=$2,duplicates=$3,rejected=$4,skipped=$5,failed_rows=$6,finished_at=COALESCE(finished_at,now())
       WHERE id=$1
       RETURNING id,run_id,dataset_id,status,started_at,imported_at,imported,duplicates,rejected,skipped,failed_rows,error_code`,
      [run.id, summary.imported, summary.duplicates, summary.rejected, summary.skipped, summary.failedRows]
    )).rows[0] ?? null;
    log.info("apify_reviews_imported", {
      businessId,
      imported: summary.imported,
      duplicates: summary.duplicates,
      rejected: summary.rejected,
      skipped: summary.skipped,
      failedRows: summary.failedRows
    });
    return updated;
  });
}

export async function getApifyReviewsStatus(owner: string, businessId: number, deps: ApifyDeps = {}): Promise<ApifyStatusResponse> {
  const env = deps.env ?? process.env;
  const now = deps.now?.() ?? new Date();
  await assertOwned(owner, businessId);

  const plan = await ownerPlan(owner);
  const limits = {
    maxReviews: apifyReviewLimit(plan, env),
    intervalHours: apifyRunIntervalHours(env)
  };
  const enabled = deps.client ? true : apifyConfigured(env);
  if (!enabled) return response(false, null, null, false, null, limits);

  const client = deps.client ?? liveApifyClient({ env });
  const place = await placeFor(businessId);
  let run = await latestRun(businessId);

  if (run && apifyRunInProgress(run.status)) {
    if (now.getTime() - new Date(run.started_at).getTime() > RUN_TIMEOUT_MS) {
      run = await failedRun(run.id, "timeout") ?? run;
    } else {
      try {
        const provider = await client.getRun(run.run_id);
        run = await updateRun(run.id, { status: provider.status, datasetId: provider.datasetId }) ?? run;
        if (apifyRunFailed(provider.status)) run = await failedRun(run.id, "provider_failed") ?? run;
      } catch {
        // An unreachable status is not proof the run finished; leave it in progress.
      }
    }
  }

  if (run?.status === "SUCCEEDED" && !run.imported_at) {
    try {
      run = await importSucceededRun(client, businessId, run) ?? run;
    } catch (error) {
      throw providerError(error);
    }
  }

  const counted = await lastCountedRun(businessId);
  const nextRunAt = counted ? new Date(new Date(counted.started_at).getTime() + limits.intervalHours * HOUR_MS) : null;
  const canStart = !(run && apifyRunInProgress(run.status)) && (!nextRunAt || nextRunAt.getTime() <= now.getTime());
  return response(true, place, run, canStart, nextRunAt, limits);
}

export async function startApifyReviews(
  owner: string,
  businessId: number,
  input: { place?: unknown; confirmed?: unknown },
  deps: ApifyDeps = {}
): Promise<ApifyStatusResponse> {
  const env = deps.env ?? process.env;
  const now = deps.now?.() ?? new Date();
  await assertOwned(owner, businessId);
  if (!deps.client && !apifyToken(env)) throw new ApifyReviewError("unavailable", 503);
  if (input.confirmed !== true) throw new ApifyReviewError("confirmation_required", 400);
  const place = parseApifyPlace(input.place);
  if (!place) throw new ApifyReviewError("invalid_place", 400);

  // Every run costs money, so the checks and the start hold a per-business lock: two quick
  // clicks cannot both pass the checks and start two runs. A provider failure rolls back
  // the daily count and the stored place, because nothing was spent.
  return transaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext('apify_review_start'), ($1::bigint % 2147483647)::int)", [businessId]);

    let latest = await latestRun(businessId);
    if (latest && apifyRunInProgress(latest.status) && now.getTime() - new Date(latest.started_at).getTime() > RUN_TIMEOUT_MS) {
      latest = await failedRun(latest.id, "timeout") ?? latest;
    }
    if (latest && apifyRunInProgress(latest.status)) throw new ApifyReviewError("run_in_progress", 409);

    const plan = await ownerPlan(owner);
    const intervalHours = apifyRunIntervalHours(env);
    const counted = await lastCountedRun(businessId);
    const nextRunAt = counted ? new Date(new Date(counted.started_at).getTime() + intervalHours * HOUR_MS) : null;
    if (nextRunAt && nextRunAt.getTime() > now.getTime()) throw new ApifyReviewError("run_interval", 429);

    if (!await chargeGeneration(owner, 1, "apify_reviews")) throw new ApifyReviewError("daily_limit", 429);

    const maxReviews = apifyReviewLimit(plan, env);
    const maxChargeUsd = apifyMaxChargeUsd(env);
    const client = deps.client ?? liveApifyClient({ env });

    // A different place has no earlier run, so it starts from its newest reviews with no date limit.
    const previousPlace = await placeFor(businessId);
    const samePlace = previousPlace?.place_input === place.value;
    await query(
      `INSERT INTO apify_review_places(business_id,place_input,place_kind,confirmed_by,confirmed_at,updated_at)
       VALUES($1,$2,$3,$4,now(),now())
       ON CONFLICT(business_id) DO UPDATE
       SET place_input=EXCLUDED.place_input, place_kind=EXCLUDED.place_kind,
           confirmed_by=EXCLUDED.confirmed_by, confirmed_at=now(), updated_at=now()`,
      [businessId, place.value, place.kind, owner]
    );

    let providerRun: ApifyRunView;
    try {
      providerRun = await client.startRun({
        place,
        maxReviews,
        maxChargeUsd,
        since: counted && samePlace ? new Date(counted.started_at).toISOString().slice(0, 10) : null
      });
    } catch (error) {
      throw providerError(error);
    }

    const inserted = (await query<RunRow>(
      `INSERT INTO apify_review_runs(business_id,run_id,dataset_id,status,started_at)
       VALUES($1,$2,$3,$4,$5)
       RETURNING id,run_id,dataset_id,status,started_at,imported_at,imported,duplicates,rejected,skipped,failed_rows,error_code`,
      [businessId, providerRun.runId, providerRun.datasetId, providerRun.status, now]
    )).rows[0];
    const placeRow = await placeFor(businessId);
    const startedNext = new Date(now.getTime() + intervalHours * HOUR_MS);
    return response(true, placeRow, inserted, false, startedNext, { maxReviews, intervalHours });
  });
}
