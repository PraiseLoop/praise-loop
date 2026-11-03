import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import type { PoolClient } from "pg";
import { databaseFixture } from "./db-fixture";
import { authAdapter } from "../lib/auth-adapter";
import { decryptCredential, encryptCredential } from "../lib/integrations/credentials";
import {
  BufferConnectionError,
  clearBufferChannel,
  completeBufferConnect,
  disconnectBuffer,
  getBufferAccessToken,
  getBufferConnection,
  getSelectedBufferChannel,
  listBufferChannels,
  selectBufferChannel,
  startBufferConnect
} from "../lib/services/bufferConnection";

const AUTHORIZE = "https://auth.buffer.com/auth";
const TOKEN = "https://auth.buffer.com/token";
const API = "https://api.buffer.com";
const SCOPES = "posts:read posts:write account:read offline_access";

type Call = { url: string; method: string; headers: Record<string, string>; body: string };

function fakeFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(init.headers ?? {})) headers[key.toLowerCase()] = String(value);
    const call = {
      url: String(input),
      method: String(init.method ?? "GET"),
      headers,
      body: typeof init.body === "string" ? init.body : ""
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const tokenResponse = (overrides: Record<string, unknown> = {}) =>
  json({
    access_token: "synthetic-access",
    refresh_token: "synthetic-refresh",
    token_type: "Bearer",
    expires_in: 3600,
    scope: SCOPES,
    ...overrides
  });

const organizationsResponse = () =>
  json({ data: { account: { organizations: [{ id: "org-1", name: "Synthetic Org" }] } } });

const channelsResponse = (channels: unknown[]) => json({ data: { channels } });

function bufferFetch(options: {
  token?: (call: Call) => Response | Promise<Response>;
  api?: (call: Call) => Response | Promise<Response>;
} = {}) {
  return fakeFetch((call) => {
    if (call.url === TOKEN) return options.token?.(call) ?? tokenResponse();
    if (call.url === API) {
      if (call.body.includes("organizations")) return options.api?.(call) ?? organizationsResponse();
      return options.api?.(call) ?? channelsResponse([]);
    }
    throw new Error(`unexpected URL ${call.url}`);
  });
}

function authorizeParams(url: string) {
  assert.equal(new URL(url).origin + new URL(url).pathname, AUTHORIZE);
  return new URL(url).searchParams;
}

async function seedOwner(client: PoolClient, id: string) {
  await client.query("INSERT INTO auth_users(id,name,email) VALUES($1,$2,$3)", [id, id, `${id}@example.invalid`]);
  const business = Number((await client.query(
    "INSERT INTO businesses(name,timezone,owner_id) VALUES($1,'UTC',$2) RETURNING id",
    [id, id]
  )).rows[0].id);
  return { owner: id, businessId: business };
}

async function connectionCount(client: PoolClient, owner: string) {
  return Number((await client.query("SELECT count(*) FROM buffer_connections WHERE owner_id=$1", [owner])).rows[0].count);
}

async function seedConnection(
  client: PoolClient,
  owner: string,
  options: { accessToken?: string; refreshToken?: string; expiresInMs?: number; status?: "active" | "needs_reconnect" } = {}
) {
  const accessToken = options.accessToken ?? "seeded-access";
  const refreshToken = options.refreshToken ?? "seeded-refresh";
  const expiresInMs = options.expiresInMs ?? 60 * 60 * 1000;
  const status = options.status ?? "active";
  await client.query(
    `INSERT INTO buffer_connections(owner_id,organization_id,encrypted_access_token,encrypted_refresh_token,access_expires_at,scope,status)
     VALUES($1,'org-1',$2,$3,$4,$5,$6)
     ON CONFLICT(owner_id) DO UPDATE SET
       encrypted_access_token=EXCLUDED.encrypted_access_token,
       encrypted_refresh_token=EXCLUDED.encrypted_refresh_token,
       access_expires_at=EXCLUDED.access_expires_at,
       scope=EXCLUDED.scope,
       status=EXCLUDED.status,
       updated_at=now()`,
    [
      owner,
      encryptCredential(accessToken, `buffer:access:${owner}`),
      encryptCredential(refreshToken, `buffer:refresh:${owner}`),
      new Date(Date.now() + expiresInMs),
      SCOPES,
      status
    ]
  );
}

async function connectionStatus(client: PoolClient, owner: string) {
  return (await client.query("SELECT status FROM buffer_connections WHERE owner_id=$1", [owner])).rows[0]?.status as string | undefined;
}

// The callback needs the browser's own session cookie: it must belong to the owner who started the flow.
function callbackRequest(params: Record<string, string>, sessionToken?: string) {
  return new NextRequest(`http://localhost/api/buffer/callback?${new URLSearchParams(params)}`, {
    headers: sessionToken ? { cookie: `next-auth.session-token=${sessionToken}` } : {}
  });
}

const sessions = new Map<string, string>();
async function signIn(owner: string) {
  const existing = sessions.get(owner);
  if (existing) return existing;
  const sessionToken = `synthetic-session-${owner}`;
  await authAdapter.createSession!({ userId: owner, sessionToken, expires: new Date(Date.now() + 60 * 60 * 1000) });
  sessions.set(owner, sessionToken);
  return sessionToken;
}

async function main() {
  process.env.NEXTAUTH_URL = "http://localhost";
  process.env.BUFFER_CLIENT_ID = "synthetic-client-id";
  process.env.BUFFER_CLIENT_SECRET = "synthetic-client-secret";
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.BUFFER_REDIRECT_URI;

  // Capture every log line so the test can prove no secret reaches the logs.
  const logLines: string[] = [];
  const levels = ["log", "error", "warn"] as const;
  const original = { log: console.log, error: console.error, warn: console.warn };
  for (const level of levels) {
    console[level] = (...args: unknown[]) => { logLines.push(args.map(String).join(" ")); };
  }

  try {
    await databaseFixture(async (client) => {
      // --- authorize URL -------------------------------------------------
      const a = await seedOwner(client, "buffer-a");
      const authorize = await startBufferConnect(a.owner);
      const params = authorizeParams(authorize);
      assert.equal(params.get("client_id"), "synthetic-client-id");
      assert.equal(params.get("redirect_uri"), "http://localhost/api/buffer/callback");
      assert.equal(params.get("response_type"), "code");
      assert.equal(params.get("scope"), SCOPES);
      assert.equal(params.get("code_challenge_method"), "S256");
      assert.equal(params.get("prompt"), "consent", "needed for Buffer to grant offline_access and return a refresh token");
      assert.match(params.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
      assert.match(params.get("state") ?? "", /^[A-Za-z0-9_-]{43}$/);

      const state = params.get("state")!;
      const stateRow = (await client.query(
        "SELECT state_hash, encrypted_code_verifier, expires_at FROM buffer_oauth_states WHERE owner_id=$1",
        [a.owner]
      )).rows[0];
      assert.equal(stateRow.state_hash, createHash("sha256").update(state).digest("hex"));
      assert.notEqual(stateRow.state_hash, state, "the raw state is never stored");
      assert.match(stateRow.encrypted_code_verifier, /^v1\./);
      const verifier = decryptCredential(stateRow.encrypted_code_verifier, `buffer:verifier:${a.owner}`);
      assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
      assert.ok(!stateRow.encrypted_code_verifier.includes(verifier), "the verifier is encrypted at rest");
      const ttl = new Date(stateRow.expires_at).getTime() - Date.now();
      assert.ok(ttl > 9 * 60 * 1000 && ttl <= 10 * 60 * 1000, "states live ten minutes");

      process.env.BUFFER_REDIRECT_URI = "https://dev.praiseloop.invalid/api/buffer/callback";
      assert.equal(authorizeParams(await startBufferConnect(a.owner)).get("redirect_uri"), "https://dev.praiseloop.invalid/api/buffer/callback");
      delete process.env.BUFFER_REDIRECT_URI;

      // --- complete, token request and encryption at rest ----------------
      const exchange = bufferFetch();
      const completed = await completeBufferConnect({ state, code: "synthetic-code" }, { fetchImpl: exchange.fetchImpl });
      assert.deepEqual(completed, { ownerId: a.owner, outcome: "connected" });

      const tokenCall = exchange.calls.find((call) => call.url === TOKEN)!;
      assert.equal(tokenCall.method, "POST");
      assert.match(tokenCall.headers["content-type"], /^application\/x-www-form-urlencoded/);
      assert.ok(!tokenCall.body.trim().startsWith("{"), "the token request is form encoded");
      const form = new URLSearchParams(tokenCall.body);
      assert.equal(form.get("client_id"), "synthetic-client-id");
      assert.equal(form.get("client_secret"), "synthetic-client-secret");
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("code"), "synthetic-code");
      assert.equal(form.get("redirect_uri"), "http://localhost/api/buffer/callback");
      assert.equal(form.get("code_verifier"), verifier);

      const stored = (await client.query(
        "SELECT encrypted_access_token, encrypted_refresh_token, organization_id, scope, status FROM buffer_connections WHERE owner_id=$1",
        [a.owner]
      )).rows[0];
      assert.equal(stored.organization_id, "org-1");
      assert.equal(stored.scope, SCOPES);
      assert.equal(stored.status, "active");
      assert.notEqual(stored.encrypted_access_token, "synthetic-access");
      assert.notEqual(stored.encrypted_refresh_token, "synthetic-refresh");
      assert.ok(!stored.encrypted_access_token.includes("synthetic-access"));
      assert.ok(!stored.encrypted_refresh_token.includes("synthetic-refresh"));
      assert.equal(decryptCredential(stored.encrypted_access_token, `buffer:access:${a.owner}`), "synthetic-access");
      assert.equal(decryptCredential(stored.encrypted_refresh_token, `buffer:refresh:${a.owner}`), "synthetic-refresh");

      // --- state is single use and owner bound ---------------------------
      const replay = bufferFetch();
      await assert.rejects(
        completeBufferConnect({ state, code: "synthetic-code" }, { fetchImpl: replay.fetchImpl }),
        (error: unknown) => error instanceof BufferConnectionError && error.code === "expired"
      );
      assert.equal(replay.calls.length, 0, "a consumed state never reaches the token endpoint");

      const b = await seedOwner(client, "buffer-b");
      const bUrl = await startBufferConnect(b.owner);
      const bState = authorizeParams(bUrl).get("state")!;
      await client.query("UPDATE buffer_oauth_states SET expires_at=now()-interval '1 minute' WHERE owner_id=$1", [b.owner]);
      const expired = bufferFetch();
      await assert.rejects(
        completeBufferConnect({ state: bState, code: "synthetic-code" }, { fetchImpl: expired.fetchImpl }),
        (error: unknown) => error instanceof BufferConnectionError && error.code === "expired"
      );
      assert.equal(expired.calls.length, 0);
      assert.equal(await connectionCount(client, b.owner), 0);

      const unknown = bufferFetch();
      await assert.rejects(
        completeBufferConnect({ state: "unknown-state", code: "synthetic-code" }, { fetchImpl: unknown.fetchImpl }),
        (error: unknown) => error instanceof BufferConnectionError && error.code === "expired"
      );
      assert.equal(unknown.calls.length, 0);

      const c = await seedOwner(client, "buffer-c");
      const cState = authorizeParams(await startBufferConnect(c.owner)).get("state")!;
      const foreign = bufferFetch();
      await assert.rejects(
        completeBufferConnect({ state: cState, code: "synthetic-code", ownerId: "buffer-elsewhere" }, { fetchImpl: foreign.fetchImpl }),
        (error: unknown) => error instanceof BufferConnectionError && error.code === "expired"
      );
      assert.equal(foreign.calls.length, 0);
      assert.equal(await connectionCount(client, c.owner), 0, "another owner's state writes nothing");

      // A missing refresh token is a failed exchange, not a stored connection.
      const d = await seedOwner(client, "buffer-d");
      const dState = authorizeParams(await startBufferConnect(d.owner)).get("state")!;
      const noRefresh = bufferFetch({ token: () => tokenResponse({ refresh_token: undefined }) });
      await assert.rejects(
        completeBufferConnect({ state: dState, code: "synthetic-code" }, { fetchImpl: noRefresh.fetchImpl }),
        (error: unknown) => error instanceof BufferConnectionError && error.code === "failed"
      );
      assert.equal(await connectionCount(client, d.owner), 0);

      // A failed step says which step and what is safe to say, and never a code, state, verifier or token.
      const logged: string[] = [];
      const realError = console.error;
      console.error = (line?: unknown) => { logged.push(String(line)); };
      try {
        const g = await seedOwner(client, "buffer-diag-g");
        const gState = authorizeParams(await startBufferConnect(g.owner)).get("state")!;
        const rejected = bufferFetch({ token: () => json({ error: "invalid_client", error_description: "SUPERSECRET-description-should-not-reach-info-logs" }, 401) });
        await assert.rejects(completeBufferConnect({ state: gState, code: "synthetic-code-GGG" }, { fetchImpl: rejected.fetchImpl }), BufferConnectionError);
        const h = await seedOwner(client, "buffer-diag-h");
        const hState = authorizeParams(await startBufferConnect(h.owner)).get("state")!;
        const shape = bufferFetch({ token: () => tokenResponse({ refresh_token: undefined, access_token: "synthetic-access-HHH" }) });
        await assert.rejects(completeBufferConnect({ state: hState, code: "synthetic-code-HHH" }, { fetchImpl: shape.fetchImpl }), BufferConnectionError);
        const lines = logged.map((l) => JSON.parse(l));
        const rejectedLine = lines.find((l) => l.event === "buffer_connect_failed" && l.step === "token_request_rejected");
        assert.ok(rejectedLine, "the rejected token request is logged with its step");
        assert.deepEqual([rejectedLine.level, rejectedLine.httpStatus, rejectedLine.bufferError], ["warn", 401, "invalid_client"]);
        const shapeLine = lines.find((l) => l.event === "buffer_connect_failed" && l.step === "token_response_unusable");
        assert.deepEqual(shapeLine.missingFields, ["refresh_token"], "names the missing field, not its value");
        const everything = logged.join("\n");
        for (const secret of [gState, hState, "synthetic-code-GGG", "synthetic-code-HHH", "synthetic-access-HHH", "SUPERSECRET", "synthetic-refresh"]) {
          assert.ok(!everything.includes(secret), `the log never contains ${secret.slice(0, 12)}...`);
        }
      } finally {
        console.error = realError;
      }

      // No organization fails without storing anything.
      const e = await seedOwner(client, "buffer-e");
      const eState = authorizeParams(await startBufferConnect(e.owner)).get("state")!;
      const noOrg = bufferFetch({ api: () => json({ data: { account: { organizations: [] } } }) });
      await assert.rejects(
        completeBufferConnect({ state: eState, code: "synthetic-code" }, { fetchImpl: noOrg.fetchImpl }),
        (error: unknown) => error instanceof BufferConnectionError && error.code === "no_organization"
      );
      assert.equal(await connectionCount(client, e.owner), 0);

      // --- callback outcomes --------------------------------------------
      const callback = require("../app/api/buffer/callback/route").GET;

      const denied = await callback(callbackRequest({ error: "access_denied", state: "whatever" }));
      assert.equal(denied.status, 302);
      assert.equal(denied.headers.get("location"), "http://localhost/connections?buffer=denied");

      const f = await seedOwner(client, "buffer-f");
      const fState = authorizeParams(await startBufferConnect(f.owner)).get("state")!;
      const failedToken = bufferFetch({
        token: () => json({ error: "invalid_grant", error_description: "synthetic-provider-error-text" }, 400)
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = failedToken.fetchImpl;
      try {
        const failed = await callback(callbackRequest({ state: fState, code: "synthetic-code" }, await signIn(f.owner)));
        assert.equal(failed.status, 302);
        assert.equal(failed.headers.get("location"), "http://localhost/connections?buffer=failed");
        assert.equal(await failed.text(), "");
        assert.equal(await connectionCount(client, f.owner), 0, "a failed exchange stores nothing");
        const location = failed.headers.get("location") ?? "";
        for (const secret of ["synthetic-code", fState, "synthetic-provider-error-text", "synthetic-access", "synthetic-refresh"]) {
          assert.ok(!location.includes(secret), "the redirect never carries a secret");
        }
      } finally {
        globalThis.fetch = originalFetch;
      }

      // --- the callback is bound to the browser's session (login CSRF) ---
      // An attacker starts a connect on their own account and sends the Buffer link to a
      // victim. The victim's browser (no session, or a different owner) must not complete it.
      const attacker = await seedOwner(client, "buffer-attacker");
      const victim = await seedOwner(client, "buffer-victim");
      const attackerToken = await signIn(attacker.owner);
      const victimToken = await signIn(victim.owner);
      const attackState = authorizeParams(await startBufferConnect(attacker.owner)).get("state")!;
      const attackFetch = bufferFetch();
      globalThis.fetch = attackFetch.fetchImpl;
      try {
        const anonymous = await callback(callbackRequest({ state: attackState, code: "synthetic-code" }));
        assert.equal(anonymous.headers.get("location"), "http://localhost/connections?buffer=failed", "no session is refused");
        const asVictim = await callback(callbackRequest({ state: attackState, code: "synthetic-code" }, victimToken));
        assert.equal(asVictim.headers.get("location"), "http://localhost/connections?buffer=expired", "another owner's session is refused");
        assert.equal(attackFetch.calls.length, 0, "Buffer is never contacted for a refused completion");
        assert.equal(await connectionCount(client, attacker.owner), 0);
        assert.equal(await connectionCount(client, victim.owner), 0, "nothing is stored for either owner");

        // The refused attempts did not burn the state: the owner who started the flow can still finish it.
        const asOwner = await callback(callbackRequest({ state: attackState, code: "synthetic-code" }, attackerToken));
        assert.equal(asOwner.headers.get("location"), "http://localhost/connections?buffer=connected");
        assert.equal(await connectionCount(client, attacker.owner), 1);
        assert.equal(await connectionCount(client, victim.owner), 0);
        const replay = await callback(callbackRequest({ state: attackState, code: "synthetic-code" }, attackerToken));
        assert.equal(replay.headers.get("location"), "http://localhost/connections?buffer=expired", "the state is single use");
      } finally {
        globalThis.fetch = originalFetch;
      }

      // --- reconnecting a different Buffer account drops stale channel selections ---
      const moved = await seedOwner(client, "buffer-moved");
      await seedConnection(client, moved.owner);
      const connectionId = (await client.query("SELECT id FROM buffer_connections WHERE owner_id=$1", [moved.owner])).rows[0].id;
      const keepSelection = () => client.query(
        `INSERT INTO business_buffer_channels(business_id,connection_id,channel_id,channel_name,service)
         VALUES($1,$2,'channel-old','Old channel','instagram')
         ON CONFLICT(business_id) DO NOTHING`,
        [moved.businessId, connectionId]
      );
      const selections = async () => Number((await client.query("SELECT count(*) FROM business_buffer_channels WHERE business_id=$1", [moved.businessId])).rows[0].count);
      await keepSelection();
      const sameOrg = bufferFetch();
      await completeBufferConnect({ state: authorizeParams(await startBufferConnect(moved.owner)).get("state")!, code: "synthetic-code" }, { fetchImpl: sameOrg.fetchImpl });
      assert.equal(await selections(), 1, "reconnecting the same organization keeps the selection");
      const otherOrg = bufferFetch({ api: (call) => call.body.includes("organizations") ? json({ data: { account: { organizations: [{ id: "org-2", name: "Another Org" }] } } }) : channelsResponse([]) });
      await completeBufferConnect({ state: authorizeParams(await startBufferConnect(moved.owner)).get("state")!, code: "synthetic-code" }, { fetchImpl: otherOrg.fetchImpl });
      assert.equal(await selections(), 0, "reconnecting a different organization clears the selection");

      delete process.env.BUFFER_CLIENT_ID;
      const notConfigured = await callback(callbackRequest({ state: "anything", code: "anything" }, await signIn(f.owner)));
      assert.equal(notConfigured.status, 302);
      assert.equal(notConfigured.headers.get("location"), "http://localhost/connections?buffer=not_configured");
      process.env.BUFFER_CLIENT_ID = "synthetic-client-id";

      // --- refresh: single use, serialized, needs_reconnect --------------
      const g = await seedOwner(client, "buffer-g");
      await seedConnection(client, g.owner, { accessToken: "old-access", refreshToken: "old-refresh", expiresInMs: 30_000 });
      let refreshCalls = 0;
      const refresh = bufferFetch({
        token: (call) => {
          refreshCalls += 1;
          assert.match(call.body, /grant_type=refresh_token/);
          const body = new URLSearchParams(call.body);
          assert.equal(body.get("refresh_token"), "old-refresh");
          assert.equal(body.get("client_secret"), "synthetic-client-secret");
          return tokenResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
        }
      });
      assert.equal(await getBufferAccessToken(g.owner, { fetchImpl: refresh.fetchImpl }), "new-access");
      assert.equal(refreshCalls, 1);
      const refreshed = (await client.query(
        "SELECT encrypted_access_token, encrypted_refresh_token FROM buffer_connections WHERE owner_id=$1",
        [g.owner]
      )).rows[0];
      assert.equal(decryptCredential(refreshed.encrypted_access_token, `buffer:access:${g.owner}`), "new-access");
      assert.equal(decryptCredential(refreshed.encrypted_refresh_token, `buffer:refresh:${g.owner}`), "new-refresh");

      // Two concurrent calls on an expired token send exactly one refresh.
      const h = await seedOwner(client, "buffer-h");
      await seedConnection(client, h.owner, { accessToken: "concurrent-old", refreshToken: "concurrent-refresh-old", expiresInMs: 0 });
      let concurrentRefreshes = 0;
      const concurrent = bufferFetch({
        token: async () => {
          concurrentRefreshes += 1;
          await new Promise((resolve) => setTimeout(resolve, 25));
          return tokenResponse({ access_token: "concurrent-new", refresh_token: "concurrent-refresh-new" });
        }
      });
      const tokens = await Promise.all([
        getBufferAccessToken(h.owner, { fetchImpl: concurrent.fetchImpl }),
        getBufferAccessToken(h.owner, { fetchImpl: concurrent.fetchImpl })
      ]);
      assert.deepEqual(tokens, ["concurrent-new", "concurrent-new"]);
      assert.equal(concurrentRefreshes, 1, "concurrent refreshes are serialized by the row lock");

      // invalid_grant and a lost response both mark needs_reconnect.
      const i = await seedOwner(client, "buffer-i");
      await seedConnection(client, i.owner, { expiresInMs: 0 });
      const invalid = bufferFetch({ token: () => json({ error: "invalid_grant", error_description: "synthetic-provider-error-text" }, 400) });
      await assert.rejects(
        getBufferAccessToken(i.owner, { fetchImpl: invalid.fetchImpl }),
        (error: unknown) => error instanceof BufferConnectionError && error.code === "needs_reconnect"
      );
      assert.equal(await connectionStatus(client, i.owner), "needs_reconnect");

      const j = await seedOwner(client, "buffer-j");
      await seedConnection(client, j.owner, { expiresInMs: 0 });
      const lost = fakeFetch(() => { throw new Error("synthetic network failure"); });
      await assert.rejects(
        getBufferAccessToken(j.owner, { fetchImpl: lost.fetchImpl }),
        (error: unknown) => error instanceof BufferConnectionError && error.code === "needs_reconnect"
      );
      assert.equal(await connectionStatus(client, j.owner), "needs_reconnect");
      assert.equal(lost.calls.length, 1, "the old refresh token is never retried");

      const k = await seedOwner(client, "buffer-k");
      await seedConnection(client, k.owner, { expiresInMs: 0, status: "needs_reconnect" });
      const noRetry = bufferFetch();
      await assert.rejects(
        getBufferAccessToken(k.owner, { fetchImpl: noRetry.fetchImpl }),
        (error: unknown) => error instanceof BufferConnectionError && error.code === "needs_reconnect"
      );
      assert.equal(noRetry.calls.length, 0, "a needs_reconnect connection never refreshes again");

      // --- channel listing and selection --------------------------------
      const l = await seedOwner(client, "buffer-l");
      await seedConnection(client, l.owner);
      const channels = [
        { id: "ig-1", name: "Instagram handle", displayName: "Instagram Business", service: "instagram", type: "business", isDisconnected: false, isLocked: false },
        { id: "fb-1", name: "Facebook page", displayName: null, service: "facebook", type: "page", isDisconnected: false, isLocked: false },
        { id: "tw-1", name: "Twitter", displayName: "Twitter", service: "twitter", type: "profile", isDisconnected: false, isLocked: false },
        { id: "ig-2", name: "Disconnected", displayName: "Disconnected", service: "instagram", type: "business", isDisconnected: true, isLocked: false },
        { id: "fb-2", name: "Locked", displayName: "Locked", service: "facebook", type: "page", isDisconnected: false, isLocked: true }
      ];
      const listing = bufferFetch({ api: () => channelsResponse(channels) });
      assert.deepEqual(await listBufferChannels(l.owner, { fetchImpl: listing.fetchImpl }), [
        { id: "ig-1", name: "Instagram Business", service: "instagram", type: "business" },
        { id: "fb-1", name: "Facebook page", service: "facebook", type: "page" }
      ]);

      const unauthorized = bufferFetch({ api: () => json({ errors: [{ message: "unauthorized" }] }, 401) });
      await assert.rejects(
        listBufferChannels(l.owner, { fetchImpl: unauthorized.fetchImpl }),
        (error: unknown) => error instanceof BufferConnectionError && error.code === "needs_reconnect"
      );
      assert.equal(await connectionStatus(client, l.owner), "needs_reconnect");

      const m = await seedOwner(client, "buffer-m");
      await seedConnection(client, m.owner);
      const selectable = bufferFetch({ api: () => channelsResponse(channels) });
      await assert.rejects(
        selectBufferChannel(m.owner, m.businessId, "not-a-channel", { fetchImpl: selectable.fetchImpl }),
        (error: unknown) => error instanceof BufferConnectionError && error.code === "invalid_channel"
      );
      assert.equal(
        Number((await client.query("SELECT count(*) FROM business_buffer_channels WHERE business_id=$1", [m.businessId])).rows[0].count),
        0
      );

      const selected = await selectBufferChannel(m.owner, m.businessId, "ig-1", { fetchImpl: selectable.fetchImpl });
      assert.deepEqual(selected, { id: "ig-1", name: "Instagram Business", service: "instagram", type: "business" });
      // The posting worker refuses a personal Instagram channel by the type saved here (#29 part 3).
      assert.equal((await client.query("SELECT channel_type FROM business_buffer_channels WHERE business_id=$1", [m.businessId])).rows[0].channel_type, "business");
      assert.deepEqual(await getSelectedBufferChannel(m.owner, m.businessId), {
        id: "ig-1",
        name: "Instagram Business",
        service: "instagram"
      });

      const foreignBusiness = await seedOwner(client, "buffer-n");
      await assert.rejects(
        selectBufferChannel(m.owner, foreignBusiness.businessId, "ig-1", { fetchImpl: selectable.fetchImpl }),
        (error: unknown) => error instanceof BufferConnectionError && error.code === "not_found"
      );
      assert.equal(
        Number((await client.query("SELECT count(*) FROM business_buffer_channels WHERE business_id=$1", [foreignBusiness.businessId])).rows[0].count),
        0,
        "another owner's business writes nothing"
      );

      // The owner reconnects a different Buffer account while the channel list is in flight:
      // the selection must not be saved against the new connection (review finding on #196).
      const racer = await seedOwner(client, "buffer-race");
      await seedConnection(client, racer.owner);
      const reconnectsMidFlight = bufferFetch({
        api: async () => {
          await client.query("UPDATE buffer_connections SET organization_id='org-2' WHERE owner_id=$1", [racer.owner]);
          return channelsResponse(channels);
        }
      });
      await assert.rejects(
        selectBufferChannel(racer.owner, racer.businessId, "ig-1", { fetchImpl: reconnectsMidFlight.fetchImpl }),
        (error: unknown) => error instanceof BufferConnectionError && error.code === "connection_changed" && error.status === 409
      );
      assert.equal(
        Number((await client.query("SELECT count(*) FROM business_buffer_channels WHERE business_id=$1", [racer.businessId])).rows[0].count),
        0,
        "a channel fetched for the old organization is never saved"
      );

      // Reconnect takes the connection lock BEFORE clearing selections (review finding on #196): a
      // channel selection that is mid-save holds that lock, and the reconnect must wait for it and then
      // remove the committed row, not race past it and leave an old-organization channel attached.
      const locked = await seedOwner(client, "buffer-lock");
      await seedConnection(client, locked.owner);
      const lockedConnectionId = (await client.query("SELECT id FROM buffer_connections WHERE owner_id=$1", [locked.owner])).rows[0].id;
      const lockedState = authorizeParams(await startBufferConnect(locked.owner)).get("state")!;
      await client.query("BEGIN");
      await client.query("SELECT id FROM buffer_connections WHERE owner_id=$1 FOR UPDATE", [locked.owner]);
      await client.query(
        `INSERT INTO business_buffer_channels(business_id,connection_id,channel_id,channel_name,service)
         VALUES($1,$2,'channel-mid-save','Mid-save channel','instagram')`,
        [locked.businessId, lockedConnectionId]
      );
      let reconnectDone = false;
      const reconnecting = completeBufferConnect(
        { state: lockedState, code: "synthetic-code" },
        { fetchImpl: otherOrg.fetchImpl }
      ).then(() => { reconnectDone = true; });
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(reconnectDone, false, "the reconnect waits for the selection's lock");
      await client.query("COMMIT");
      await reconnecting;
      assert.equal(
        Number((await client.query("SELECT count(*) FROM business_buffer_channels WHERE business_id=$1", [locked.businessId])).rows[0].count),
        0,
        "the selection saved just before the reconnect is removed, not left on the new organization"
      );

      // A 401 for an OLD token must not disable a connection the owner has since re-authorized
      // (review finding on #196): the owner reconnects while the channel list is in flight.
      const stale = await seedOwner(client, "buffer-stale");
      await seedConnection(client, stale.owner);
      const reconnectsThenRejects = bufferFetch({
        api: async () => {
          await seedConnection(client, stale.owner, { accessToken: "reconnected-access", refreshToken: "reconnected-refresh" });
          return json({ errors: [{ message: "unauthorized" }] }, 401);
        }
      });
      await assert.rejects(
        listBufferChannels(stale.owner, { fetchImpl: reconnectsThenRejects.fetchImpl }),
        (error: unknown) => error instanceof BufferConnectionError && error.code === "connection_changed" && error.status === 409
      );
      assert.equal(await connectionStatus(client, stale.owner), "active", "a stale 401 leaves the new connection active");
      assert.equal(await getBufferAccessToken(stale.owner), "reconnected-access", "and the new token is still the stored one");

      // Connection summary: no connection, active with channels, and a failed list.
      assert.deepEqual(await getBufferConnection(foreignBusiness.owner), { connected: false, status: null, channels: [] });
      assert.deepEqual(await getBufferConnection(m.owner, { fetchImpl: selectable.fetchImpl }), {
        connected: true,
        status: "active",
        channels: [
          { id: "ig-1", name: "Instagram Business", service: "instagram", type: "business" },
          { id: "fb-1", name: "Facebook page", service: "facebook", type: "page" }
        ]
      });
      const failingList = bufferFetch({ api: () => json({ errors: [{ message: "unauthorized" }] }, 401) });
      assert.deepEqual(await getBufferConnection(m.owner, { fetchImpl: failingList.fetchImpl }), {
        connected: true,
        status: "needs_reconnect",
        channels: []
      });

      // Disconnect removes the connection and its channel selections.
      assert.equal(await disconnectBuffer(m.owner), true);
      assert.equal(await connectionCount(client, m.owner), 0);
      assert.equal(
        Number((await client.query("SELECT count(*) FROM business_buffer_channels WHERE business_id=$1", [m.businessId])).rows[0].count),
        0
      );
      assert.equal(await clearBufferChannel(m.owner, m.businessId), false);
    });

    // No log line captured during the test may contain a credential, code, state
    // or provider error text.
    const captured = logLines.join("\n");
    for (const secret of [
      "synthetic-access",
      "synthetic-refresh",
      "new-access",
      "new-refresh",
      "concurrent-new",
      "synthetic-code",
      "synthetic-provider-error-text",
      "synthetic-client-secret"
    ]) {
      assert.ok(!captured.includes(secret), `logs must not contain ${secret}`);
    }
  } finally {
    for (const level of levels) console[level] = original[level];
  }

  console.log("buffer connect, refresh, channel and callback tests passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
