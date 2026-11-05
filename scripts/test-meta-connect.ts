import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { NextRequest } from "next/server";
import { databaseFixture } from "./db-fixture";
import { sessionHash } from "../lib/auth-adapter";
import { setOwnerPlan } from "../lib/services/entitlements";
import {
  MetaConnectionError,
  clearMetaTarget,
  completeMetaConnect,
  disconnectMeta,
  getMetaConnection,
  getMetaPageCredentials,
  getSelectedMetaTarget,
  markMetaPageNeedsReconnect,
  metaConfigured,
  selectMetaTarget,
  startMetaConnect
} from "../lib/services/metaConnection";
import { metaAuthorizeUrl, metaGraphClient, metaGraphConfig } from "../lib/integrations/metaGraph";

const KEY = Buffer.alloc(32, 7).toString("base64");
const ENV = {
  META_APP_ID: "meta-app-synthetic",
  META_APP_SECRET: "meta-secret-synthetic",
  META_REDIRECT_URI: "https://praise.example.invalid/api/meta/callback",
  META_GRAPH_VERSION: "v27.0",
  CREDENTIAL_ENCRYPTION_KEY: KEY,
  NEXTAUTH_URL: "http://localhost"
};

type Call = { path: string };

const PAGE_ONE = {
  id: "page-1",
  name: "Synthetic Page One",
  access_token: "page-token-one",
  instagram_business_account: { id: "ig-1" },
  tasks: ["CREATE_CONTENT", "MANAGE"]
};
const PAGE_TWO = {
  id: "page-2",
  name: "Synthetic Page Two",
  access_token: "page-token-two",
  tasks: ["PROFILE_PLUS_CREATE_CONTENT"]
};
const PAGE_NO_CREATE = {
  id: "page-3",
  name: "Synthetic Read Only",
  access_token: "page-token-three",
  tasks: ["ANALYZE"]
};

function accounts(pages: unknown[], next?: string) {
  return {
    data: pages,
    ...(next ? { paging: { next } } : {})
  };
}

function fakeFetch(routes: { accounts?: unknown | (() => unknown); codeStatus?: number; longStatus?: number } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    // Record only the path: the token and code exchanges put secrets in the query.
    calls.push({ path: url.pathname });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    if (url.pathname.endsWith("/oauth/access_token")) {
      if (url.searchParams.get("grant_type") === "fb_exchange_token") {
        return routes.longStatus && routes.longStatus !== 200
          ? json({ error: { message: "synthetic", code: 190 } }, routes.longStatus)
          : json({ access_token: "long-user-token", expires_in: 5_183_944 });
      }
      return routes.codeStatus && routes.codeStatus !== 200
        ? json({ error: { message: "synthetic", code: 190 } }, routes.codeStatus)
        : json({ access_token: "short-user-token" });
    }
    if (url.pathname.endsWith("/me/accounts")) {
      const value = typeof routes.accounts === "function" ? routes.accounts() : routes.accounts;
      return json(value ?? accounts([PAGE_ONE, PAGE_TWO, PAGE_NO_CREATE]));
    }
    return json({ error: { message: "unexpected", code: 1 } }, 500);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function cookieRequest(path: string, method: string, body?: unknown, session = "meta-route-session") {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { cookie: `next-auth.session-token=${session}`, origin: "http://localhost", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

function anonymousRequest(path: string, method: string) {
  return new NextRequest(`http://localhost${path}`, { method, headers: { origin: "http://localhost" } });
}

function parseState(authorizeUrl: string): string {
  const state = new URL(authorizeUrl).searchParams.get("state");
  assert.ok(state, "the authorize URL carries a state");
  return state;
}

const saved = Object.fromEntries(Object.keys(ENV).map(key => [key, process.env[key]]));
const savedFetch = globalThis.fetch;

async function main() {
  Object.assign(process.env, ENV);
  try {
    await databaseFixture(async client => {
      await client.query(`INSERT INTO auth_users(id,email) VALUES
        ('meta-owner','meta@example.invalid'),('other-owner','other@example.invalid'),
        ('free-owner','free-meta@example.invalid'),('empty-owner','empty-meta@example.invalid')`);
      await client.query(`INSERT INTO businesses(owner_id,name,timezone) VALUES
        ('meta-owner','Meta Business','UTC'),('other-owner','Other Business','UTC')`);
      const metaBusiness = Number((await client.query("SELECT id FROM businesses WHERE owner_id='meta-owner'")).rows[0].id);
      const otherBusiness = Number((await client.query("SELECT id FROM businesses WHERE owner_id='other-owner'")).rows[0].id);
      await setOwnerPlan("meta-owner", "pro", { reason: "Synthetic plan" });
      await setOwnerPlan("other-owner", "pro", { reason: "Synthetic plan" });
      await setOwnerPlan("empty-owner", "pro", { reason: "Synthetic plan" });

      // Configuration is read at request time and a bad version fails closed.
      assert.equal(metaConfigured({ ...ENV }), true);
      assert.equal(metaConfigured({ ...ENV, CREDENTIAL_ENCRYPTION_KEY: "" }), false);
      assert.equal(metaConfigured({ ...ENV, META_APP_ID: "" }), false);
      assert.equal(metaGraphConfig({ ...ENV, META_GRAPH_VERSION: "v27.0;drop" }), null);
      const config = metaGraphConfig({ ...ENV })!;
      assert.match(metaAuthorizeUrl(config, "state-1"), /^https:\/\/www\.facebook\.com\/v27\.0\/dialog\/oauth\?/);
      const authorize = new URL(metaAuthorizeUrl(config, "state-1"));
      assert.equal(authorize.searchParams.get("client_id"), ENV.META_APP_ID);
      assert.equal(authorize.searchParams.get("redirect_uri"), ENV.META_REDIRECT_URI);
      assert.equal(authorize.searchParams.get("response_type"), "code");
      assert.equal(authorize.searchParams.get("state"), "state-1");
      assert.match(authorize.searchParams.get("scope") ?? "", /instagram_content_publish/);
      assert.match(authorize.searchParams.get("scope") ?? "", /pages_manage_posts/);
      assert.equal(authorize.searchParams.get("config_id"), null);
      const configuredById = metaAuthorizeUrl(metaGraphConfig({ ...ENV, META_CONFIG_ID: "cfg-1" })!, "state-2");
      assert.equal(new URL(configuredById).searchParams.get("config_id"), "cfg-1");
      assert.equal(new URL(configuredById).searchParams.get("scope"), null);

      // Free owners cannot start a connect; nothing is written.
      await assert.rejects(() => startMetaConnect("free-owner"), (error: unknown) =>
        error instanceof MetaConnectionError && error.code === "plan_required"
      );
      assert.equal((await client.query("SELECT count(*)::int n FROM meta_oauth_states WHERE owner_id='free-owner'")).rows[0].n, 0);

      // Missing configuration fails closed.
      delete process.env.META_APP_SECRET;
      await assert.rejects(() => startMetaConnect("meta-owner"), (error: unknown) =>
        error instanceof MetaConnectionError && error.code === "not_configured"
      );
      process.env.META_APP_SECRET = ENV.META_APP_SECRET;

      // Start stores only the state hash, never the state itself.
      const state = parseState(await startMetaConnect("meta-owner"));
      assert.equal(
        (await client.query("SELECT count(*)::int n FROM meta_oauth_states WHERE state_hash=$1", [state])).rows[0].n,
        0,
        "the raw state is not stored"
      );
      assert.equal(
        (await client.query("SELECT count(*)::int n FROM meta_oauth_states WHERE state_hash=$1", [sessionHash(state)])).rows[0].n,
        1
      );

      // Completing the flow stores Pages and encrypted tokens, and discards the User token.
      const successFetch = fakeFetch();
      const completed = await completeMetaConnect({ state, code: "code-1", ownerId: "meta-owner" }, { fetchImpl: successFetch.fetchImpl });
      assert.deepEqual(completed, { ownerId: "meta-owner", outcome: "connected", pages: 3 });
      assert.equal(successFetch.calls.length, 3, "code exchange, long-lived exchange and one account read");
      assert.ok(successFetch.calls.every(call => !call.path.includes(ENV.META_APP_SECRET)), "the app secret is never in a recorded call");
      const connectionRow = (await client.query(
        "SELECT id,status FROM meta_connections WHERE owner_id='meta-owner'"
      )).rows[0];
      assert.equal(connectionRow.status, "active");
      const stored = (await client.query(
        "SELECT page_id,encrypted_page_token,instagram_business_account_id,tasks FROM meta_pages WHERE connection_id=$1 ORDER BY page_id",
        [connectionRow.id]
      )).rows;
      assert.equal(stored.length, 3);
      assert.ok(stored.every((page: { encrypted_page_token: string }) => !page.encrypted_page_token.includes("page-token")));
      assert.equal((await client.query("SELECT count(*)::int n FROM meta_oauth_states WHERE owner_id='meta-owner'")).rows[0].n, 0, "the state is single use");

      const view = await getMetaConnection("meta-owner");
      assert.equal(view.connected, true);
      assert.equal(view.status, "active");
      assert.equal(view.pages.length, 3);
      assert.doesNotMatch(JSON.stringify(view), /page-token|long-user-token|short-user-token|meta-secret/);
      const pageOne = view.pages.find(page => page.pageId === "page-1")!;
      assert.equal(pageOne.instagramBusinessAccountId, "ig-1");
      assert.deepEqual(pageOne.tasks, ["CREATE_CONTENT", "MANAGE"]);
      assert.equal(view.pages.find(page => page.pageId === "page-2")!.instagramBusinessAccountId, null);

      // The decrypted token is available only to the owning owner and the page.
      assert.equal((await getMetaPageCredentials("meta-owner", pageOne.id)).accessToken, "page-token-one");
      await assert.rejects(() => getMetaPageCredentials("other-owner", pageOne.id), (error: unknown) =>
        error instanceof MetaConnectionError && error.code === "not_found"
      );
      // A rotated encryption key cannot decrypt stored tokens; ask for a reconnect
      // rather than returning a broken token or a 500.
      process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
      await assert.rejects(() => getMetaPageCredentials("meta-owner", pageOne.id), (error: unknown) =>
        error instanceof MetaConnectionError && error.code === "needs_reconnect"
      );
      process.env.CREDENTIAL_ENCRYPTION_KEY = KEY;

      // Replaying or changing the owner consumes nothing and is refused.
      await assert.rejects(
        () => completeMetaConnect({ state, code: "code-2", ownerId: "meta-owner" }, { fetchImpl: fakeFetch().fetchImpl }),
        (error: unknown) => error instanceof MetaConnectionError && error.code === "expired"
      );
      const boundState = parseState(await startMetaConnect("meta-owner"));
      await assert.rejects(
        () => completeMetaConnect({ state: boundState, code: "code-3", ownerId: "other-owner" }, { fetchImpl: fakeFetch().fetchImpl }),
        (error: unknown) => error instanceof MetaConnectionError && error.code === "expired"
      );
      assert.equal(
        (await client.query("SELECT count(*)::int n FROM meta_oauth_states WHERE state_hash=$1", [sessionHash(boundState)])).rows[0].n,
        1,
        "a mismatched owner does not consume the state"
      );
      // The rightful owner can still use it.
      assert.equal(
        (await completeMetaConnect({ state: boundState, code: "code-4", ownerId: "meta-owner" }, { fetchImpl: fakeFetch().fetchImpl })).outcome,
        "connected"
      );

      // A provider rejection is a failed outcome, not a stored connection.
      const failedState = parseState(await startMetaConnect("meta-owner"));
      await assert.rejects(
        () => completeMetaConnect({ state: failedState, code: "code-5", ownerId: "meta-owner" }, { fetchImpl: fakeFetch({ codeStatus: 401 }).fetchImpl }),
        (error: unknown) => error instanceof MetaConnectionError && error.code === "failed" && error.status === 502
      );

      // Target selection: owner isolation, Instagram availability, create task.
      const selected = await selectMetaTarget("meta-owner", metaBusiness, pageOne.id, "instagram");
      assert.equal(selected.target, "instagram");
      assert.equal(selected.page.pageId, "page-1");
      assert.deepEqual(await getSelectedMetaTarget("meta-owner", metaBusiness), selected);

      const pageTwo = view.pages.find(page => page.pageId === "page-2")!;
      assert.equal((await selectMetaTarget("meta-owner", metaBusiness, pageTwo.id, "facebook")).target, "facebook");
      await assert.rejects(() => selectMetaTarget("meta-owner", metaBusiness, pageTwo.id, "instagram"), (error: unknown) =>
        error instanceof MetaConnectionError && error.code === "instagram_unavailable"
      );
      const readOnly = view.pages.find(page => page.pageId === "page-3")!;
      await assert.rejects(() => selectMetaTarget("meta-owner", metaBusiness, readOnly.id, "facebook"), (error: unknown) =>
        error instanceof MetaConnectionError && error.code === "page_cannot_publish"
      );
      await assert.rejects(() => selectMetaTarget("meta-owner", otherBusiness, pageOne.id, "facebook"), (error: unknown) =>
        error instanceof MetaConnectionError && error.code === "not_found"
      );
      await assert.rejects(() => selectMetaTarget("other-owner", metaBusiness, pageOne.id, "facebook"), (error: unknown) =>
        error instanceof MetaConnectionError && error.code === "not_found"
      );
      await assert.rejects(() => selectMetaTarget("meta-owner", metaBusiness, pageOne.id, "store" as never), (error: unknown) =>
        error instanceof MetaConnectionError && error.code === "invalid_target"
      );
      assert.equal(await clearMetaTarget("meta-owner", metaBusiness), true);
      assert.equal(await getSelectedMetaTarget("meta-owner", metaBusiness), null);
      await assert.rejects(() => clearMetaTarget("meta-owner", otherBusiness), (error: unknown) =>
        error instanceof MetaConnectionError && error.code === "not_found"
      );

      // A no-pages reconnect leaves a working connection alone.
      let empty = false;
      const mutableFetch = fakeFetch({ accounts: () => empty ? accounts([]) : accounts([PAGE_ONE, PAGE_TWO, PAGE_NO_CREATE]) });
      const emptyState = parseState(await startMetaConnect("empty-owner"));
      assert.equal(
        (await completeMetaConnect({ state: emptyState, code: "empty-1", ownerId: "empty-owner" }, { fetchImpl: mutableFetch.fetchImpl })).pages,
        3
      );
      empty = true;
      const noPagesState = parseState(await startMetaConnect("empty-owner"));
      assert.deepEqual(
        await completeMetaConnect({ state: noPagesState, code: "empty-2", ownerId: "empty-owner" }, { fetchImpl: mutableFetch.fetchImpl }),
        { ownerId: "empty-owner", outcome: "no_pages", pages: 0 }
      );
      assert.equal((await getMetaConnection("empty-owner")).pages.length, 3, "an empty list does not wipe a working connection");

      // Reconnect removes Pages the user no longer manages and cascades their targets.
      const reconnectState = parseState(await startMetaConnect("empty-owner"));
      empty = false;
      await completeMetaConnect({ state: reconnectState, code: "empty-3", ownerId: "empty-owner" }, { fetchImpl: mutableFetch.fetchImpl });
      const emptyPage = (await getMetaConnection("empty-owner")).pages.find(page => page.pageId === "page-1")!;
      const emptyBusiness = Number((await client.query("INSERT INTO businesses(owner_id,name,timezone) VALUES('empty-owner','Empty Business','UTC') RETURNING id")).rows[0].id);
      await selectMetaTarget("empty-owner", emptyBusiness, emptyPage.id, "instagram");
      const shrinkState = parseState(await startMetaConnect("empty-owner"));
      const shrinkFetch = fakeFetch({ accounts: accounts([PAGE_TWO]) });
      await completeMetaConnect({ state: shrinkState, code: "empty-4", ownerId: "empty-owner" }, { fetchImpl: shrinkFetch.fetchImpl });
      assert.deepEqual((await getMetaConnection("empty-owner")).pages.map(page => page.pageId), ["page-2"]);
      assert.equal(await getSelectedMetaTarget("empty-owner", emptyBusiness), null, "the removed Page's target is gone");

      // A changed linked Instagram account drops an existing Instagram target
      // instead of silently publishing to the new account.
      const reAddState = parseState(await startMetaConnect("empty-owner"));
      await completeMetaConnect(
        { state: reAddState, code: "empty-5", ownerId: "empty-owner" },
        { fetchImpl: fakeFetch({ accounts: accounts([PAGE_ONE, PAGE_TWO]) }).fetchImpl }
      );
      const reAddedPage = (await getMetaConnection("empty-owner")).pages.find(page => page.pageId === "page-1")!;
      await selectMetaTarget("empty-owner", emptyBusiness, reAddedPage.id, "instagram");
      const changedState = parseState(await startMetaConnect("empty-owner"));
      const changedPage = { ...PAGE_ONE, instagram_business_account: { id: "ig-2" } };
      await completeMetaConnect(
        { state: changedState, code: "empty-6", ownerId: "empty-owner" },
        { fetchImpl: fakeFetch({ accounts: accounts([changedPage, PAGE_TWO]) }).fetchImpl }
      );
      assert.equal(await getSelectedMetaTarget("empty-owner", emptyBusiness), null, "a changed Instagram account drops the target");

      // A rejected token marks only the matching Page, and a reconnect restores it.
      const pageOneRow = (await client.query("SELECT encrypted_page_token FROM meta_pages WHERE page_id='page-1'")).rows[0];
      assert.equal(await markMetaPageNeedsReconnect("meta-owner", pageOne.id, "v1.wrong"), false);
      assert.equal(await markMetaPageNeedsReconnect("meta-owner", pageOne.id, pageOneRow.encrypted_page_token), true);
      assert.equal((await getMetaConnection("meta-owner")).pages.find(page => page.pageId === "page-1")!.status, "needs_reconnect");
      await assert.rejects(() => getMetaPageCredentials("meta-owner", pageOne.id), (error: unknown) =>
        error instanceof MetaConnectionError && error.code === "needs_reconnect"
      );
      const restoreState = parseState(await startMetaConnect("meta-owner"));
      await completeMetaConnect({ state: restoreState, code: "restore-1", ownerId: "meta-owner" }, { fetchImpl: fakeFetch().fetchImpl });
      assert.equal((await getMetaConnection("meta-owner")).pages.find(page => page.pageId === "page-1")!.status, "active");

      // Disconnect removes the connection, Pages and selections; repeating is a no-op.
      await selectMetaTarget("meta-owner", metaBusiness, pageOne.id, "instagram");
      assert.equal(await disconnectMeta("meta-owner"), true);
      assert.equal(await disconnectMeta("meta-owner"), false);
      assert.equal((await getMetaConnection("meta-owner")).connected, false);
      assert.equal((await client.query("SELECT count(*)::int n FROM meta_pages p JOIN meta_connections c ON c.id=p.connection_id WHERE c.owner_id='meta-owner'")).rows[0].n, 0);

      // Other owner had no connection: selecting its business's target is a 404.
      assert.equal((await getMetaConnection("other-owner")).connected, false);

      // Connect the other owner, then prove a Page from another owner cannot be
      // selected for its business even when the business check passes.
      const otherState = parseState(await startMetaConnect("other-owner"));
      await completeMetaConnect({ state: otherState, code: "other-1", ownerId: "other-owner" }, { fetchImpl: fakeFetch().fetchImpl });
      await assert.rejects(() => selectMetaTarget("other-owner", otherBusiness, pageOne.id, "facebook"), (error: unknown) =>
        error instanceof MetaConnectionError && error.code === "not_found"
      );

      // Deleting a business removes its target; deleting an owner cascades everything.
      const otherPage = (await getMetaConnection("other-owner")).pages.find(page => page.pageId === "page-2")!;
      await selectMetaTarget("other-owner", otherBusiness, otherPage.id, "facebook");
      await client.query("DELETE FROM businesses WHERE id=$1", [otherBusiness]);
      assert.equal((await client.query("SELECT count(*)::int n FROM business_meta_targets WHERE business_id=$1", [otherBusiness])).rows[0].n, 0);
      await client.query("DELETE FROM auth_users WHERE id='other-owner'");
      assert.equal((await client.query("SELECT count(*)::int n FROM meta_connections WHERE owner_id='other-owner'")).rows[0].n, 0);
      assert.equal((await client.query("SELECT count(*)::int n FROM meta_pages p JOIN meta_connections c ON c.id=p.connection_id WHERE c.owner_id='other-owner'")).rows[0].n, 0);

      // Shared account PII is never in the connection view.
      assert.doesNotMatch(JSON.stringify(await getMetaConnection("meta-owner")), /access_token|encrypted_page_token|secret/i);

      // Pagination follows only graph.facebook.com links and collects both pages.
      let pagedCalls = 0;
      const pagingFetch = (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        pagedCalls += 1;
        if (url.searchParams.get("after") === "next-page") {
          return new Response(JSON.stringify(accounts([PAGE_TWO])), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify(accounts([PAGE_ONE], `https://graph.facebook.com/v27.0/me/accounts?after=next-page`)), {
          status: 200, headers: { "content-type": "application/json" }
        });
      }) as unknown as typeof fetch;
      const accountsList = await metaGraphClient({ config: metaGraphConfig({ ...ENV })!, fetchImpl: pagingFetch }).listAccounts("user-token");
      assert.deepEqual(accountsList.map(page => page.pageId), ["page-1", "page-2"]);
      assert.equal(pagedCalls, 2);

      // A paging link to another host is ignored rather than fetched.
      let foreignFetched = false;
      const foreignFetch = (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.hostname !== "graph.facebook.com") { foreignFetched = true; return new Response("{}"); }
        return new Response(JSON.stringify(accounts([PAGE_ONE], "https://evil.example.invalid/steal?access_token=leak")), {
          status: 200, headers: { "content-type": "application/json" }
        });
      }) as unknown as typeof fetch;
      const safeAccounts = await metaGraphClient({ config: metaGraphConfig({ ...ENV })!, fetchImpl: foreignFetch }).listAccounts("user-token");
      assert.deepEqual(safeAccounts.map(page => page.pageId), ["page-1"]);
      assert.equal(foreignFetched, false);

      // Routes: anonymous requests are refused, and a session connect returns a URL.
      await client.query("INSERT INTO auth_sessions(token_hash,owner_id,expires) VALUES($1,'meta-owner',now()+interval '1 hour')", [sessionHash("meta-route-session")]);
      const connectRoute = require("../app/api/meta/connect/route");
      assert.equal((await connectRoute.POST(anonymousRequest("/api/meta/connect", "POST"))).status, 401);
      const connectionRoute = require("../app/api/meta/connection/route");
      assert.equal((await connectionRoute.GET(anonymousRequest("/api/meta/connection", "GET"))).status, 401);
      const targetRoute = require("../app/api/businesses/[id]/meta-target/route");
      assert.equal((await targetRoute.GET(anonymousRequest(`/api/businesses/${metaBusiness}/meta-target`, "GET"), { params: Promise.resolve({ id: String(metaBusiness) }) })).status, 401);
      const startedRoute = await connectRoute.POST(cookieRequest("/api/meta/connect", "POST"));
      assert.equal(startedRoute.status, 200);
      assert.match((await startedRoute.json()).url, /facebook\.com\/v27\.0\/dialog\/oauth/);

      // Callback: no session is a failed redirect; a real callback connects.
      const callbackRoute = require("../app/api/meta/callback/route");
      const noSession = await callbackRoute.GET(new NextRequest("http://localhost/api/meta/callback?state=x&code=y"));
      assert.equal(noSession.status, 302);
      assert.match(noSession.headers.get("location") ?? "", /meta=failed/);
      const callbackState = parseState(await startMetaConnect("meta-owner"));
      globalThis.fetch = fakeFetch().fetchImpl;
      const callback = await callbackRoute.GET(new NextRequest(`http://localhost/api/meta/callback?state=${encodeURIComponent(callbackState)}&code=callback-code`, {
        headers: { cookie: "next-auth.session-token=meta-route-session" }
      }));
      assert.equal(callback.status, 302);
      assert.match(callback.headers.get("location") ?? "", /connections\?meta=connected/);
      assert.equal((await getMetaConnection("meta-owner")).connected, true);

      // The webhook-style allow-list entry keeps the callback public but session-checked.
      const authorizationTest = require("node:fs").readFileSync(require("node:path").join(__dirname, "test-authorization.ts"), "utf8") as string;
      assert.match(authorizationTest, /app\/api\/meta\/callback\/route\.ts/);
    });
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  console.log("Meta connect, encrypted Page tokens, target selection and routes passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
