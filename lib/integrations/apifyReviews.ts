// Apify Google Maps reviews provider (#232) — a removable stopgap until the
// official Business Profile sync (#46) is available. Nothing here runs against
// the real API in tests: callers inject a fake client or a fake fetch.
//
// The URL and field names were confirmed by a live run on 2026-11-04. Apify's actor
// can change, so they stay in this one file to keep a correction small.
import { log } from "../log";

export type ApifyPlaceKind = "place_id" | "place_url" | "short_url";
export type ApifyPlace = { kind: ApifyPlaceKind; value: string };
export type ApifyRunView = { runId: string; status: string; datasetId: string | null };
export type ApifyStartRequest = {
  place: ApifyPlace;
  maxReviews: number;
  maxChargeUsd: number;
  /** Set on later runs only: the start date of the previous run. */
  since: string | null;
};

export interface ApifyReviewsClient {
  startRun(request: ApifyStartRequest): Promise<ApifyRunView>;
  getRun(runId: string): Promise<ApifyRunView>;
  getDatasetItems(datasetId: string): Promise<unknown[]>;
}

export type ApifyErrorCode = "unavailable" | "auth" | "request" | "response";
/** Short codes only: an error never carries the token, request body or provider text. */
export class ApifyError extends Error {
  constructor(readonly code: ApifyErrorCode, readonly status = 0) {
    super(code);
    this.name = "ApifyError";
  }
}

const PLACE_ID = /^ChI[A-Za-z0-9_-]{5,}$/;
const GOOGLE_HOSTS = new Set(["google.com", "www.google.com", "maps.google.com"]);

/**
 * Exactly one place ID or Maps place URL. Search strings, directions, multiple
 * URLs and other hosts are refused; `maps.app.goo.gl` short links are accepted.
 */
export function parseApifyPlace(input: unknown): ApifyPlace | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  if (!value || value.length > 2000 || /\s/.test(value)) return null;
  if (PLACE_ID.test(value)) return { kind: "place_id", value };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  if (host === "maps.app.goo.gl") {
    return url.pathname.length > 1 ? { kind: "short_url", value: url.toString() } : null;
  }
  if (!GOOGLE_HOSTS.has(host)) return null;
  // A place URL, not /maps/search/, /maps/dir/ or a bare coordinate view.
  if (!url.pathname.startsWith("/maps/place/")) return null;
  if (url.pathname.split("/maps/place/").length !== 2) return null;
  return { kind: "place_url", value: url.toString() };
}

export function apifyToken(env: Record<string, string | undefined> = process.env): string | null {
  const token = env.APIFY_TOKEN?.trim();
  return token || null;
}

export function apifyConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(apifyToken(env));
}

/** Running or still being wound down; only these may block a new run. */
export function apifyRunInProgress(status: string): boolean {
  return ["READY", "RUNNING", "TIMING-OUT", "ABORTING"].includes(status);
}

/** Finished without a dataset that can be imported. */
export function apifyRunFailed(status: string): boolean {
  return ["FAILED", "TIMED-OUT", "ABORTED"].includes(status);
}

const BASE_URL = "https://api.apify.com/v2";
const ACTOR = "compass~crawler-google-places";
const TIMEOUT_MS = 15_000;

type Fetch = typeof fetch;
type Options = { token: string; fetchImpl?: Fetch; timeoutMs?: number; baseUrl?: string };

function runView(value: unknown): ApifyRunView {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const data = body.data && typeof body.data === "object" ? body.data as Record<string, unknown> : body;
  const runId = typeof data.id === "string" ? data.id : "";
  const status = typeof data.status === "string" ? data.status : "";
  const datasetId = typeof data.defaultDatasetId === "string" ? data.defaultDatasetId : null;
  if (!runId || !status) throw new ApifyError("response");
  return { runId, status, datasetId };
}

export class LiveApifyReviewsClient implements ApifyReviewsClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: Fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: Options) {
    if (!options.token.trim()) throw new ApifyError("unavailable");
    this.baseUrl = (options.baseUrl ?? BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  }

  private async call(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { ...init.headers, authorization: `Bearer ${this.options.token}` }
      });
    } catch {
      throw new ApifyError("request");
    }
    if (response.status === 401 || response.status === 403) throw new ApifyError("auth", response.status);
    if (!response.ok) throw new ApifyError("request", response.status);
    try {
      return await response.json();
    } catch {
      throw new ApifyError("response", response.status);
    }
  }

  async startRun(request: ApifyStartRequest): Promise<ApifyRunView> {
    const input: Record<string, unknown> = {
      maxReviews: request.maxReviews,
      reviewsSort: "newest",
      maxCrawledPlacesPerSearch: 1,
      scrapeReviewsPersonalData: true,
      language: "en",
      maxImages: 0
    };
    if (request.since) input.reviewsStartDate = request.since;
    if (request.place.kind === "place_id") input.placeIds = [request.place.value];
    else input.startUrls = [{ url: request.place.value }];

    const charge = encodeURIComponent(String(request.maxChargeUsd));
    log.info("apify_review_run_requested", { maxReviews: request.maxReviews, maxChargeUsd: request.maxChargeUsd, placeKind: request.place.kind });
    const body = await this.call(`/actors/${ACTOR}/runs?maxTotalChargeUsd=${charge}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });
    return runView(body);
  }

  async getRun(runId: string): Promise<ApifyRunView> {
    return runView(await this.call(`/actor-runs/${encodeURIComponent(runId)}`));
  }

  async getDatasetItems(datasetId: string): Promise<unknown[]> {
    const body = await this.call(`/datasets/${encodeURIComponent(datasetId)}/items?clean=true&format=json`);
    if (!Array.isArray(body)) throw new ApifyError("response");
    return body;
  }
}

export function liveApifyClient(
  options: { env?: Record<string, string | undefined>; fetchImpl?: Fetch; timeoutMs?: number; baseUrl?: string } = {}
): ApifyReviewsClient {
  const token = apifyToken(options.env);
  if (!token) throw new ApifyError("unavailable");
  return new LiveApifyReviewsClient({ token, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs, baseUrl: options.baseUrl });
}

type FakeScript = {
  starts?: (ApifyRunView | Error)[];
  runs?: Record<string, ApifyRunView | Error>;
  datasets?: Record<string, unknown[] | Error>;
};

/** Test-only client. It never touches the network and records each start request. */
export class FakeApifyReviewsClient implements ApifyReviewsClient {
  readonly startRequests: ApifyStartRequest[] = [];
  readonly requestedRuns: string[] = [];
  readonly requestedDatasets: string[] = [];
  private readonly script: FakeScript;

  constructor(script: FakeScript = {}) {
    this.script = script;
  }

  async startRun(request: ApifyStartRequest): Promise<ApifyRunView> {
    this.startRequests.push(request);
    const next = this.script.starts?.shift();
    if (!next) return { runId: `fake-run-${this.startRequests.length}`, status: "READY", datasetId: `fake-dataset-${this.startRequests.length}` };
    if (next instanceof Error) throw next;
    return next;
  }

  async getRun(runId: string): Promise<ApifyRunView> {
    this.requestedRuns.push(runId);
    const next = this.script.runs?.[runId];
    if (!next) throw new Error(`no fake run ${runId}`);
    if (next instanceof Error) throw next;
    return next;
  }

  async getDatasetItems(datasetId: string): Promise<unknown[]> {
    this.requestedDatasets.push(datasetId);
    const next = this.script.datasets?.[datasetId];
    if (next instanceof Error) throw next;
    return next ?? [];
  }
}
