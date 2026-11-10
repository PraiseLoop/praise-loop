import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import type { PoolClient } from "pg";
import { databaseFixture } from "./db-fixture";
import { sessionHash } from "../lib/auth-adapter";
import { clearEmailOutbox, emailOutbox } from "../lib/email";
import { resetEmailCodeThrottle } from "../lib/emailAuth";
import {
  createPasswordCredential,
  hasPassword,
  setPasswordForOwner,
  verifyPassword
} from "../lib/passwordAuth";
import {
  BREACH_RANGE_URL,
  BREACHED_PASSWORD_MESSAGE,
  setPasswordBreachFetcherForTests
} from "../lib/passwordBreach";
import { createWebSession } from "../lib/webSessions";

// Set a password while signed in (#286) and the breached-password check on every
// path that creates or changes one. All network calls go through an injected fake;
// no test reaches the real Have I Been Pwned service.

const ORIGIN = "http://localhost:3000";
const SET_PATH = "/api/account/password/set";
const PASSWORD_A = "synthetic-set-password-alpha-286";
const PASSWORD_B = "synthetic-set-password-bravo-286";
const PASSWORD_BREACHED = "synthetic-set-password-breached-286";
const TAKEN_PASSWORD = "synthetic-set-password-taken-286";

function sha1(value: string) {
  // The range protocol is SHA-1 based; this only builds synthetic test input.
  return createHash("sha1").update(value, "utf8").digest("hex").toUpperCase(); // codeql[js/insufficient-password-hash]
}

/** A fake range response: the target password's suffix has a positive count. */
function breachFetcher(target: string, count = 5): typeof fetch {
  const digest = sha1(target);
  return (async (url: RequestInfo | URL) => {
    const prefix = String(url).slice(BREACH_RANGE_URL.length);
    const suffix = digest.slice(5);
    const body = prefix === digest.slice(0, 5)
      ? `${suffix}:${count}\r\n0000000000000000000000000000000000:0\r\n`
      : "0000000000000000000000000000000000:0\r\n";
    return new Response(body);
  }) as unknown as typeof fetch;
}

function request(path: string, cookie: string, body: object) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      cookie: `next-auth.session-token=${cookie}`
    },
    body: JSON.stringify(body)
  });
}

function web(path: string, body: object) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "cf-connecting-ip": "203.0.113.120",
      "user-agent": "Mozilla/5.0 (Macintosh) Chrome/130"
    },
    body: JSON.stringify(body)
  });
}

function lastCode() {
  const message = [...emailOutbox()].reverse().find(entry => /code is (\d{6})/.test(entry.text));
  assert.ok(message, "a sign-in code email was queued");
  return /code is (\d{6})/.exec(message.text)![1];
}

function lastResetToken() {
  const message = [...emailOutbox()].reverse().find(entry => /reset-password\?token=([A-Za-z0-9_-]{43})/.test(entry.text));
  assert.ok(message, "a reset email was queued");
  return /reset-password\?token=([A-Za-z0-9_-]{43})/.exec(message.text)![1];
}

async function addOwner(client: PoolClient, id: string, email: string | null, verified = true) {
  await client.query(
    `INSERT INTO auth_users(id,name,email,"emailVerified") VALUES($1,$2,$3,$4)`,
    [id, id, email, email && verified ? new Date() : null]
  );
}

async function addSessionWithStepUp(client: PoolClient, owner: string) {
  const session = await createWebSession(owner);
  await client.query("UPDATE auth_sessions SET step_up_at=now() WHERE token_hash=$1", [sessionHash(session.token)]);
  return session;
}

async function main() {
  process.env.NEXTAUTH_URL = ORIGIN;
  process.env.NEXTAUTH_SECRET = "synthetic-password-set-secret-for-tests-0123456789";
  process.env.TRUST_PROXY_HEADERS = "1";
  delete process.env.EMAIL_TRANSPORT;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  process.env.PASSWORD_BREACH_CHECK = "off";
  const savedNodeEnv = process.env.NODE_ENV;
  const savedSwitch = process.env.PASSWORD_BREACH_CHECK;
  (process.env as Record<string, string | undefined>).NODE_ENV = "development";

  const setRoute = require("../app/api/account/password/set/route").POST as (r: NextRequest) => Promise<Response>;
  const signupRoute = require("../app/api/auth/password/signup/route").POST as (r: NextRequest) => Promise<Response>;
  const resetRequestRoute = require("../app/api/auth/password/reset/request/route").POST as (r: NextRequest) => Promise<Response>;
  const resetConfirmRoute = require("../app/api/auth/password/reset/confirm/route").POST as (r: NextRequest) => Promise<Response>;
  const changeRoute = require("../app/api/account/password/route").POST as (r: NextRequest) => Promise<Response>;
  const emailRequestRoute = require("../app/api/auth/email/request/route").POST as (r: NextRequest) => Promise<Response>;

  try {
    await databaseFixture(async client => {
      const count = async (sql: string, values: unknown[] = []) => Number((await client.query(sql, values)).rows[0].n);
      const credential = async (owner: string) =>
        (await client.query("SELECT * FROM password_credentials WHERE owner_id=$1", [owner])).rows[0] ?? null;

      // --- Set a password while signed in -------------------------------
      await addOwner(client, "set-happy", "set-happy@example.invalid");
      const happySession = await addSessionWithStepUp(client, "set-happy");
      const anonymous = await new NextRequest(`http://localhost${SET_PATH}`, { method: "POST" });
      assert.equal((await setRoute(anonymous)).status, 401, "the set route is ownerRoute-protected");

      const happy = await setRoute(request(SET_PATH, happySession.token, { password: PASSWORD_A }));
      assert.equal(happy.status, 200);
      assert.deepEqual(await happy.json(), { ok: true });
      const happyCredential = await credential("set-happy");
      assert.ok(happyCredential, "the credential is written");
      assert.equal(happyCredential.email, "set-happy@example.invalid", "the owner's primary verified address is used");
      assert.ok(happyCredential.verified_at);
      assert.equal(await verifyPassword(PASSWORD_A, {
        n: happyCredential.scrypt_n,
        r: happyCredential.scrypt_r,
        p: happyCredential.scrypt_p,
        keyLength: happyCredential.key_length,
        salt: happyCredential.salt,
        hash: happyCredential.password_hash
      }), true);
      assert.ok(!JSON.stringify(happyCredential).includes(PASSWORD_A), "the plaintext is never stored");
      assert.equal(await hasPassword("set-happy"), true);

      const again = await setRoute(request(SET_PATH, happySession.token, { password: PASSWORD_B }));
      assert.equal(again.status, 409, "an owner with a password keeps the change-password form");
      assert.match((await again.json()).error, /already has a password/i);
      assert.equal(await count("SELECT count(*) n FROM password_credentials WHERE owner_id='set-happy'"), 1);

      // A fresh step-up is required even though the session is valid.
      await addOwner(client, "set-no-step", "set-no-step@example.invalid");
      const noStep = await createWebSession("set-no-step");
      const denied = await setRoute(request(SET_PATH, noStep.token, { password: PASSWORD_A }));
      assert.equal(denied.status, 403);
      assert.deepEqual(await denied.json(), { error: "step_up_required" });
      assert.equal(await credential("set-no-step"), null, "no credential without step-up");

      // An owner with no verified address cannot set a password. A recent
      // session passes the no-address step-up fallback, then the route refuses.
      await addOwner(client, "set-no-email", null);
      const noEmailSession = await createWebSession("set-no-email");
      const noEmail = await setRoute(request(SET_PATH, noEmailSession.token, { password: PASSWORD_A }));
      assert.equal(noEmail.status, 400);
      assert.match((await noEmail.json()).error, /verify an email address/i);
      assert.equal(await credential("set-no-email"), null);

      // The same address already belongs to another owner's credential.
      await addOwner(client, "set-taken", "taken@example.invalid");
      await addOwner(client, "set-other", "set-other@example.invalid");
      assert.equal((await createPasswordCredential("set-other", "taken@example.invalid", TAKEN_PASSWORD)).ok, true);
      const takenSession = await addSessionWithStepUp(client, "set-taken");
      const taken = await setRoute(request(SET_PATH, takenSession.token, { password: PASSWORD_A }));
      assert.equal(taken.status, 409);
      assert.equal((await taken.json()).error, "A password is already set for that address. Sign in or reset it.");
      assert.equal(await credential("set-taken"), null, "no credential is written for the taken address");

      // Invalid length and breached passwords are refused without a credential.
      const short = await setRoute(request(SET_PATH, happySession.token, { password: "short" }));
      assert.equal(short.status, 400);
      assert.match((await short.json()).error, /12 characters/);

      await addOwner(client, "set-breach", "set-breach@example.invalid");
      const breachSession = await addSessionWithStepUp(client, "set-breach");
      process.env.PASSWORD_BREACH_CHECK = "on";
      setPasswordBreachFetcherForTests(breachFetcher(PASSWORD_BREACHED));
      const breached = await setRoute(request(SET_PATH, breachSession.token, { password: PASSWORD_BREACHED }));
      assert.equal(breached.status, 400);
      assert.equal((await breached.json()).error, BREACHED_PASSWORD_MESSAGE);
      assert.equal(await credential("set-breach"), null, "a breached password is not stored");
      process.env.PASSWORD_BREACH_CHECK = "off";
      setPasswordBreachFetcherForTests(null);

      // The same owner rule is available to the phone path through the module.
      await addOwner(client, "set-module", "set-module@example.invalid");
      assert.equal((await setPasswordForOwner("set-module", PASSWORD_B)).ok, true);
      const secondSet = await setPasswordForOwner("set-module", PASSWORD_A);
      assert.equal(secondSet.ok, false);
      assert.equal(secondSet.ok ? null : secondSet.reason, "password_exists");

      // --- Breach check at sign-up --------------------------------------
      await clearEmailOutbox();
      resetEmailCodeThrottle();
      process.env.PASSWORD_BREACH_CHECK = "on";
      setPasswordBreachFetcherForTests(breachFetcher(PASSWORD_BREACHED));
      assert.equal((await emailRequestRoute(web("/api/auth/email/request", { email: "signup-breach@example.invalid" }))).status, 200);
      const signupCode = lastCode();
      const signupBreached = await signupRoute(web("/api/auth/password/signup", {
        email: "signup-breach@example.invalid",
        code: signupCode,
        password: PASSWORD_BREACHED
      }));
      assert.equal(signupBreached.status, 400);
      assert.equal((await signupBreached.json()).error, BREACHED_PASSWORD_MESSAGE);
      assert.equal(await count("SELECT count(*) n FROM password_credentials WHERE email='signup-breach@example.invalid'"), 0);
      assert.equal(await count("SELECT count(*) n FROM auth_users WHERE email='signup-breach@example.invalid'"), 0, "nothing is created before the password is accepted");
      // The code was not consumed by the refusal, so the same code still works.
      const signupClear = await signupRoute(web("/api/auth/password/signup", {
        email: "signup-breach@example.invalid",
        code: signupCode,
        password: PASSWORD_A
      }));
      assert.equal(signupClear.status, 200, "a clear password still works with the same code");

      // --- Breach check at reset ----------------------------------------
      await addOwner(client, "reset-breach", "reset-breach@example.invalid");
      assert.equal((await createPasswordCredential("reset-breach", "reset-breach@example.invalid", PASSWORD_A)).ok, true);
      await clearEmailOutbox();
      assert.equal((await resetRequestRoute(web("/api/auth/password/reset/request", { email: "reset-breach@example.invalid" }))).status, 200);
      const resetToken = lastResetToken();
      const resetBreached = await resetConfirmRoute(web("/api/auth/password/reset/confirm", {
        token: resetToken,
        password: PASSWORD_BREACHED
      }));
      assert.equal(resetBreached.status, 400);
      assert.equal((await resetBreached.json()).error, BREACHED_PASSWORD_MESSAGE);
      const resetRow = (await client.query("SELECT consumed_at FROM password_reset_tokens WHERE owner_id='reset-breach'")).rows[0];
      assert.equal(resetRow.consumed_at, null, "a rejected password does not consume the reset link");
      const resetCred = await credential("reset-breach");
      assert.equal(await verifyPassword(PASSWORD_A, {
        n: resetCred.scrypt_n,
        r: resetCred.scrypt_r,
        p: resetCred.scrypt_p,
        keyLength: resetCred.key_length,
        salt: resetCred.salt,
        hash: resetCred.password_hash
      }), true, "the old password still works");

      // --- Breach check at change ---------------------------------------
      await addOwner(client, "change-breach", "change-breach@example.invalid");
      assert.equal((await createPasswordCredential("change-breach", "change-breach@example.invalid", PASSWORD_A)).ok, true);
      const changeSession = await createWebSession("change-breach");
      const changeBreached = await changeRoute(request("/api/account/password", changeSession.token, {
        currentPassword: PASSWORD_A,
        newPassword: PASSWORD_BREACHED
      }));
      assert.equal(changeBreached.status, 400);
      assert.equal((await changeBreached.json()).error, BREACHED_PASSWORD_MESSAGE);
      const changeCred = await credential("change-breach");
      assert.equal(await verifyPassword(PASSWORD_A, {
        n: changeCred.scrypt_n,
        r: changeCred.scrypt_r,
        p: changeCred.scrypt_p,
        keyLength: changeCred.key_length,
        salt: changeCred.salt,
        hash: changeCred.password_hash
      }), true, "a rejected change leaves the old password alone");
      assert.equal(await count("SELECT count(*) n FROM auth_sessions WHERE owner_id='change-breach'"), 1, "a rejected change keeps sessions");

      // An unavailable lookup fails open on the change path too.
      setPasswordBreachFetcherForTests((async () => { throw new TypeError("synthetic offline"); }) as unknown as typeof fetch);
      const changeOpen = await changeRoute(request("/api/account/password", changeSession.token, {
        currentPassword: PASSWORD_A,
        newPassword: PASSWORD_B
      }));
      assert.equal(changeOpen.status, 200, "an unavailable breach check allows the change");

      // --- The switch off skips the network entirely ---------------------
      process.env.PASSWORD_BREACH_CHECK = "off";
      let called = false;
      setPasswordBreachFetcherForTests((async () => { called = true; return new Response(""); }) as unknown as typeof fetch);
      await addOwner(client, "switch-off", "switch-off@example.invalid");
      const switchSession = await addSessionWithStepUp(client, "switch-off");
      const switchOff = await setRoute(request(SET_PATH, switchSession.token, { password: PASSWORD_BREACHED }));
      assert.equal(switchOff.status, 200);
      assert.equal(called, false, "the fake fetch is not called when the switch is off");
      setPasswordBreachFetcherForTests(null);
    });
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = savedNodeEnv;
    if (savedSwitch === undefined) delete process.env.PASSWORD_BREACH_CHECK;
    else process.env.PASSWORD_BREACH_CHECK = savedSwitch;
    setPasswordBreachFetcherForTests(null);
  }

  console.log("set-password and breach-check integration tests passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
