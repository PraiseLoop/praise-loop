import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { databaseFixture } from "./db-fixture";
import { sessionHash } from "../lib/auth-adapter";
import { setOwnerPlan } from "../lib/services/entitlements";
import {
  chooseGoogleLocation,
  completeGoogleConnect,
  disconnectGoogle,
  getGoogleConnection,
  GoogleConnectionError,
  startGoogleConnect
} from "../lib/services/googleConnection";
import { connect, googleReviewSyncEnabled } from "../lib/integrations/googleReviews";
import { GOOGLE_BUSINESS_SCOPE, GoogleApiError, type GoogleBusinessClient, type GoogleLocation } from "../lib/integrations/googleBusiness";

const ENV = {
  GOOGLE_REVIEW_SYNC: "1",
  GOOGLE_CLIENT_ID: "synthetic-google-client",
  GOOGLE_CLIENT_SECRET: "synthetic-google-secret",
  GOOGLE_TOKEN_KEY: randomBytes(32).toString("base64"),
  NEXTAUTH_URL: "http://localhost"
};
const LOCATION_ONE: GoogleLocation = { name: "accounts/1/locations/2", title: "Synthetic Cafe", address: "1 Synthetic Street" };
const LOCATION_TWO: GoogleLocation = { name: "accounts/1/locations/3", title: "Synthetic Annex", address: null };
const LOCATION_THREE: GoogleLocation = { name: "accounts/1/locations/4", title: "Synthetic North", address: "9 Example Road" };
const REFRESH = "synthetic-refresh-token";

type Fake = { client: GoogleBusinessClient; calls: { exchange: number; list: number; revoked: string[] } };
function fakeClient(opts: { locations?: GoogleLocation[]; exchangeError?: Error; listError?: Error; refreshToken?: string } = {}): Fake {
  const calls = { exchange: 0, list: 0, revoked: [] as string[] };
  const client: GoogleBusinessClient = {
    async exchangeCode() {
      calls.exchange += 1;
      if (opts.exchangeError) throw opts.exchangeError;
      return { refreshToken: opts.refreshToken ?? REFRESH, accessToken: "synthetic-access-token", scope: GOOGLE_BUSINESS_SCOPE };
    },
    async listLocations() {
      calls.list += 1;
      if (opts.listError) throw opts.listError;
      return (opts.locations ?? [LOCATION_ONE, LOCATION_TWO, LOCATION_THREE]).map(l => ({ ...l }));
    },
    async refreshAccessToken() { return "synthetic-access-token"; },
    async listReviews() { return { reviews: [] }; },
    async revoke(token) { calls.revoked.push(token); }
  };
  return { client, calls };
}

function cookieRequest(path: string, method: string, session: string, body?: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { cookie: `next-auth.session-token=${session}`, origin: "http://localhost", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}
function anonymousRequest(path: string, method: string) {
  return new NextRequest(`http://localhost${path}`, { method, headers: { origin: "http://localhost" } });
}
function stateOf(url: string): string {
  const state = new URL(url).searchParams.get("state");
  assert.ok(state, "the authorize URL carries a state");
  return state;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function callbackFetch(locations: GoogleLocation[]): typeof fetch {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" }
  });
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/token") {
      return json({ refresh_token: "route-refresh-token", access_token: "route-access-token", scope: GOOGLE_BUSINESS_SCOPE });
    }
    if (url.pathname === "/v1/accounts") return json({ accounts: [{ name: "accounts/1" }] });
    if (url.pathname === "/v1/accounts/1/locations") {
      return json({
        locations: locations.map(l => ({
          name: l.name, title: l.title,
          ...(l.address ? { storefrontAddress: { addressLines: [l.address] } } : {})
        }))
      });
    }
    return json({ error: "unexpected synthetic route" }, 500);
  }) as unknown as typeof fetch;
}

const saved = Object.fromEntries(Object.keys(ENV).map(key => [key, process.env[key]]));
const savedFetch = globalThis.fetch;

async function main() {
  Object.assign(process.env, ENV);
  let fixtureRan = false;
  try {
    await databaseFixture(async client => {
      fixtureRan = true;
      process.env.GOOGLE_TOKEN_KEY = ENV.GOOGLE_TOKEN_KEY;
      await client.query(`INSERT INTO auth_users(id,email) VALUES
        ('gc-owner','gc@example.invalid'),('gc-other','gc-other@example.invalid'),
        ('gc-free','gc-free@example.invalid'),('gc-delete','gc-delete@example.invalid')`);
      const business = async (owner: string, name: string) =>
        Number((await client.query("INSERT INTO businesses(owner_id,name,timezone) VALUES($1,$2,'UTC') RETURNING id", [owner, name])).rows[0].id);
      const biz = await business("gc-owner", "Synthetic connect business");
      const otherBiz = await business("gc-other", "Synthetic other business");
      const freeBiz = await business("gc-free", "Synthetic free business");
      const zeroBiz = await business("gc-owner", "Synthetic zero-location business");
      const manyBiz = await business("gc-owner", "Synthetic picker business");
      const expiryBiz = await business("gc-owner", "Synthetic expiry business");
      const fallbackBiz = await business("gc-owner", "Synthetic flag-off business");
      await business("gc-delete", "Synthetic deletion business");
      await setOwnerPlan("gc-owner", "pro", { reason: "Synthetic plan" });
      await setOwnerPlan("gc-other", "pro", { reason: "Synthetic plan" });

      // Flag: off unless explicitly 1 and the OAuth client is configured.
      assert.equal(googleReviewSyncEnabled({ ...ENV }), true);
      assert.equal(googleReviewSyncEnabled({ ...ENV, GOOGLE_REVIEW_SYNC: undefined }), false);
      assert.equal(googleReviewSyncEnabled({ ...ENV, GOOGLE_REVIEW_SYNC: "true" }), false);
      assert.equal(googleReviewSyncEnabled({ ...ENV, GOOGLE_CLIENT_SECRET: undefined }), false);
      await assert.rejects(
        () => startGoogleConnect("gc-owner", biz, { env: { ...ENV, GOOGLE_REVIEW_SYNC: undefined } }),
        (error: unknown) => error instanceof GoogleConnectionError && error.code === "not_configured"
      );
      assert.equal((await getGoogleConnection("gc-owner", biz, { env: { ...ENV, GOOGLE_REVIEW_SYNC: undefined } })).enabled, false);

      // Free plan is refused on every write path, and nothing is written.
      await assert.rejects(
        () => startGoogleConnect("gc-free", freeBiz, { env: ENV }),
        (error: unknown) => error instanceof GoogleConnectionError && error.code === "plan_required"
      );
      assert.equal((await client.query("SELECT count(*)::int n FROM google_oauth_states WHERE owner_id='gc-free'")).rows[0].n, 0);
      await assert.rejects(
        () => chooseGoogleLocation("gc-other", otherBiz, LOCATION_ONE.name, { env: ENV, client: fakeClient().client }),
        (error: unknown) => error instanceof GoogleConnectionError && error.code === "expired"
      );

      // Start stores only a hash bound to both owner and business.
      const authorize = await startGoogleConnect("gc-owner", biz, { env: ENV });
      const parsed = new URL(authorize);
      assert.equal(parsed.hostname, "accounts.google.com");
      assert.equal(parsed.searchParams.get("client_id"), ENV.GOOGLE_CLIENT_ID);
      assert.equal(parsed.searchParams.get("redirect_uri"), `${ENV.NEXTAUTH_URL}/api/google/callback`);
      assert.equal(parsed.searchParams.get("scope"), GOOGLE_BUSINESS_SCOPE);
      assert.equal(parsed.searchParams.get("access_type"), "offline");
      const state = stateOf(authorize);
      assert.equal((await client.query("SELECT count(*)::int n FROM google_oauth_states WHERE state_hash=$1", [state])).rows[0].n, 0);
      const stateRow = (await client.query("SELECT owner_id,business_id FROM google_oauth_states WHERE state_hash=$1", [hash(state)])).rows[0];
      assert.deepEqual([stateRow.owner_id, Number(stateRow.business_id)], ["gc-owner", biz]);

      // Single location: connect immediately, storing the display title.
      const one = fakeClient({ locations: [LOCATION_ONE] });
      assert.deepEqual(
        await completeGoogleConnect({ state, code: "synthetic-code", ownerId: "gc-owner" }, { env: ENV, client: one.client }),
        { ownerId: "gc-owner", businessId: biz, outcome: "connected", locations: 1 }
      );
      assert.equal(one.calls.exchange, 1);
      assert.equal(one.calls.list, 1);
      const connected = (await client.query("SELECT status,location_name,location_title,encrypted_refresh_token FROM google_connections WHERE business_id=$1", [biz])).rows[0];
      assert.deepEqual([connected.status, connected.location_name, connected.location_title], ["active", LOCATION_ONE.name, LOCATION_ONE.title]);
      assert.ok(!connected.encrypted_refresh_token.includes(REFRESH));
      assert.equal((await client.query("SELECT count(*)::int n FROM google_oauth_states WHERE state_hash=$1", [hash(state)])).rows[0].n, 0, "state is single use");
      await assert.rejects(
        () => completeGoogleConnect({ state, code: "replay", ownerId: "gc-owner" }, { env: ENV, client: fakeClient().client }),
        (error: unknown) => error instanceof GoogleConnectionError && error.code === "expired"
      );

      // A state bound to one owner cannot be completed by another, and is not consumed.
      const boundState = stateOf(await startGoogleConnect("gc-owner", biz, { env: ENV }));
      await assert.rejects(
        () => completeGoogleConnect({ state: boundState, code: "x", ownerId: "gc-other" }, { env: ENV, client: fakeClient().client }),
        (error: unknown) => error instanceof GoogleConnectionError && error.code === "expired"
      );
      assert.equal((await client.query("SELECT count(*)::int n FROM google_oauth_states WHERE state_hash=$1", [hash(boundState)])).rows[0].n, 1);
      await completeGoogleConnect({ state: boundState, code: "x", ownerId: "gc-owner" }, { env: ENV, client: one.client });

      // Expired states are refused and cleaned by the next start.
      const expired = "synthetic-expired-state";
      await client.query("INSERT INTO google_oauth_states(state_hash,owner_id,business_id,expires_at) VALUES($1,$2,$3,now()-interval '1 minute')", [hash(expired), "gc-owner", biz]);
      await assert.rejects(
        () => completeGoogleConnect({ state: expired, code: "x", ownerId: "gc-owner" }, { env: ENV, client: one.client }),
        (error: unknown) => error instanceof GoogleConnectionError && error.code === "expired"
      );
      await startGoogleConnect("gc-owner", biz, { env: ENV });
      assert.equal((await client.query("SELECT count(*)::int n FROM google_oauth_states WHERE state_hash=$1", [hash(expired)])).rows[0].n, 0);

      // Callback: zero locations leaves any existing connection alone.
      const zeroState = stateOf(await startGoogleConnect("gc-owner", zeroBiz, { env: ENV }));
      const zero = fakeClient({ locations: [] });
      assert.equal((await completeGoogleConnect({ state: zeroState, code: "x", ownerId: "gc-owner" }, { env: ENV, client: zero.client })).outcome, "no_locations");
      assert.deepEqual(zero.calls.revoked, [REFRESH], "an unusable grant is handed back to Google");
      assert.equal((await client.query("SELECT count(*)::int n FROM google_connections WHERE business_id=$1", [zeroBiz])).rows[0].n, 0);

      // Callback: missing_scope and missing_refresh_token fail with short outcomes.
      const scopeState = stateOf(await startGoogleConnect("gc-owner", zeroBiz, { env: ENV }));
      await assert.rejects(
        () => completeGoogleConnect({ state: scopeState, code: "x", ownerId: "gc-owner" }, { env: ENV, client: fakeClient({ exchangeError: new GoogleApiError(200, "missing_scope") }).client }),
        (error: unknown) => error instanceof GoogleConnectionError && error.code === "missing_scope"
      );
      const tokenState = stateOf(await startGoogleConnect("gc-owner", zeroBiz, { env: ENV }));
      await assert.rejects(
        () => completeGoogleConnect({ state: tokenState, code: "x", ownerId: "gc-owner" }, { env: ENV, client: fakeClient({ exchangeError: new GoogleApiError(200, "missing_refresh_token") }).client }),
        (error: unknown) => error instanceof GoogleConnectionError && error.code === "failed"
      );

      // Callback: a paid owner can be downgraded between start and completion.
      const lapseState = stateOf(await startGoogleConnect("gc-owner", zeroBiz, { env: ENV }));
      await setOwnerPlan("gc-owner", "free", { reason: "Synthetic downgrade" });
      await assert.rejects(
        () => completeGoogleConnect({ state: lapseState, code: "x", ownerId: "gc-owner" }, { env: ENV, client: one.client }),
        (error: unknown) => error instanceof GoogleConnectionError && error.code === "plan_required"
      );
      await setOwnerPlan("gc-owner", "pro", { reason: "Synthetic restore" });

      // Many locations: hold the encrypted grant and show only display data.
      const manyState = stateOf(await startGoogleConnect("gc-owner", manyBiz, { env: ENV }));
      const many = fakeClient();
      assert.equal((await completeGoogleConnect({ state: manyState, code: "x", ownerId: "gc-owner" }, { env: ENV, client: many.client })).outcome, "pick_location");
      const grant = (await client.query("SELECT encrypted_refresh_token,locations FROM google_pending_grants WHERE business_id=$1", [manyBiz])).rows[0];
      assert.ok(!grant.encrypted_refresh_token.includes(REFRESH));
      const storedLocations: GoogleLocation[] = typeof grant.locations === "string" ? JSON.parse(grant.locations) : grant.locations;
      assert.deepEqual(storedLocations.map(l => l.title), [LOCATION_ONE.title, LOCATION_TWO.title, LOCATION_THREE.title]);
      const pendingView = await getGoogleConnection("gc-owner", manyBiz, { env: ENV });
      assert.equal(pendingView.status, "none");
      assert.deepEqual(pendingView.pending?.locations.map(l => l.name), [LOCATION_ONE.name, LOCATION_TWO.name, LOCATION_THREE.name]);
      assert.doesNotMatch(JSON.stringify(pendingView), new RegExp(REFRESH));
      assert.doesNotMatch(JSON.stringify(pendingView), /v1\.|encrypted_refresh_token|client_secret|synthetic-google-secret/);

      // A client-supplied location must be one of the pending grant's locations.
      await assert.rejects(
        () => chooseGoogleLocation("gc-owner", manyBiz, "accounts/9/locations/9", { env: ENV, client: many.client }),
        (error: unknown) => error instanceof GoogleConnectionError && error.code === "invalid_location"
      );
      assert.equal((await client.query("SELECT count(*)::int n FROM google_pending_grants WHERE business_id=$1", [manyBiz])).rows[0].n, 1);
      await assert.rejects(
        () => chooseGoogleLocation("gc-other", manyBiz, LOCATION_TWO.name, { env: ENV, client: many.client }),
        (error: unknown) => error instanceof GoogleConnectionError && error.code === "expired"
      );
      const chosen = await chooseGoogleLocation("gc-owner", manyBiz, LOCATION_TWO.name, { env: ENV, client: many.client });
      assert.equal(chosen.status, "active");
      assert.equal(chosen.locationTitle, LOCATION_TWO.title);
      assert.equal(chosen.pending, null);
      const chosenRow = (await client.query("SELECT location_name,location_title FROM google_connections WHERE business_id=$1", [manyBiz])).rows[0];
      assert.deepEqual([chosenRow.location_name, chosenRow.location_title], [LOCATION_TWO.name, LOCATION_TWO.title]);
      assert.equal(many.calls.revoked.length, 0, "choosing a location does not revoke the grant");
      assert.doesNotMatch(JSON.stringify(chosen), /v1\.|synthetic-refresh-token/);

      // Reconnecting (possibly to another location) clears the previous connection's
      // sync stats, so the status card reports "Not synced yet" until the first sync.
      await client.query("UPDATE google_connections SET last_sync_at=now()-interval '1 day', last_sync_count=21 WHERE business_id=$1", [manyBiz]);
      assert.ok(await connect("gc-owner", manyBiz, LOCATION_THREE.name, "synthetic-reconnect-token", LOCATION_THREE.title));
      const rewired = (await client.query("SELECT location_name,last_sync_at,last_sync_count FROM google_connections WHERE business_id=$1", [manyBiz])).rows[0];
      assert.deepEqual([rewired.location_name, rewired.last_sync_at, rewired.last_sync_count], [LOCATION_THREE.name, null, 0], "reconnect clears old sync stats");
      const fresh = await getGoogleConnection("gc-owner", manyBiz, { env: ENV });
      assert.deepEqual([fresh.status, fresh.locationTitle, fresh.lastSyncAt, fresh.lastSyncCount], ["active", LOCATION_THREE.title, null, 0], "the view reports no last sync");

      // Location choice is also a write path: a free plan is refused, pending kept.
      const lapsePickState = stateOf(await startGoogleConnect("gc-owner", expiryBiz, { env: ENV }));
      await completeGoogleConnect({ state: lapsePickState, code: "x", ownerId: "gc-owner" }, { env: ENV, client: many.client });
      await setOwnerPlan("gc-owner", "free", { reason: "Synthetic downgrade" });
      await assert.rejects(
        () => chooseGoogleLocation("gc-owner", expiryBiz, LOCATION_ONE.name, { env: ENV, client: many.client }),
        (error: unknown) => error instanceof GoogleConnectionError && error.code === "plan_required"
      );
      assert.equal((await client.query("SELECT count(*)::int n FROM google_pending_grants WHERE business_id=$1", [expiryBiz])).rows[0].n, 1);
      await setOwnerPlan("gc-owner", "pro", { reason: "Synthetic restore" });
      await client.query("UPDATE google_pending_grants SET expires_at=now()-interval '1 minute' WHERE business_id=$1", [expiryBiz]);
      await assert.rejects(
        () => chooseGoogleLocation("gc-owner", expiryBiz, LOCATION_ONE.name, { env: ENV, client: many.client }),
        (error: unknown) => error instanceof GoogleConnectionError && error.code === "expired"
      );
      assert.equal((await getGoogleConnection("gc-owner", expiryBiz, { env: ENV })).pending, null);

      // Disconnect clears the pending grant and token, and revokes at Google once.
      const disconnected = fakeClient();
      const disconnectState = stateOf(await startGoogleConnect("gc-owner", biz, { env: ENV }));
      await completeGoogleConnect({ state: disconnectState, code: "x", ownerId: "gc-owner" }, { env: ENV, client: fakeClient().client });
      const pendingAgain = stateOf(await startGoogleConnect("gc-owner", biz, { env: ENV }));
      await completeGoogleConnect({ state: pendingAgain, code: "x", ownerId: "gc-owner" }, { env: ENV, client: fakeClient().client });
      assert.equal((await client.query("SELECT count(*)::int n FROM google_pending_grants WHERE business_id=$1", [biz])).rows[0].n, 1);
      assert.equal(await disconnectGoogle("gc-owner", biz, { env: ENV, client: disconnected.client }), true);
      assert.deepEqual(disconnected.calls.revoked, [REFRESH]);
      const after = (await client.query("SELECT status,encrypted_refresh_token FROM google_connections WHERE business_id=$1", [biz])).rows[0];
      assert.deepEqual([after.status, after.encrypted_refresh_token], ["disconnected", null]);
      assert.equal((await client.query("SELECT count(*)::int n FROM google_pending_grants WHERE business_id=$1", [biz])).rows[0].n, 0);
      assert.equal((await getGoogleConnection("gc-owner", biz, { env: ENV })).status, "disconnected");

      // A flag switched off after connecting still drops the token locally;
      // clear the live OAuth config so no provider client can be built in the test.
      await client.query(
        `INSERT INTO google_connections(business_id,owner_id,location_name,location_title,encrypted_refresh_token,status)
         VALUES($1,'gc-owner',$2,$3,$4,'active')`,
        [fallbackBiz, LOCATION_ONE.name, LOCATION_ONE.title, (require("../lib/integrations/googleReviews") as typeof import("../lib/integrations/googleReviews")).encryptToken(REFRESH, "gc-owner", fallbackBiz)]
      );
      const noClient = fakeClient();
      const savedClientId = process.env.GOOGLE_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_ID;
      try {
        assert.equal(await disconnectGoogle("gc-owner", fallbackBiz), true);
      } finally {
        process.env.GOOGLE_CLIENT_ID = savedClientId!;
      }
      assert.equal(noClient.calls.revoked.length, 0);
      assert.equal((await client.query("SELECT status,encrypted_refresh_token FROM google_connections WHERE business_id=$1", [fallbackBiz])).rows[0].encrypted_refresh_token, null);

      // Routes: anonymous writes are 401; the flag hides connect; plan gates it.
      for (const token of ["gc-route-session", "gc-free-route-session"]) {
        await client.query("INSERT INTO auth_sessions(token_hash,owner_id,expires,kind) VALUES($1,$2,now()+interval '1 hour','web')", [sessionHash(token), token.startsWith("gc-free") ? "gc-free" : "gc-owner"]);
      }
      const params = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
      const connectRoute = require("../app/api/businesses/[id]/google/connect/route");
      const connectionRoute = require("../app/api/businesses/[id]/google/connection/route");
      const locationRoute = require("../app/api/businesses/[id]/google/location/route");
      assert.equal((await connectRoute.POST(anonymousRequest(`/api/businesses/${biz}/google/connect`, "POST"), params(biz))).status, 401);
      assert.equal((await connectionRoute.GET(anonymousRequest(`/api/businesses/${biz}/google/connection`, "GET"), params(biz))).status, 401);
      assert.equal((await locationRoute.POST(anonymousRequest(`/api/businesses/${biz}/google/location`, "POST"), params(biz))).status, 401);
      delete process.env.GOOGLE_REVIEW_SYNC;
      try {
        const off = await connectRoute.POST(cookieRequest(`/api/businesses/${biz}/google/connect`, "POST", "gc-route-session"), params(biz));
        assert.equal(off.status, 503);
        assert.deepEqual(await off.json(), { error: "not_configured" });
      } finally {
        process.env.GOOGLE_REVIEW_SYNC = ENV.GOOGLE_REVIEW_SYNC;
      }
      const freeConnect = await connectRoute.POST(cookieRequest(`/api/businesses/${freeBiz}/google/connect`, "POST", "gc-free-route-session"), params(freeBiz));
      assert.equal(freeConnect.status, 403);
      assert.deepEqual(await freeConnect.json(), { error: "plan_required" });

      // Callback: no session and a refusal never 5xx; a real callback connects.
      const callbackRoute = require("../app/api/google/callback/route");
      assert.equal((await callbackRoute.GET(new NextRequest("http://localhost/api/google/callback?state=x&code=y"))).status, 302);
      assert.match((await callbackRoute.GET(new NextRequest("http://localhost/api/google/callback?error=access_denied"))).headers.get("location") ?? "", /google=denied/);
      const routeState = stateOf((await (await connectRoute.POST(cookieRequest(`/api/businesses/${biz}/google/connect`, "POST", "gc-route-session"), params(biz))).json()).url);
      const savedFetch = globalThis.fetch;
      globalThis.fetch = callbackFetch([LOCATION_ONE]);
      try {
        const callback = await callbackRoute.GET(new NextRequest(`http://localhost/api/google/callback?state=${encodeURIComponent(routeState)}&code=route-code`, {
          headers: { cookie: "next-auth.session-token=gc-route-session" }
        }));
        assert.equal(callback.status, 302);
        assert.match(callback.headers.get("location") ?? "", new RegExp(`/reviews\\?businessId=${biz}&google=connected`));
      } finally {
        globalThis.fetch = savedFetch;
      }

      // The business-scoped picker route re-checks the plan and the pending list.
      const pickerState = stateOf(await startGoogleConnect("gc-owner", expiryBiz, { env: ENV }));
      await completeGoogleConnect({ state: pickerState, code: "x", ownerId: "gc-owner" }, { env: ENV, client: many.client });
      const routePick = await locationRoute.POST(
        cookieRequest(`/api/businesses/${expiryBiz}/google/location`, "POST", "gc-route-session", { location: LOCATION_ONE.name }),
        params(expiryBiz)
      );
      assert.equal(routePick.status, 200);
      assert.equal((await routePick.json()).status, "active");
      const viewed = await connectionRoute.GET(cookieRequest(`/api/businesses/${expiryBiz}/google/connection`, "GET", "gc-route-session"), params(expiryBiz));
      assert.equal(viewed.status, 200);
      assert.doesNotMatch(JSON.stringify(await viewed.json()), /v1\.|route-refresh-token/);
      assert.equal((await connectionRoute.DELETE(cookieRequest(`/api/businesses/${expiryBiz}/google/connection`, "DELETE", "gc-route-session"), params(expiryBiz))).status, 200);

      // Deleting the owner cascades both new tables away.
      await client.query("INSERT INTO google_oauth_states(state_hash,owner_id,business_id,expires_at) VALUES($1::text,'gc-delete',$2::bigint,now()+interval '10 minutes')", [hash("delete-state"), (await client.query("SELECT id FROM businesses WHERE owner_id='gc-delete'")).rows[0].id]);
      await client.query(
        `INSERT INTO google_pending_grants(owner_id,business_id,encrypted_refresh_token,locations,expires_at)
         SELECT 'gc-delete',id,'v1.synthetic',$1::jsonb,now()+interval '15 minutes' FROM businesses WHERE owner_id='gc-delete'`,
        [JSON.stringify([LOCATION_ONE])]
      );
      await client.query("DELETE FROM businesses WHERE owner_id='gc-delete'");
      await client.query("DELETE FROM auth_users WHERE id='gc-delete'");
      for (const table of ["google_oauth_states", "google_pending_grants"]) {
        assert.equal((await client.query(`SELECT count(*)::int n FROM ${table} WHERE owner_id='gc-delete'`)).rows[0].n, 0, `${table} cascades with the owner`);
      }

      // The authorization inventory keeps the callback public but session-checked.
      const authorizationTest = require("node:fs").readFileSync(require("node:path").join(__dirname, "test-authorization.ts"), "utf8") as string;
      assert.match(authorizationTest, /app\/api\/google\/callback\/route\.ts/);
    });
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  if (!fixtureRan) console.log("Google connect Postgres fixture skipped: set TEST_DATABASE_URL");
  console.log("Google connect, pending location choice, disconnect and routes passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
