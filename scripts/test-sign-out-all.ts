import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { databaseFixture } from "./db-fixture";
import { authAdapter, sessionHash } from "../lib/auth-adapter";
import { clearEmailOutbox, emailOutbox } from "../lib/email";
import { resetEmailCodeThrottle } from "../lib/emailAuth";
import { createMobileSession, resolveMobileSession } from "../lib/mobileSessions";
import { createWebSession } from "../lib/webSessions";

// Sign out of all other devices (#285). Every web and phone session shares
// auth_sessions, so a cookie or bearer caller must remove exactly the other rows
// of its own owner, keep the one that asked, and require a fresh step-up first.
const ORIGIN = "http://localhost:3000";
const PATH = "/api/account/sessions";
const STEP_REQUEST = "/api/account/step-up/request";
const STEP_VERIFY = "/api/account/step-up/verify";

type Call = { cookie?: string; bearer?: string; body?: object; origin?: string | null };

function call(path: string, method: "POST" | "DELETE", options: Call = {}) {
  const headers: Record<string, string> = {
    "cf-connecting-ip": "203.0.113.90"
  };
  if (options.cookie) headers.cookie = `next-auth.session-token=${options.cookie}`;
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  if (options.origin !== null) headers.origin = options.origin ?? ORIGIN;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  });
}

function codeFromOutbox() {
  const message = [...emailOutbox()].reverse().find(entry => /code is (\d{6})/.test(entry.text));
  assert.ok(message, "the step-up code email was queued");
  return /code is (\d{6})/.exec(message.text)![1];
}

function request(path: string, method: "POST" | "DELETE", options: Call = {}) {
  return call(path, method, options);
}

async function main() {
  process.env.NEXTAUTH_URL = ORIGIN;
  process.env.NEXTAUTH_SECRET = "synthetic-sign-out-all-secret-for-tests-0123456789";
  process.env.TRUST_PROXY_HEADERS = "1";
  process.env.LOG_LEVEL = "debug";
  delete process.env.EMAIL_TRANSPORT;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  const savedNodeEnv = process.env.NODE_ENV;
  (process.env as Record<string, string | undefined>).NODE_ENV = "development";

  const signOutOthers = require("../app/api/account/sessions/route").DELETE as (r: NextRequest) => Promise<Response>;
  const stepRequest = require("../app/api/account/step-up/request/route").POST as (r: NextRequest) => Promise<Response>;
  const stepVerify = require("../app/api/account/step-up/verify/route").POST as (r: NextRequest) => Promise<Response>;

  await databaseFixture(async client => {
    const addOwner = async (id: string, email: string) => {
      await client.query("INSERT INTO auth_users(id,name,email) VALUES($1,$2,$3)", [id, id, email]);
    };
    const countSessions = async (owner: string) =>
      (await client.query<{ n: number }>("SELECT count(*)::int n FROM auth_sessions WHERE owner_id=$1", [owner])).rows[0].n;

    await addOwner("signout-a", "signout-a@example.invalid");
    await addOwner("signout-b", "signout-b@example.invalid");
    await addOwner("signout-c", "signout-c@example.invalid");

    // Owner A: the cookie session that asks, a second web session and two phones.
    const aCurrent = await createWebSession("signout-a");
    const aOtherWeb = await createWebSession("signout-a");
    const aPhoneOne = await createMobileSession("signout-a");
    const aPhoneTwo = await createMobileSession("signout-a");
    // Owner B must be untouched by any owner's action.
    const bWeb = await createWebSession("signout-b");
    const bPhone = await createMobileSession("signout-b");
    // Devices are owner-level, not session-level, so they deliberately survive.
    await client.query(
      "INSERT INTO device_push_tokens(owner_id,token,platform) VALUES('signout-a','ExponentPushToken[synthetic-285]','android')"
    );

    // Anonymous requests are 401 and change nothing.
    const beforeAnonymous = await countSessions("signout-a");
    assert.equal((await signOutOthers(new NextRequest(`http://localhost${PATH}`, { method: "DELETE" }))).status, 401);
    assert.equal(await countSessions("signout-a"), beforeAnonymous, "an anonymous request deletes nothing");

    // A signed-in cookie session still needs the fresh step-up code.
    const denied = await signOutOthers(request(PATH, "DELETE", { cookie: aCurrent.token }));
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: "step_up_required" });
    assert.equal(await countSessions("signout-a"), 4, "without step-up every other session survives");

    // Step up through the real routes, then remove every other A session.
    clearEmailOutbox();
    resetEmailCodeThrottle();
    assert.equal((await stepRequest(request(STEP_REQUEST, "POST", { cookie: aCurrent.token, body: {} }))).status, 200);
    const code = codeFromOutbox();
    assert.equal((await stepVerify(request(STEP_VERIFY, "POST", { cookie: aCurrent.token, body: { code } }))).status, 200);

    // Capture logs around the action: the raw tokens must never be written.
    const captured: string[] = [];
    const original = { log: console.log, error: console.error };
    console.log = (...args: unknown[]) => { captured.push(args.map(String).join(" ")); };
    console.error = (...args: unknown[]) => { captured.push(args.map(String).join(" ")); };
    let text: string;
    try {
      const response = await signOutOthers(request(PATH, "DELETE", { cookie: aCurrent.token }));
      assert.equal(response.status, 200);
      text = await response.text();
    } finally {
      console.log = original.log;
      console.error = original.error;
    }
    assert.deepEqual(JSON.parse(text), { ok: true, revoked: 3 });
    for (const token of [aCurrent.token, aOtherWeb.token, aPhoneOne.token, aPhoneTwo.token, bWeb.token, bPhone.token]) {
      assert.ok(!text.includes(token), "the response never echoes a session token");
      assert.ok(!captured.join("\n").includes(token), "logs never contain a session token");
    }
    assert.match(captured.join("\n"), /request/, "debug request logging ran during the action");

    // Only this web session remains for A; both kinds of other row are gone.
    assert.equal(await countSessions("signout-a"), 1);
    assert.deepEqual(
      (await client.query("SELECT token_hash FROM auth_sessions WHERE owner_id='signout-a'")).rows.map(row => row.token_hash),
      [sessionHash(aCurrent.token)]
    );
    assert.equal((await authAdapter.getSessionAndUser!(aCurrent.token))?.user.id, "signout-a", "the current session survives");
    assert.equal(await authAdapter.getSessionAndUser!(aOtherWeb.token), null, "the other web session is removed");
    assert.equal(await resolveMobileSession(aPhoneOne.token), null, "one phone session is removed");
    assert.equal(await resolveMobileSession(aPhoneTwo.token), null, "the other phone session is removed");

    // Another owner's web and phone sessions are untouched.
    assert.equal(await countSessions("signout-b"), 2);
    assert.equal((await authAdapter.getSessionAndUser!(bWeb.token))?.user.id, "signout-b");
    assert.deepEqual(await resolveMobileSession(bPhone.token), { ownerId: "signout-b", token: bPhone.token });

    // Push tokens are owner-level (device_push_tokens has no session id), so the
    // owner's device registration intentionally stays after other sessions end.
    assert.equal(
      (await client.query("SELECT count(*)::int n FROM device_push_tokens WHERE owner_id='signout-a'")).rows[0].n,
      1
    );

    // A mobile bearer caller gets the same rule: step-up, then only other rows go.
    const cCurrent = await createMobileSession("signout-c");
    const cOtherPhone = await createMobileSession("signout-c");
    const cOtherWeb = await createWebSession("signout-c");
    const bearerDenied = await signOutOthers(request(PATH, "DELETE", { bearer: cCurrent.token }));
    assert.equal(bearerDenied.status, 403);
    assert.deepEqual(await bearerDenied.json(), { error: "step_up_required" });
    assert.equal(await countSessions("signout-c"), 3);

    clearEmailOutbox();
    assert.equal((await stepRequest(request(STEP_REQUEST, "POST", { bearer: cCurrent.token, body: {} }))).status, 200);
    const bearerCode = codeFromOutbox();
    assert.equal((await stepVerify(request(STEP_VERIFY, "POST", { bearer: cCurrent.token, body: { code: bearerCode } }))).status, 200);
    const bearerResponse = await signOutOthers(request(PATH, "DELETE", { bearer: cCurrent.token }));
    assert.equal(bearerResponse.status, 200);
    assert.deepEqual(await bearerResponse.json(), { ok: true, revoked: 2 });
    assert.deepEqual(await resolveMobileSession(cCurrent.token), { ownerId: "signout-c", token: cCurrent.token });
    assert.equal(await resolveMobileSession(cOtherPhone.token), null);
    assert.equal(await authAdapter.getSessionAndUser!(cOtherWeb.token), null);
    assert.equal(await countSessions("signout-c"), 1);

    // A second run is harmless and reports nothing left to remove.
    const again = await signOutOthers(request(PATH, "DELETE", { bearer: cCurrent.token }));
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { ok: true, revoked: 0 });
  });

  (process.env as Record<string, string | undefined>).NODE_ENV = savedNodeEnv;
  delete process.env.LOG_LEVEL;
  delete process.env.NEXTAUTH_SECRET;
  delete process.env.TRUST_PROXY_HEADERS;
  delete process.env.NEXTAUTH_URL;
  console.log("sign out of all other devices tests passed");
}

main().catch(error => { console.error(error); process.exit(1); });
