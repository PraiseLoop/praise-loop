// Google Business Profile OAuth and read-only REST client (#46). No SDK: the
// documented REST calls use the global fetch, and injecting `fetchImpl` keeps
// tests offline. Tokens, codes, the client secret and provider error text never
// enter a log line or an error message; callers only see a short code.
export const GOOGLE_BUSINESS_SCOPE = "https://www.googleapis.com/auth/business.manage";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const ACCOUNTS_URL = "https://mybusinessaccountmanagement.googleapis.com/v1/accounts";
const LOCATIONS_BASE = "https://mybusinessbusinessinformation.googleapis.com/v1";
const REVIEWS_BASE = "https://mybusiness.googleapis.com/v4";
const TIMEOUT_MS = 15_000;
const MAX_PAGES = 10;
const ACCOUNT_NAME = /^accounts\/[^/]+$/;
const LOCATION_NAME = /^accounts\/[^/]+\/locations\/[^/]+$/;
const BUSINESS_LOCATION_NAME = /^(?:accounts\/([^/]+)\/)?locations\/([^/]+)$/;
const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

type Env = Record<string, string | undefined>;

export type GoogleBusinessConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

/** A provider refusal, a malformed response or a transport failure, reduced to a short code. */
export class GoogleApiError extends Error {
  constructor(public status: number, public code: string, public retryAfterMs = 0) {
    super(code);
    this.name = "GoogleApiError";
  }
}

export type GoogleReview = {
  reviewId: string;
  rating: number;
  comment: string;
  reviewerName: string | null;
  createTime: string;
  updateTime: string;
};

export type GoogleLocation = { name: string; title: string; address: string | null };
export type GoogleTokens = { refreshToken: string; accessToken: string; scope: string };

/** The read-only contract the existing sync already consumes. */
export interface GoogleReviewsClient {
  refreshAccessToken(refreshToken: string): Promise<string>;
  listReviews(accessToken: string, location: string, pageToken?: string): Promise<{ reviews: GoogleReview[]; nextPageToken?: string }>;
  revoke(refreshToken: string): Promise<void>;
}

export interface GoogleBusinessClient extends GoogleReviewsClient {
  exchangeCode(code: string): Promise<GoogleTokens>;
  listLocations(accessToken: string): Promise<GoogleLocation[]>;
}

function value(env: Env, key: string): string | null {
  const trimmed = env[key]?.trim();
  return trimmed || null;
}

/**
 * Read at request time. The Business Profile grant uses the same OAuth client as
 * Google sign-in with a broader scope, so both credentials are required. Missing
 * credentials or a missing redirect base returns null and the caller fails closed.
 */
export function googleBusinessConfig(env: Env = process.env): GoogleBusinessConfig | null {
  const clientId = value(env, "GOOGLE_CLIENT_ID");
  const clientSecret = value(env, "GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;
  const base = value(env, "NEXTAUTH_URL")?.replace(/\/+$/, "");
  const redirectUri = value(env, "GOOGLE_BUSINESS_REDIRECT_URI") ?? (base ? `${base}/api/google/callback` : null);
  if (!redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

/** The owner-consent dialog. The state is supplied by the connect route, never by the caller. */
export function googleAuthorizeUrl(config: GoogleBusinessConfig, state: string): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: GOOGLE_BUSINESS_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state
  }).toString();
  return url.toString();
}

type Options = { config: GoogleBusinessConfig; fetchImpl?: typeof fetch; timeoutMs?: number };
type Parsed = { status: number; body: unknown };
type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Retry-After is seconds, never a header value we echo into an error. */
function retryAfterMs(header: string | null): number {
  if (!header) return 0;
  const match = /^(\d{1,9})$/.exec(header.trim());
  const seconds = match ? Number(match[1]) : 0;
  return Number.isFinite(seconds) ? seconds * 1000 : 0;
}

/** Google leaves an empty list out of the response entirely; anything but an array or nothing is malformed. */
function listField(body: Json, key: string): unknown[] {
  const value = body[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new GoogleApiError(200, "bad_response");
  return value;
}

function addressOf(value: unknown): string | null {
  if (!isJson(value)) return null;
  const lines = Array.isArray(value.addressLines)
    ? value.addressLines.filter((line): line is string => typeof line === "string" && Boolean(line.trim()))
    : [];
  const locality = typeof value.locality === "string" && value.locality.trim() ? value.locality.trim() : null;
  const region = typeof value.administrativeArea === "string" && value.administrativeArea.trim() ? value.administrativeArea.trim() : null;
  const parts = [...lines, ...(locality ? [locality] : []), ...(region ? [region] : [])];
  return parts.length ? parts.join(", ") : null;
}

function reviewOf(value: unknown): GoogleReview | null {
  if (!isJson(value)) return null;
  const reviewer = isJson(value.reviewer) ? value.reviewer : {};
  const anonymous = reviewer.isAnonymous === true;
  const name = typeof reviewer.displayName === "string" && reviewer.displayName && !anonymous ? reviewer.displayName : null;
  return {
    reviewId: typeof value.reviewId === "string" ? value.reviewId : "",
    // Unknown enums map to 0 so syncReviews skips the row rather than inventing a rating.
    rating: typeof value.starRating === "string" ? STARS[value.starRating] ?? 0 : 0,
    comment: typeof value.comment === "string" ? value.comment : "",
    reviewerName: name,
    createTime: typeof value.createTime === "string" ? value.createTime : "",
    updateTime: typeof value.updateTime === "string" ? value.updateTime : ""
  };
}

class RestGoogleBusinessClient implements GoogleBusinessClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: Options) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** One HTTP call: transport and provider refusals become short sanitized codes. */
  private async send(url: URL, init: RequestInit): Promise<Parsed> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? TIMEOUT_MS)
      });
    } catch {
      throw new GoogleApiError(0, "network");
    }
    let body: unknown = null;
    try { body = await response.json(); } catch { /* reported by the caller below */ }
    if (!response.ok) {
      // syncReviews depends on this exact code to revoke expired consent.
      if (response.status === 400 && isJson(body) && body.error === "invalid_grant") {
        throw new GoogleApiError(400, "invalid_grant");
      }
      const delay = response.status === 429 || response.status === 503
        ? retryAfterMs(response.headers.get("retry-after"))
        : 0;
      throw new GoogleApiError(response.status, `google_http_${response.status}`, delay);
    }
    return { status: response.status, body };
  }

  private async json<T extends Json>(url: URL, init: RequestInit): Promise<T> {
    const { status, body } = await this.send(url, init);
    if (!isJson(body)) throw new GoogleApiError(status, "bad_response");
    return body as T;
  }

  private authorized(accessToken: string): RequestInit {
    return { method: "GET", headers: { accept: "application/json", authorization: `Bearer ${accessToken}` } };
  }

  private post(fields: Record<string, string>): RequestInit {
    return {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString()
    };
  }

  private paged(base: URL, token: string | undefined): URL {
    const url = new URL(base.toString());
    if (token) url.searchParams.set("pageToken", token);
    return url;
  }

  async exchangeCode(code: string): Promise<GoogleTokens> {
    const body = await this.json<Json>(new URL(TOKEN_URL), this.post({
      grant_type: "authorization_code",
      code,
      client_id: this.options.config.clientId,
      client_secret: this.options.config.clientSecret,
      redirect_uri: this.options.config.redirectUri
    }));
    const refreshToken = body.refresh_token;
    if (typeof refreshToken !== "string" || !refreshToken) throw new GoogleApiError(200, "missing_refresh_token");
    const accessToken = body.access_token;
    const scope = body.scope;
    if (typeof accessToken !== "string" || !accessToken || typeof scope !== "string") {
      throw new GoogleApiError(200, "bad_response");
    }
    // A plain sign-in grant is not enough: the owner must have approved management.
    if (!scope.split(/\s+/).includes(GOOGLE_BUSINESS_SCOPE)) throw new GoogleApiError(200, "missing_scope");
    return { refreshToken, accessToken, scope };
  }

  async refreshAccessToken(refreshToken: string): Promise<string> {
    const body = await this.json<Json>(new URL(TOKEN_URL), this.post({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.options.config.clientId,
      client_secret: this.options.config.clientSecret
    }));
    const accessToken = body.access_token;
    if (typeof accessToken !== "string" || !accessToken) throw new GoogleApiError(200, "bad_response");
    return accessToken;
  }

  async listLocations(accessToken: string): Promise<GoogleLocation[]> {
    const accounts: string[] = [];
    const seenAccounts = new Set<string>();
    const base = new URL(ACCOUNTS_URL);
    let next: URL | null = base;
    for (let page = 0; next && page < MAX_PAGES; page += 1) {
      const body: Json = await this.json<Json>(next, this.authorized(accessToken));
      // Google omits empty lists, so a missing field means none; any other shape is malformed.
      const rawAccounts = listField(body, "accounts");
      for (const raw of rawAccounts) {
        if (isJson(raw) && typeof raw.name === "string" && ACCOUNT_NAME.test(raw.name) && !seenAccounts.has(raw.name)) {
          seenAccounts.add(raw.name);
          accounts.push(raw.name);
        }
      }
      next = typeof body.nextPageToken === "string" && body.nextPageToken ? this.paged(base, body.nextPageToken) : null;
    }

    const locations: GoogleLocation[] = [];
    const seenLocations = new Set<string>();
    for (const account of accounts) {
      const accountId = account.slice("accounts/".length);
      const locationBase = new URL(`${LOCATIONS_BASE}/${account}/locations`);
      locationBase.search = new URLSearchParams({
        readMask: "name,title,storefrontAddress",
        pageSize: "100"
      }).toString();
      let locationPage: URL | null = locationBase;
      for (let page = 0; locationPage && page < MAX_PAGES; page += 1) {
        const body: Json = await this.json<Json>(locationPage, this.authorized(accessToken));
        for (const raw of listField(body, "locations")) {
          if (!isJson(raw)) continue;
          const match = typeof raw.name === "string" ? BUSINESS_LOCATION_NAME.exec(raw.name) : null;
          if (!match) continue;
          const name = `accounts/${match[1] ?? accountId}/locations/${match[2]}`;
          if (seenLocations.has(name)) continue;
          seenLocations.add(name);
          locations.push({
            name,
            title: typeof raw.title === "string" && raw.title ? raw.title : name,
            address: addressOf(raw.storefrontAddress)
          });
        }
        locationPage = typeof body.nextPageToken === "string" && body.nextPageToken
          ? this.paged(locationBase, body.nextPageToken)
          : null;
      }
    }
    return locations;
  }

  async listReviews(accessToken: string, location: string, pageToken?: string): Promise<{ reviews: GoogleReview[]; nextPageToken?: string }> {
    if (!LOCATION_NAME.test(location)) throw new GoogleApiError(0, "bad_location");
    const url = new URL(`${REVIEWS_BASE}/${location}/reviews`);
    url.search = new URLSearchParams({ pageSize: "50", ...(pageToken ? { pageToken } : {}) }).toString();
    const body = await this.json<Json>(url, this.authorized(accessToken));
    const reviews = listField(body, "reviews").map(reviewOf).filter((review): review is GoogleReview => Boolean(review));
    if (typeof body.nextPageToken !== "string" || !body.nextPageToken) return { reviews };
    return { reviews, nextPageToken: body.nextPageToken };
  }

  async revoke(refreshToken: string): Promise<void> {
    // Google answers 200 with an empty body; revoke deliberately ignores it.
    await this.send(new URL(REVOKE_URL), this.post({ token: refreshToken }));
  }
}

export function googleBusinessClient(options: Options): GoogleBusinessClient {
  return new RestGoogleBusinessClient(options);
}
