import assert from "node:assert/strict";
import {
  GOOGLE_BUSINESS_SCOPE,
  GoogleApiError,
  googleAuthorizeUrl,
  googleBusinessClient,
  googleBusinessConfig,
  type GoogleBusinessConfig
} from "../lib/integrations/googleBusiness";

const CONFIG: GoogleBusinessConfig = {
  clientId: "synthetic-client-id",
  clientSecret: "synthetic-client-secret",
  redirectUri: "https://dev.example.invalid/api/google/callback"
};
/** Synthetic values that must never appear in a thrown error message. */
const SECRETS = [
  "synthetic-client-secret", "synthetic-code", "synthetic-access-token",
  "synthetic-refresh-token", "provider said synthetic-secret"
];
const errors: Error[] = [];

function refusal(error: unknown): GoogleApiError {
  assert.ok(error instanceof GoogleApiError, `expected GoogleApiError, got ${String(error)}`);
  errors.push(error);
  return error;
}

type Call = {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  signal: boolean;
};
type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; fail?: boolean };

/** A fetch that records the exact request and answers with canned JSON; never a network call. */
function fakeFetch(reply: (call: Call, index: number) => Reply) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = String(value);
    }
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
      signal: Boolean(init?.signal)
    };
    calls.push(call);
    const answer = reply(call, calls.length - 1);
    if (answer.fail) throw new Error("synthetic transport failure: synthetic-refresh-token");
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: answer.headers ?? {}
    });
  };
  return { fetchImpl, calls };
}

function form(call: Call): URLSearchParams {
  assert.equal(call.method, "POST");
  assert.equal(call.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(call.signal, true, "every call has an abort signal");
  return new URLSearchParams(call.body ?? "");
}

function endpoint(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

const REVIEW = (id: string, extra: Record<string, unknown> = {}) => ({
  reviewId: id,
  starRating: "FIVE",
  comment: "Synthetic kind words",
  reviewer: { displayName: "Example Reviewer" },
  createTime: "2026-10-01T00:00:00Z",
  updateTime: "2026-10-02T00:00:00Z",
  ...extra
});

async function main() {
  // Config is read at request time and fails closed on every missing piece.
  assert.equal(googleBusinessConfig({}), null);
  assert.equal(googleBusinessConfig({ GOOGLE_CLIENT_ID: "x" }), null);
  assert.equal(googleBusinessConfig({ GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "  " }), null);
  assert.equal(googleBusinessConfig({ GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "s" }), null);
  assert.deepEqual(
    googleBusinessConfig({ GOOGLE_CLIENT_ID: " x ", GOOGLE_CLIENT_SECRET: " s ", NEXTAUTH_URL: "https://dev.example.invalid///" }),
    { clientId: "x", clientSecret: "s", redirectUri: "https://dev.example.invalid/api/google/callback" }
  );
  assert.deepEqual(
    googleBusinessConfig({
      GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "s", NEXTAUTH_URL: "https://dev.example.invalid",
      GOOGLE_BUSINESS_REDIRECT_URI: "https://override.example.invalid/callback"
    }),
    { clientId: "x", clientSecret: "s", redirectUri: "https://override.example.invalid/callback" }
  );

  // The consent dialog asks for offline management consent, never implicit grant.
  const auth = new URL(googleAuthorizeUrl(CONFIG, "synthetic-state"));
  assert.equal(endpoint(auth), "https://accounts.google.com/o/oauth2/v2/auth");
  assert.deepEqual(Object.fromEntries(auth.searchParams.entries()), {
    client_id: "synthetic-client-id",
    redirect_uri: CONFIG.redirectUri,
    response_type: "code",
    scope: GOOGLE_BUSINESS_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state: "synthetic-state"
  });

  // Code exchange: form-encoded, both tokens and the granted scope checked.
  const exchanged = fakeFetch(() => ({
    body: {
      access_token: "synthetic-access-token", refresh_token: "synthetic-refresh-token",
      scope: `openid ${GOOGLE_BUSINESS_SCOPE}`, token_type: "Bearer"
    }
  }));
  assert.deepEqual(
    await googleBusinessClient({ config: CONFIG, fetchImpl: exchanged.fetchImpl }).exchangeCode("synthetic-code"),
    { refreshToken: "synthetic-refresh-token", accessToken: "synthetic-access-token", scope: `openid ${GOOGLE_BUSINESS_SCOPE}` }
  );
  assert.equal(exchanged.calls.length, 1);
  assert.equal(endpoint(exchanged.calls[0].url), "https://oauth2.googleapis.com/token");
  assert.equal(exchanged.calls[0].headers.accept, "application/json");
  assert.deepEqual(Object.fromEntries(form(exchanged.calls[0]).entries()), {
    grant_type: "authorization_code",
    code: "synthetic-code",
    client_id: "synthetic-client-id",
    client_secret: "synthetic-client-secret",
    redirect_uri: CONFIG.redirectUri
  });

  const noRefresh = fakeFetch(() => ({ body: { access_token: "synthetic-access-token", scope: GOOGLE_BUSINESS_SCOPE } }));
  assert.equal(
    refusal(await googleBusinessClient({ config: CONFIG, fetchImpl: noRefresh.fetchImpl })
      .exchangeCode("synthetic-code").then(() => null, e => e)).code,
    "missing_refresh_token"
  );
  const noScope = fakeFetch(() => ({ body: { access_token: "synthetic-access-token", refresh_token: "synthetic-refresh-token", scope: "openid email" } }));
  assert.equal(
    refusal(await googleBusinessClient({ config: CONFIG, fetchImpl: noScope.fetchImpl })
      .exchangeCode("synthetic-code").then(() => null, e => e)).code,
    "missing_scope"
  );

  // Refresh: the exact invalid_grant code is what marks a connection revoked.
  const refreshed = fakeFetch(() => ({ body: { access_token: "synthetic-access-token-2" } }));
  assert.equal(
    await googleBusinessClient({ config: CONFIG, fetchImpl: refreshed.fetchImpl }).refreshAccessToken("synthetic-refresh-token"),
    "synthetic-access-token-2"
  );
  assert.deepEqual(Object.fromEntries(form(refreshed.calls[0]).entries()), {
    grant_type: "refresh_token",
    refresh_token: "synthetic-refresh-token",
    client_id: "synthetic-client-id",
    client_secret: "synthetic-client-secret"
  });
  const expired = fakeFetch(() => ({ status: 400, body: { error: "invalid_grant", error_description: "provider said synthetic-secret" } }));
  const invalid = refusal(await googleBusinessClient({ config: CONFIG, fetchImpl: expired.fetchImpl })
    .refreshAccessToken("synthetic-refresh-token").then(() => null, e => e));
  assert.deepEqual([invalid.status, invalid.code, invalid.retryAfterMs], [400, "invalid_grant", 0]);

  // Reviews: enum mapping, anonymous reviewer, missing comment, pageToken passthrough.
  const listed = fakeFetch(call => call.url.searchParams.get("pageToken")
    ? { body: { reviews: [REVIEW("r3", { starRating: "ONE" })] } }
    : {
      body: {
        reviews: [
          REVIEW("r1"),
          REVIEW("r2", { starRating: "TWO", comment: "", reviewer: { displayName: "Hidden", isAnonymous: true } }),
          REVIEW("r3", { starRating: "FOUR", reviewer: { displayName: "Example Two" } }),
          REVIEW("r4", { starRating: "SOMETHING" }),
          REVIEW("r5", { starRating: "THREE", comment: undefined })
        ],
        nextPageToken: "next-synthetic"
      }
    });
  const reviewClient = googleBusinessClient({ config: CONFIG, fetchImpl: listed.fetchImpl });
  const location = "accounts/aa/locations/l1";
  const first = await reviewClient.listReviews("synthetic-access-token", location);
  assert.deepEqual(first.reviews, [
    { reviewId: "r1", rating: 5, comment: "Synthetic kind words", reviewerName: "Example Reviewer", createTime: "2026-10-01T00:00:00Z", updateTime: "2026-10-02T00:00:00Z" },
    { reviewId: "r2", rating: 2, comment: "", reviewerName: null, createTime: "2026-10-01T00:00:00Z", updateTime: "2026-10-02T00:00:00Z" },
    { reviewId: "r3", rating: 4, comment: "Synthetic kind words", reviewerName: "Example Two", createTime: "2026-10-01T00:00:00Z", updateTime: "2026-10-02T00:00:00Z" },
    { reviewId: "r4", rating: 0, comment: "Synthetic kind words", reviewerName: "Example Reviewer", createTime: "2026-10-01T00:00:00Z", updateTime: "2026-10-02T00:00:00Z" },
    { reviewId: "r5", rating: 3, comment: "", reviewerName: "Example Reviewer", createTime: "2026-10-01T00:00:00Z", updateTime: "2026-10-02T00:00:00Z" }
  ]);
  assert.equal(first.nextPageToken, "next-synthetic");
  const second = await reviewClient.listReviews("synthetic-access-token", location, "next-synthetic");
  assert.deepEqual(second.reviews.map(r => [r.reviewId, r.rating]), [["r3", 1]]);
  assert.equal(second.nextPageToken, undefined);
  assert.equal(listed.calls.length, 2);
  for (const call of listed.calls) {
    assert.equal(call.method, "GET");
    assert.equal(endpoint(call.url), `https://mybusiness.googleapis.com/v4/${location}/reviews`);
    assert.equal(call.url.searchParams.get("pageSize"), "50");
    assert.equal(call.headers.authorization, "Bearer synthetic-access-token");
    assert.equal(call.headers.accept, "application/json");
    assert.equal(call.signal, true);
  }
  assert.equal(listed.calls[0].url.searchParams.get("pageToken"), null);
  assert.equal(listed.calls[1].url.searchParams.get("pageToken"), "next-synthetic");

  const badLocation = fakeFetch(() => ({ body: { reviews: [] } }));
  const bad = refusal(await googleBusinessClient({ config: CONFIG, fetchImpl: badLocation.fetchImpl })
    .listReviews("synthetic-access-token", "locations/l1").then(() => null, e => e));
  assert.equal(bad.code, "bad_location");
  assert.equal(badLocation.calls.length, 0, "an invalid location is rejected before any fetch");

  // Throttling and server failures keep only a short code and a parsed delay.
  const limited = fakeFetch(() => ({ status: 429, headers: { "retry-after": "2" }, body: { error: { message: "provider said synthetic-secret" } } }));
  const throttled = refusal(await googleBusinessClient({ config: CONFIG, fetchImpl: limited.fetchImpl })
    .listReviews("synthetic-access-token", location).then(() => null, e => e));
  assert.deepEqual([throttled.status, throttled.code, throttled.retryAfterMs], [429, "google_http_429", 2000]);
  const unavailable = fakeFetch(() => ({ status: 503, headers: { "retry-after": "7" }, body: {} }));
  const service = refusal(await googleBusinessClient({ config: CONFIG, fetchImpl: unavailable.fetchImpl })
    .listReviews("synthetic-access-token", location).then(() => null, e => e));
  assert.deepEqual([service.status, service.code, service.retryAfterMs], [503, "google_http_503", 7000]);
  const broken = fakeFetch(() => ({ status: 500, body: { error: { message: "provider said synthetic-secret" } } }));
  const server = refusal(await googleBusinessClient({ config: CONFIG, fetchImpl: broken.fetchImpl })
    .listReviews("synthetic-access-token", location).then(() => null, e => e));
  assert.deepEqual([server.status, server.code, server.retryAfterMs], [500, "google_http_500", 0]);
  const offline = fakeFetch(() => ({ fail: true }));
  const network = refusal(await googleBusinessClient({ config: CONFIG, fetchImpl: offline.fetchImpl })
    .refreshAccessToken("synthetic-refresh-token").then(() => null, e => e));
  assert.deepEqual([network.status, network.code], [0, "network"]);
  // Google omits empty lists: a location with no reviews and an owner with no accounts are not errors.
  const empty = fakeFetch(() => ({ body: {} }));
  assert.deepEqual(await googleBusinessClient({ config: CONFIG, fetchImpl: empty.fetchImpl })
    .listReviews("synthetic-access-token", location), { reviews: [] });
  assert.deepEqual(await googleBusinessClient({ config: CONFIG, fetchImpl: empty.fetchImpl })
    .listLocations("synthetic-access-token"), []);
  const malformed = fakeFetch(() => ({ body: { reviews: "not-a-list" } }));
  const shape = refusal(await googleBusinessClient({ config: CONFIG, fetchImpl: malformed.fetchImpl })
    .listReviews("synthetic-access-token", location).then(() => null, e => e));
  assert.equal(shape.code, "bad_response");

  // Accounts, then locations per account: combine names, join addresses, bound pages.
  const account = (id: string) => ({ name: `accounts/${id}` });
  const place = (id: string, title: string, storefrontAddress?: unknown) => ({ name: `locations/${id}`, title, storefrontAddress });
  const places = fakeFetch(call => {
    const token = call.url.searchParams.get("pageToken");
    if (endpoint(call.url) === "https://mybusinessaccountmanagement.googleapis.com/v1/accounts") {
      return token
        ? { body: { accounts: [account("cc")] } }
        : { body: { accounts: [account("aa"), account("bb")], nextPageToken: "accounts-2" } };
    }
    const accountId = call.url.pathname.split("/v1/")[1].split("/locations")[0].slice("accounts/".length);
    if (accountId === "aa" && !token) {
      return {
        body: {
          locations: [
            place("l1", "One", { addressLines: ["123 Example St", "Suite 4"], locality: "Toronto", administrativeArea: "ON" }),
            place("l2", "Two")
          ],
          nextPageToken: "locations-2"
        }
      };
    }
    if (accountId === "aa") {
      return { body: { locations: [place("l3", "Three", { addressLines: ["9 Other Rd"], locality: "Montreal", administrativeArea: "QC" })] } };
    }
    return { body: { locations: [place(`l-${accountId}`, `Title ${accountId}`, { locality: "Vancouver", administrativeArea: "BC" })] } };
  });
  assert.deepEqual(
    await googleBusinessClient({ config: CONFIG, fetchImpl: places.fetchImpl }).listLocations("synthetic-access-token"),
    [
      { name: "accounts/aa/locations/l1", title: "One", address: "123 Example St, Suite 4, Toronto, ON" },
      { name: "accounts/aa/locations/l2", title: "Two", address: null },
      { name: "accounts/aa/locations/l3", title: "Three", address: "9 Other Rd, Montreal, QC" },
      { name: "accounts/bb/locations/l-bb", title: "Title bb", address: "Vancouver, BC" },
      { name: "accounts/cc/locations/l-cc", title: "Title cc", address: "Vancouver, BC" }
    ]
  );
  assert.equal(places.calls.length, 6, "2 account pages and 4 location pages");
  assert.deepEqual(
    places.calls.map(call => `${endpoint(call.url)}?${call.url.searchParams.toString()}`),
    [
      "https://mybusinessaccountmanagement.googleapis.com/v1/accounts?",
      "https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageToken=accounts-2",
      "https://mybusinessbusinessinformation.googleapis.com/v1/accounts/aa/locations?readMask=name%2Ctitle%2CstorefrontAddress&pageSize=100",
      "https://mybusinessbusinessinformation.googleapis.com/v1/accounts/aa/locations?readMask=name%2Ctitle%2CstorefrontAddress&pageSize=100&pageToken=locations-2",
      "https://mybusinessbusinessinformation.googleapis.com/v1/accounts/bb/locations?readMask=name%2Ctitle%2CstorefrontAddress&pageSize=100",
      "https://mybusinessbusinessinformation.googleapis.com/v1/accounts/cc/locations?readMask=name%2Ctitle%2CstorefrontAddress&pageSize=100"
    ]
  );
  for (const call of places.calls) {
    assert.equal(call.method, "GET");
    assert.equal(call.headers.authorization, "Bearer synthetic-access-token");
  }
  const looping = fakeFetch(() => ({ body: { accounts: [], nextPageToken: "same-token" } }));
  assert.deepEqual(
    await googleBusinessClient({ config: CONFIG, fetchImpl: looping.fetchImpl }).listLocations("synthetic-access-token"),
    []
  );
  assert.equal(looping.calls.length, 10, "a bad nextPageToken cannot loop forever");

  // Revoke posts the refresh token as a form field and accepts an empty response.
  const revoked = fakeFetch(() => ({}));
  await googleBusinessClient({ config: CONFIG, fetchImpl: revoked.fetchImpl }).revoke("synthetic-refresh-token");
  assert.equal(revoked.calls.length, 1);
  assert.equal(endpoint(revoked.calls[0].url), "https://oauth2.googleapis.com/revoke");
  assert.deepEqual(Object.fromEntries(form(revoked.calls[0]).entries()), { token: "synthetic-refresh-token" });

  // No thrown message carries a token, code, secret or provider error text.
  assert.ok(errors.length >= 9, "every failure path was exercised");
  for (const error of errors) {
    assert.equal(error.message, (error as GoogleApiError).code, "errors carry only a short code");
    for (const secret of SECRETS) {
      assert.ok(!error.message.includes(secret), `error leaked ${secret}`);
    }
  }

  console.log("Google Business live client tests passed (injected fetch, no live calls)");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
