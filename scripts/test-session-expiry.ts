import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { databaseFixture } from "./db-fixture";
import { authAdapter, sessionHash } from "../lib/auth-adapter";
import { createMobileSession } from "../lib/mobileSessions";
import type { AdapterUser } from "next-auth/adapters";
import {
  SESSION_ENDED_MESSAGE, createApiFetch, isProtectedApiPath, isSessionExpiry, landingNotice, safeCallbackUrl, signInLocation
} from "../lib/sessionExpiry";

type Harness = { events: string[]; apiFetch: ReturnType<typeof createApiFetch> };
// Builds the wrapper around a fake fetch that answers `status` (or a handler), recording the order of side effects.
function harness(answer: number | ((url: string) => Response | Promise<Response>), page = { pathname: "/approval", search: "" }, signOut?: () => Promise<unknown>): Harness {
  const events: string[] = [];
  const apiFetch = createApiFetch({
    fetchImpl: async url => typeof answer === "number" ? new Response("{}", { status: answer }) : answer(url),
    signOut: signOut ?? (async () => { events.push("signOut"); }),
    location: () => page,
    navigate: to => events.push(`navigate ${to}`),
    signOutTimeoutMs: 50
  });
  return { events, apiFetch };
}
const settled = (promise: Promise<unknown>) => Promise.race([promise.then(() => true, () => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))]);

async function pure() {
  // Which responses end the session.
  for (const status of [403, 404, 409, 429, 400, 500, 502, 503, 200]) {
    assert.equal(isSessionExpiry({ status, url: "/api/drafts?businessId=1", pathname: "/approval" }), false, `status ${status} must not log out`);
  }
  assert.equal(isSessionExpiry({ status: 401, url: "/api/drafts?businessId=1", pathname: "/approval" }), true);
  assert.equal(isSessionExpiry({ status: 401, url: "/api/reviews/import", pathname: "/reviews" }), true);
  // Loop guards: landing page, NextAuth endpoints, the phone app's routes, foreign URLs.
  assert.equal(isSessionExpiry({ status: 401, url: "/api/businesses", pathname: "/" }), false);
  // The public plans page also loads business state; a signed-out visitor must stay there.
  assert.equal(isSessionExpiry({ status: 401, url: "/api/businesses", pathname: "/plans" }), false);
  // The development email outbox is read while signed out, so its shell reload must not redirect.
  assert.equal(isSessionExpiry({ status: 401, url: "/api/businesses", pathname: "/dev/outbox" }), false);
  for (const url of ["/api/auth/session", "/api/auth/csrf", "/api/auth/signout", "/api/auth", "/api/mobile/config", "/api/mobile/session", "https://example.invalid/api/drafts", "//example.invalid/api/drafts", "/other"]) {
    assert.equal(isProtectedApiPath(url), false, url);
    assert.equal(isSessionExpiry({ status: 401, url, pathname: "/approval" }), false, url);
  }
  assert.equal(isProtectedApiPath("/api/drafts?next=/api/auth/x"), true);

  // callbackUrl building and open-redirect protection.
  assert.equal(signInLocation("/approval"), "/?reason=session-ended&callbackUrl=%2Fapproval");
  assert.equal(signInLocation("/reviews", "?businessId=7"), "/?reason=session-ended&callbackUrl=%2Freviews%3FbusinessId%3D7");
  assert.equal(signInLocation("/"), "/?reason=session-ended&callbackUrl=%2Fapproval", "the landing page is never a return target");
  for (const bad of ["https://evil.example/x", "//evil.example/x", "/\\evil.example", "javascript:alert(1)", "/a\nb", "", null, undefined, "/api/auth/signout", "/?x=1"]) {
    assert.equal(safeCallbackUrl(bad), "/approval", String(bad));
  }
  assert.equal(safeCallbackUrl("/schedule?businessId=3#top"), "/schedule?businessId=3#top");
  assert.deepEqual(landingNotice("?reason=session-ended&callbackUrl=%2Freviews%3FbusinessId%3D7"), { message: SESSION_ENDED_MESSAGE, callbackUrl: "/reviews?businessId=7" });
  assert.deepEqual(landingNotice("?callbackUrl=https%3A%2F%2Fevil.example"), { message: null, callbackUrl: null });
  assert.deepEqual(landingNotice(""), { message: null, callbackUrl: null });
  assert.equal(SESSION_ENDED_MESSAGE, "Your session ended. Sign in again.");
}

async function wrapper() {
  // A 401: sign out first (cookie cleared), then navigate to sign-in with the way back; the call never resolves.
  {
    const { events, apiFetch } = harness(401, { pathname: "/reviews", search: "?businessId=7" });
    assert.equal(await settled(apiFetch("/api/reviews/import", { method: "POST" })), false, "the stopped action must not continue");
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(events, ["signOut", "navigate /?reason=session-ended&callbackUrl=%2Freviews%3FbusinessId%3D7"]);
  }
  // Other statuses come back untouched and never sign the owner out.
  for (const status of [200, 403, 404, 409, 429, 500, 503]) {
    const { events, apiFetch } = harness(status);
    assert.equal((await apiFetch("/api/drafts/status", { method: "POST" })).status, status);
    assert.deepEqual(events, [], `status ${status}`);
  }
  // Loop guards: the landing page and the auth endpoints get their 401 back.
  for (const [url, pathname] of [["/api/businesses", "/"], ["/api/auth/session", "/approval"]]) {
    const { events, apiFetch } = harness(401, { pathname, search: "" });
    assert.equal((await apiFetch(url)).status, 401);
    assert.deepEqual(events, []);
  }
  // Several polls failing together sign out and navigate once.
  {
    const { events, apiFetch } = harness(401);
    void apiFetch("/api/drafts?businessId=1"); void apiFetch("/api/drafts?businessId=1"); void apiFetch("/api/businesses");
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(events, ["signOut", "navigate /?reason=session-ended&callbackUrl=%2Fapproval"]);
  }
  // A failing or hanging signOut must not strand the owner on the dead page.
  for (const signOut of [async () => { throw new Error("offline"); }, () => new Promise<void>(() => {})]) {
    const { events, apiFetch } = harness(401, { pathname: "/schedule", search: "" }, signOut);
    void apiFetch("/api/posting-slots?businessId=1");
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.deepEqual(events, ["navigate /?reason=session-ended&callbackUrl=%2Fschedule"]);
  }
  // A network failure is the caller's to handle, not a sign-out.
  {
    const { events, apiFetch } = harness(() => { throw new TypeError("Failed to fetch"); });
    await assert.rejects(apiFetch("/api/drafts?businessId=1"), TypeError);
    assert.deepEqual(events, []);
  }
}

// The real owner routes behind the approval and import pages: an expired cookie session
// and a revoked mobile token both answer 401, and the wrapper turns that into a sign-out.
async function realRoutes() {
  process.env.NEXTAUTH_URL = "http://localhost";
  await databaseFixture(async client => {
    const create = authAdapter.createUser as (u: Omit<AdapterUser, "id">) => Promise<AdapterUser>;
    const owner = await create({ name: "Synthetic expiry", email: "expiry@example.invalid", emailVerified: null });
    await authAdapter.createSession!({ userId: owner.id, sessionToken: "live-session", expires: new Date(Date.now() + 3600000) });
    await authAdapter.createSession!({ userId: owner.id, sessionToken: "expired-session", expires: new Date(Date.now() + 3600000) });
    const business = (await client.query("INSERT INTO businesses(name,timezone,owner_id) VALUES('Synthetic expiry','UTC',$1) RETURNING id", [owner.id])).rows[0].id;

    const drafts = require("../app/api/drafts/route");
    const importer = require("../app/api/reviews/import/route");
    const revoke = require("../app/api/mobile/session/revoke/route").POST;
    const handlers: Record<string, (request: NextRequest) => Promise<Response>> = {
      "GET /api/drafts": drafts.GET, "POST /api/reviews/import": importer.POST
    };
    const cookieFetch = (token: string) => async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const handler = handlers[`${method} ${url.split("?")[0]}`];
      return handler(new NextRequest(`http://localhost${url}`, { method, headers: { cookie: `next-auth.session-token=${token}`, origin: "http://localhost" } }));
    };
    const attempt = async (token: string, url: string, method = "GET") => {
      const events: string[] = [];
      const apiFetch = createApiFetch({
        fetchImpl: cookieFetch(token), signOut: async () => { events.push("signOut"); },
        location: () => ({ pathname: method === "GET" ? "/approval" : "/reviews", search: "" }), navigate: to => events.push(`navigate ${to}`), signOutTimeoutMs: 50
      });
      const outcome = await Promise.race([apiFetch(url, { method }).then(r => r.status), new Promise<string>(resolve => setTimeout(() => resolve("pending"), 150))]);
      await new Promise(resolve => setTimeout(resolve, 20));
      return { outcome, events };
    };

    // Live session: approval and import calls go through untouched (400/200 are the route's own answers).
    const live = await attempt("live-session", `/api/drafts?businessId=${business}`);
    assert.deepEqual([live.outcome, live.events], [200, []]);
    const liveImport = await attempt("live-session", "/api/reviews/import", "POST");
    assert.notEqual(liveImport.outcome, "pending");
    assert.notEqual(liveImport.outcome, 401);
    assert.deepEqual(liveImport.events, []);

    // Expire one cookie session in the database, as eight hours passing would.
    await client.query("UPDATE auth_sessions SET expires=now()-interval '1 second' WHERE token_hash=$1", [sessionHash("expired-session")]);
    const approval = await attempt("expired-session", `/api/drafts?businessId=${business}`);
    assert.equal(approval.outcome, "pending", "an expired session stops the approval page's action");
    assert.deepEqual(approval.events, ["signOut", "navigate /?reason=session-ended&callbackUrl=%2Fapproval"]);
    const importing = await attempt("expired-session", "/api/reviews/import", "POST");
    assert.equal(importing.outcome, "pending", "an expired session stops the import");
    assert.deepEqual(importing.events, ["signOut", "navigate /?reason=session-ended&callbackUrl=%2Freviews"]);
    assert.equal((await attempt("live-session", `/api/drafts?businessId=${business}`)).outcome, 200, "other sessions are unaffected");

    // A revoked mobile token gets the same 401 from the same routes (the phone app maps it to signedOut).
    const mobile = await createMobileSession(owner.id);
    const bearer = (path: string, method: string) => new NextRequest(`http://localhost${path}`, { method, headers: { authorization: `Bearer ${mobile.token}` } });
    assert.equal((await drafts.GET(bearer(`/api/drafts?businessId=${business}`, "GET"))).status, 200);
    assert.equal((await revoke(bearer("/api/mobile/session/revoke", "POST"))).status, 200);
    assert.equal((await drafts.GET(bearer(`/api/drafts?businessId=${business}`, "GET"))).status, 401);
    assert.equal((await importer.POST(bearer("/api/reviews/import", "POST"))).status, 401);
  });
}

async function main() {
  await pure();
  await wrapper();
  await realRoutes();
  console.log("session expiry decision logic, fetch wrapper and expired/revoked session route tests passed");
}
main().catch(err => { console.error(err); process.exitCode = 1; });
