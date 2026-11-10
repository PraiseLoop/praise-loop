import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import type { PoolClient } from "pg";
import { databaseFixture } from "./db-fixture";
import { authAdapter, sessionHash } from "../lib/auth-adapter";
import { clearEmailOutbox, emailOutbox } from "../lib/email";
import { resetEmailCodeThrottle } from "../lib/emailAuth";
import { resetFailures } from "../lib/mobileSignIn";
import { createMobileSession } from "../lib/mobileSessions";
import {
  ACCOUNT_FAILURE_LIMIT,
  PASSWORD_MIN_LENGTH,
  createPasswordCredential,
  flushPasswordLockEmails,
  hashPassword,
  hasPassword,
  passwordProblem,
  verifyPassword
} from "../lib/passwordAuth";
import { flushSignInAlerts } from "../lib/signInAlerts";

const ORIGIN = "http://localhost:3000";

// Distinct synthetic passwords so a stray copy in a log or database column is
// easy to find. None of these is a real credential.
const PASSWORD_A = "synthetic-password-alpha-159";
const PASSWORD_B = "synthetic-password-bravo-159";
const PASSWORD_C = "synthetic-password-charlie-159";
const PASSWORD_D = "synthetic-password-delta-159";
const PASSWORD_E = "synthetic-password-echo-159";
const CUSTOM_PARAM_PASSWORD = "synthetic-password-custom-159";

const captured: string[] = [];
const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };

function startCapture() {
  console.log = (...args: unknown[]) => { captured.push(args.map(value => String(value)).join(" ")); };
  console.info = (...args: unknown[]) => { captured.push(args.map(value => String(value)).join(" ")); };
  console.warn = (...args: unknown[]) => { captured.push(args.map(value => String(value)).join(" ")); };
  console.error = (...args: unknown[]) => { captured.push(args.map(value => String(value)).join(" ")); };
}
function stopCapture() {
  console.log = originalConsole.log;
  console.info = originalConsole.info;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
}

function web(path: string, body: object, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": "203.0.113.40", "user-agent": "Mozilla/5.0 (Macintosh) Chrome/130", ...headers },
    body: JSON.stringify(body)
  });
}

function cookieWeb(path: string, cookie: string, body: object, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie: `next-auth.session-token=${cookie}`, ...headers },
    body: JSON.stringify(body)
  });
}

function mobile(body: object, ip = "203.0.113.41") {
  return new NextRequest("http://localhost/api/mobile/session/password", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, "user-agent": "okhttp/4.12 Android" },
    body: JSON.stringify(body)
  });
}

function lastCode() {
  const message = [...emailOutbox()].reverse().find(entry => /code is (\d{6})/.test(entry.text));
  assert.ok(message, "a sign-in code email was queued");
  return /code is (\d{6})/.exec(message.text)![1];
}

// A wrong code that is guaranteed not to be the real one.
function wrongCodeFor(code: string) {
  return code === "000000" ? "111111" : "000000";
}

function lastResetToken() {
  const message = [...emailOutbox()].reverse().find(entry => /reset-password\?token=([A-Za-z0-9_-]{43})/.test(entry.text));
  assert.ok(message, "a reset email was queued");
  return /reset-password\?token=([A-Za-z0-9_-]{43})/.exec(message.text)![1];
}

async function fresh() {
  await flushSignInAlerts();
  await flushPasswordLockEmails();
  clearEmailOutbox();
  resetEmailCodeThrottle();
  resetFailures();
}

async function seedOwner(client: PoolClient, email: string, password: string, id = randomUUID()) {
  await client.query(`INSERT INTO auth_users(id,name,email,"emailVerified") VALUES($1,'Synthetic Password Owner',$2,now())`, [id, email]);
  await client.query(
    "INSERT INTO auth_accounts(provider,provider_account_id,owner_id,email,created_at,last_used_at) VALUES('email',$1,$2,$1,now(),now())",
    [email, id]
  );
  const credential = await createPasswordCredential(id, email, password);
  assert.equal(credential.ok, true);
  return id;
}

async function countSessions(client: PoolClient, ownerId: string) {
  return Number((await client.query("SELECT count(*) n FROM auth_sessions WHERE owner_id=$1", [ownerId])).rows[0].n);
}

function cookieFrom(response: Response) {
  const header = response.headers.get("set-cookie") ?? "";
  const match = /(?:__Secure-)?next-auth\.session-token=([^;]+)/.exec(header);
  assert.ok(match, "a web session cookie was set");
  return match![1];
}

async function main() {
  process.env.NEXTAUTH_URL = ORIGIN;
  process.env.NEXTAUTH_SECRET = "synthetic-password-sign-in-secret-for-tests-0123456789";
  process.env.TRUST_PROXY_HEADERS = "1";
  delete process.env.EMAIL_TRANSPORT;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  delete process.env.SIGNUP_MODE;
  delete process.env.INVITED_EMAILS;
  const savedNodeEnv = process.env.NODE_ENV;
  (process.env as Record<string, string | undefined>).NODE_ENV = "development";

  const signupRoute = require("../app/api/auth/password/signup/route").POST as (r: NextRequest) => Promise<Response>;
  const signinRoute = require("../app/api/auth/password/signin/route").POST as (r: NextRequest) => Promise<Response>;
  const mobileRoute = require("../app/api/mobile/session/password/route").POST as (r: NextRequest) => Promise<Response>;
  const resetRequestRoute = require("../app/api/auth/password/reset/request/route").POST as (r: NextRequest) => Promise<Response>;
  const resetConfirmRoute = require("../app/api/auth/password/reset/confirm/route").POST as (r: NextRequest) => Promise<Response>;
  const changeRoute = require("../app/api/account/password/route").POST as (r: NextRequest) => Promise<Response>;
  const changeGet = require("../app/api/account/password/route").GET as (r: NextRequest) => Promise<Response>;

  // --- Rules and hash parameters -----------------------------------------
  assert.equal(PASSWORD_MIN_LENGTH, 12);
  assert.equal(passwordProblem("short"), "too_short");
  assert.equal(passwordProblem("a".repeat(11)), "too_short");
  assert.equal(passwordProblem("a".repeat(12)), null);
  assert.equal(passwordProblem("a".repeat(256)), null);
  assert.equal(passwordProblem("a".repeat(257)), "too_long");
  assert.equal(passwordProblem("😀".repeat(256)), null, "the maximum counts code points, not UTF-16 units");
  assert.equal(passwordProblem(42), "too_short");

  const storedDefault = await hashPassword(PASSWORD_A);
  assert.equal(storedDefault.n, 16384);
  assert.equal(storedDefault.r, 8);
  assert.equal(storedDefault.p, 1);
  assert.equal(storedDefault.keyLength, 32);
  assert.equal(Buffer.from(storedDefault.salt, "base64").length, 16);
  assert.equal(Buffer.from(storedDefault.hash, "base64").length, 32);
  assert.equal(await verifyPassword(PASSWORD_A, storedDefault), true);
  assert.equal(await verifyPassword(PASSWORD_B, storedDefault), false);
  assert.equal(await verifyPassword(PASSWORD_A, { ...storedDefault, hash: storedDefault.hash.slice(0, -4) + "AAAA" }), false);

  // A hash written with raised (or, for this test, lowered) parameters must
  // verify with the values stored beside it.
  const storedCustom = await hashPassword(CUSTOM_PARAM_PASSWORD, { n: 1024, r: 8, p: 1, keyLength: 32 });
  assert.equal(storedCustom.n, 1024);
  assert.equal(await verifyPassword(CUSTOM_PARAM_PASSWORD, storedCustom), true);
  assert.equal(await verifyPassword(CUSTOM_PARAM_PASSWORD, { ...storedCustom, n: 16384 }), false);

  startCapture();
  try {
    await databaseFixture(async client => {
      const count = async (sql: string, values: unknown[] = []) => Number((await client.query(sql, values)).rows[0].n);

      // --- Sign-up requires a proved mailbox -----------------------------
      await fresh();
      const requestRoute = require("../app/api/auth/email/request/route").POST as (r: NextRequest) => Promise<Response>;
      assert.equal((await requestRoute(web("/api/auth/email/request", { email: "new-password@example.invalid" }))).status, 200);
      const signupCode = lastCode();

      const noCode = await signupRoute(web("/api/auth/password/signup", { email: "new-password@example.invalid", password: PASSWORD_A }));
      assert.equal(noCode.status, 400, "a sign-up without a code is refused");
      assert.equal(await count("SELECT count(*) n FROM password_credentials"), 0, "no credential exists before verification");
      assert.equal(await count("SELECT count(*) n FROM auth_users WHERE email='new-password@example.invalid'"), 0, "no owner is created before verification");

      const wrongCode = await signupRoute(web("/api/auth/password/signup", { email: "new-password@example.invalid", code: wrongCodeFor(signupCode), password: PASSWORD_A }));
      assert.equal(wrongCode.status, 400);
      assert.equal(await count("SELECT count(*) n FROM password_credentials"), 0);

      const shortPassword = await signupRoute(web("/api/auth/password/signup", { email: "new-password@example.invalid", code: signupCode, password: "too-short" }));
      assert.equal(shortPassword.status, 400);
      assert.match((await shortPassword.json()).error, /12 characters/);
      // Validation happens before the code is consumed, so the same code still works.
      const signup = await signupRoute(web("/api/auth/password/signup", { email: "new-password@example.invalid", code: signupCode, password: PASSWORD_A }));
      assert.equal(signup.status, 200);
      cookieFrom(signup);
      const newOwner = (await client.query("SELECT * FROM auth_users WHERE email='new-password@example.invalid'")).rows[0];
      assert.ok(newOwner && newOwner.emailVerified, "sign-up verifies the email on the owner row");
      const credential = (await client.query("SELECT * FROM password_credentials WHERE owner_id=$1", [newOwner.id])).rows[0];
      assert.ok(credential.verified_at, "the credential is usable only with a verified timestamp");
      assert.equal(credential.scrypt_n, 16384);
      assert.equal(credential.scrypt_r, 8);
      assert.equal(credential.scrypt_p, 1);
      assert.equal(credential.key_length, 32);
      assert.equal(Buffer.from(credential.salt, "base64").length, 16);
      assert.notEqual(credential.password_hash, PASSWORD_A);
      assert.ok(!JSON.stringify(credential).includes(PASSWORD_A), "the plaintext password is not in its row");
      assert.equal(await count("SELECT count(*) n FROM auth_sessions WHERE owner_id=$1 AND kind='web'", [newOwner.id]), 1, "sign-up creates a normal web session");
      assert.equal((await client.query("SELECT provider FROM auth_accounts WHERE owner_id=$1", [newOwner.id])).rows.map(r => r.provider).sort().join(","), "email");
      const consumed = (await client.query("SELECT consumed_at FROM email_sign_in_codes WHERE email='new-password@example.invalid' ORDER BY id DESC LIMIT 1")).rows[0];
      assert.ok(consumed.consumed_at, "the sign-up code is single use");

      // Existing email method plus a password: the same owner, never a duplicate.
      await requestRoute(web("/api/auth/email/request", { email: "google-password@example.invalid" }));
      const googleCode = lastCode();
      await client.query(`INSERT INTO auth_users(id,name,email,"emailVerified") VALUES('google-password-owner','Existing Google Owner','google-password@example.invalid',now())`);
      await client.query("INSERT INTO auth_accounts(provider,provider_account_id,owner_id,email,created_at,last_used_at) VALUES('google','google-sub-password','google-password-owner','google-password@example.invalid',now(),now())");
      const unverifiedClaim = await signupRoute(web("/api/auth/password/signup", { email: "google-password@example.invalid", code: wrongCodeFor(googleCode), password: PASSWORD_B }));
      assert.equal(unverifiedClaim.status, 400);
      assert.equal(await count("SELECT count(*) n FROM password_credentials WHERE owner_id='google-password-owner'"), 0, "an unverified signup cannot claim an existing owner's address");
      const linked = await signupRoute(web("/api/auth/password/signup", { email: "google-password@example.invalid", code: googleCode, password: PASSWORD_B }));
      assert.equal(linked.status, 200);
      assert.equal(await count("SELECT count(*) n FROM auth_users WHERE email='google-password@example.invalid'"), 1, "no duplicate owner");
      assert.equal(await count("SELECT count(*) n FROM password_credentials WHERE owner_id='google-password-owner'"), 1);
      assert.equal((await client.query("SELECT provider FROM auth_accounts WHERE owner_id='google-password-owner' ORDER BY provider")).rows.map(r => r.provider).join(","), "email,google");

      // Invite gate: a brand-new uninvited address is refused before a credential.
      await fresh();
      process.env.SIGNUP_MODE = "invite";
      delete process.env.INVITED_EMAILS;
      assert.equal((await requestRoute(web("/api/auth/email/request", { email: "uninvited@example.invalid" }))).status, 200);
      const uninvitedCode = lastCode();
      const refused = await signupRoute(web("/api/auth/password/signup", { email: "uninvited@example.invalid", code: uninvitedCode, password: PASSWORD_C }));
      assert.equal(refused.status, 403);
      assert.equal((await refused.json()).error, "invite_only");
      assert.equal(await count("SELECT count(*) n FROM password_credentials WHERE email='uninvited@example.invalid'"), 0);
      assert.equal(await count("SELECT count(*) n FROM auth_users WHERE email='uninvited@example.invalid'"), 0);
      process.env.INVITED_EMAILS = "uninvited@example.invalid";
      await fresh();
      await requestRoute(web("/api/auth/email/request", { email: "uninvited@example.invalid" }));
      const invited = await signupRoute(web("/api/auth/password/signup", { email: "uninvited@example.invalid", code: lastCode(), password: PASSWORD_C }));
      assert.equal(invited.status, 200, "an invited address can create a password owner");
      delete process.env.SIGNUP_MODE;
      delete process.env.INVITED_EMAILS;

      // --- Sign-in and non-enumeration -----------------------------------
      await fresh();
      await client.query("DELETE FROM password_throttle");
      const wrong = await signinRoute(web("/api/auth/password/signin", { email: "new-password@example.invalid", password: PASSWORD_B }));
      const unknown = await signinRoute(web("/api/auth/password/signin", { email: "nobody@example.invalid", password: PASSWORD_B }));
      assert.equal(wrong.status, 401);
      assert.equal(unknown.status, 401);
      assert.deepEqual(await wrong.json(), await unknown.json(), "unknown address and wrong password answer identically");
      assert.equal(wrong.headers.get("set-cookie"), null);
      assert.equal(unknown.headers.get("set-cookie"), null);

      const mobileWrong = await mobileRoute(mobile({ email: "new-password@example.invalid", password: PASSWORD_B }, "203.0.113.50"));
      const mobileUnknown = await mobileRoute(mobile({ email: "nobody@example.invalid", password: PASSWORD_B }, "203.0.113.50"));
      assert.equal(mobileWrong.status, 400, "the phone route avoids 401 so a typo cannot look like a dead session");
      assert.equal(mobileUnknown.status, 400);
      assert.deepEqual(await mobileWrong.json(), await mobileUnknown.json());

      // The sign-up already sent a password alert; clear the ten-minute rate
      // limit so this sign-in can prove its own alert. `fresh()` clears the
      // in-memory outbox, not that database row.
      await client.query("DELETE FROM sign_in_alerts");
      await fresh();
      const signedIn = await signinRoute(web("/api/auth/password/signin", { email: "new-password@example.invalid", password: PASSWORD_A }));
      assert.equal(signedIn.status, 200);
      cookieFrom(signedIn);
      await flushSignInAlerts();
      const alert = [...emailOutbox()].reverse().find(entry => entry.to === "new-password@example.invalid");
      assert.ok(alert, "a new sign-in alert is sent");
      assert.match(alert!.text, /Method: password/);
      assert.ok(!alert!.text.includes(PASSWORD_A));

      const mobileSignedIn = await mobileRoute(mobile({ email: "new-password@example.invalid", password: PASSWORD_A }, "203.0.113.51"));
      assert.equal(mobileSignedIn.status, 200);
      const bearer = await mobileSignedIn.json() as { token: string };
      assert.equal(bearer.token.length, 43);
      assert.equal((await client.query("SELECT kind FROM auth_sessions WHERE token_hash=$1", [sessionHash(bearer.token)])).rows[0].kind, "mobile");

      // A hash written with different stored parameters is still verified.
      const customOwner = await seedOwner(client, "custom-params@example.invalid", PASSWORD_D);
      const custom = await hashPassword(CUSTOM_PARAM_PASSWORD, { n: 1024, r: 8, p: 1, keyLength: 32 });
      await client.query(
        `UPDATE password_credentials SET password_hash=$2, scrypt_n=$3, scrypt_r=$4, scrypt_p=$5, salt=$6, key_length=$7 WHERE owner_id=$1`,
        [customOwner, custom.hash, custom.n, custom.r, custom.p, custom.salt, custom.keyLength]
      );
      const customSignIn = await signinRoute(web("/api/auth/password/signin", { email: "custom-params@example.invalid", password: CUSTOM_PARAM_PASSWORD }, { "cf-connecting-ip": "203.0.113.52" }));
      assert.equal(customSignIn.status, 200, "sign-in uses the stored parameters, not the current defaults");

      // --- Account lock, its email, and backoff --------------------------
      await fresh();
      await client.query("DELETE FROM password_throttle");
      const lockOwner = await seedOwner(client, "lock@example.invalid", PASSWORD_E);
      for (let i = 0; i < ACCOUNT_FAILURE_LIMIT; i++) {
        assert.equal((await signinRoute(web("/api/auth/password/signin", { email: "lock@example.invalid", password: `wrong-${i}-synthetic` }, { "cf-connecting-ip": "203.0.113.60" }))).status, 401);
      }
      const locked = (await client.query("SELECT failed_attempts,lock_count,locked_until FROM password_credentials WHERE owner_id=$1", [lockOwner])).rows[0];
      assert.equal(locked.failed_attempts, 0);
      assert.equal(locked.lock_count, 1);
      assert.ok(locked.locked_until && locked.locked_until.getTime() > Date.now(), "the account is locked");
      await flushPasswordLockEmails();
      const lockEmail = [...emailOutbox()].reverse().find(entry => /locked after failed attempts/i.test(entry.subject));
      assert.ok(lockEmail, "the owner is emailed about the lock");
      assert.ok(!lockEmail!.text.includes(PASSWORD_E));

      const correctWhileLocked = await signinRoute(web("/api/auth/password/signin", { email: "lock@example.invalid", password: PASSWORD_E }, { "cf-connecting-ip": "203.0.113.60" }));
      assert.equal(correctWhileLocked.status, 401, "a correct password is refused while the account is locked");

      // After the lock expires the owner can sign in and the counters reset.
      await client.query("UPDATE password_credentials SET locked_until=now()-interval '1 second' WHERE owner_id=$1", [lockOwner]);
      const unlocked = await signinRoute(web("/api/auth/password/signin", { email: "lock@example.invalid", password: PASSWORD_E }, { "cf-connecting-ip": "203.0.113.61" }));
      assert.equal(unlocked.status, 200);
      const resetCounters = (await client.query("SELECT failed_attempts,lock_count,locked_until FROM password_credentials WHERE owner_id=$1", [lockOwner])).rows[0];
      assert.deepEqual([resetCounters.failed_attempts, resetCounters.lock_count, resetCounters.locked_until], [0, 0, null]);

      // A second consecutive lock waits longer: about 30 minutes instead of 15.
      await client.query("UPDATE password_credentials SET lock_count=1 WHERE owner_id=$1", [lockOwner]);
      for (let i = 0; i < ACCOUNT_FAILURE_LIMIT; i++) {
        await signinRoute(web("/api/auth/password/signin", { email: "lock@example.invalid", password: `again-${i}-synthetic` }, { "cf-connecting-ip": "203.0.113.62" }));
      }
      const secondLock = (await client.query("SELECT lock_count,locked_until FROM password_credentials WHERE owner_id=$1", [lockOwner])).rows[0];
      assert.equal(secondLock.lock_count, 2);
      assert.ok(secondLock.locked_until.getTime() - Date.now() > 20 * 60 * 1000, "the lock backs off to about 30 minutes");
      await flushPasswordLockEmails();

      // --- Per-IP throttle (DB-backed) -----------------------------------
      await client.query("DELETE FROM password_throttle");
      for (let i = 0; i < 30; i++) {
        await signinRoute(web("/api/auth/password/signin", { email: `unknown-${i}@example.invalid`, password: PASSWORD_A }, { "cf-connecting-ip": "203.0.113.70" }));
      }
      const blocked = await signinRoute(web("/api/auth/password/signin", { email: "new-password@example.invalid", password: PASSWORD_A }, { "cf-connecting-ip": "203.0.113.70" }));
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.headers.get("retry-after")) > 0);
      assert.equal((await client.query("SELECT count(*) n FROM password_throttle WHERE bucket LIKE 'signin:ip:203.0.113.70'")).rows[0].n, "1", "the IP block lives in Postgres");
      assert.equal((await signinRoute(web("/api/auth/password/signin", { email: "new-password@example.invalid", password: PASSWORD_A }, { "cf-connecting-ip": "203.0.113.71" }))).status, 200, "another IP is unaffected");

      // --- Reset: generic response, hashed 30-minute token, single use ---
      await fresh();
      await client.query("DELETE FROM password_throttle");
      const resetOwner = await seedOwner(client, "reset@example.invalid", PASSWORD_A);
      const webSession = await authAdapter.createSession!({ userId: resetOwner, sessionToken: "reset-web-session", expires: new Date(Date.now() + 3600000) });
      assert.ok(webSession);
      await createMobileSession(resetOwner);
      assert.equal(await countSessions(client, resetOwner), 2);

      const resetKnown = await resetRequestRoute(web("/api/auth/password/reset/request", { email: "reset@example.invalid" }));
      const resetUnknown = await resetRequestRoute(web("/api/auth/password/reset/request", { email: "no-such-reset@example.invalid" }));
      assert.equal(resetKnown.status, 200);
      assert.equal(resetUnknown.status, 200);
      assert.deepEqual(await resetKnown.json(), await resetUnknown.json(), "reset request answers identically for a real and unknown address");
      const unknownMail = [...emailOutbox()].reverse().find(entry => entry.to === "no-such-reset@example.invalid");
      assert.ok(unknownMail, "an unknown address still receives a no-account notice");
      assert.match(unknownMail!.text, /no Praise Loop password account/);
      assert.doesNotMatch(unknownMail!.text, /reset-password\?token=/);
      const resetToken = lastResetToken();
      const tokenRow = (await client.query("SELECT token_hash,expires_at,consumed_at FROM password_reset_tokens WHERE owner_id=$1", [resetOwner])).rows[0];
      assert.equal(tokenRow.token_hash.length, 64);
      assert.notEqual(tokenRow.token_hash, resetToken);
      assert.ok(tokenRow.expires_at.getTime() - Date.now() <= 30 * 60 * 1000 + 5000, "the token lives 30 minutes");
      assert.ok(!JSON.stringify(tokenRow).includes(resetToken), "only the reset token hash is stored");

      // A newer request supersedes the older link.
      const firstToken = lastResetToken();
      await resetRequestRoute(web("/api/auth/password/reset/request", { email: "reset@example.invalid" }));
      const secondToken = lastResetToken();
      assert.notEqual(firstToken, secondToken);
      assert.equal((await resetConfirmRoute(web("/api/auth/password/reset/confirm", { token: firstToken, password: PASSWORD_D }))).status, 400, "the older link was superseded");

      // Expiry is enforced.
      await client.query("UPDATE password_reset_tokens SET expires_at=now()-interval '1 second' WHERE owner_id=$1 AND consumed_at IS NULL", [resetOwner]);
      assert.equal((await resetConfirmRoute(web("/api/auth/password/reset/confirm", { token: secondToken, password: PASSWORD_D }))).status, 400, "an expired token is refused");
      assert.equal(await countSessions(client, resetOwner), 2, "a failed reset leaves sessions alone");

      // A fresh, valid token changes the password and signs out every session.
      await resetRequestRoute(web("/api/auth/password/reset/request", { email: "reset@example.invalid" }));
      const validToken = lastResetToken();
      const reset = await resetConfirmRoute(web("/api/auth/password/reset/confirm", { token: validToken, password: PASSWORD_D }));
      assert.equal(reset.status, 200);
      assert.equal(await countSessions(client, resetOwner), 0, "reset deletes web and phone sessions");
      assert.equal((await resetConfirmRoute(web("/api/auth/password/reset/confirm", { token: validToken, password: PASSWORD_E }))).status, 400, "the token is single use");
      assert.equal((await signinRoute(web("/api/auth/password/signin", { email: "reset@example.invalid", password: PASSWORD_A }, { "cf-connecting-ip": "203.0.113.80" }))).status, 401, "the old password stops working");
      assert.equal((await signinRoute(web("/api/auth/password/signin", { email: "reset@example.invalid", password: PASSWORD_D }, { "cf-connecting-ip": "203.0.113.80" }))).status, 200, "the new password works");
      await fresh();
      assert.equal((await resetConfirmRoute(web("/api/auth/password/reset/confirm", { token: "x".repeat(43), password: PASSWORD_E }))).status, 400);
      assert.equal((await resetConfirmRoute(web("/api/auth/password/reset/confirm", { token: validToken, password: "short" }))).status, 400);

      // --- Change password from a signed-in session ----------------------
      await fresh();
      const changeOwner = await seedOwner(client, "change@example.invalid", PASSWORD_A);
      const keepSession = await authAdapter.createSession!({ userId: changeOwner, sessionToken: "keep-this-web-session", expires: new Date(Date.now() + 3600000) });
      assert.ok(keepSession);
      const otherMobile = await createMobileSession(changeOwner);
      assert.equal(await countSessions(client, changeOwner), 2);
      const changeCookie = "keep-this-web-session";

      assert.equal((await changeGet(new NextRequest("http://localhost/api/account/password", { headers: { cookie: `next-auth.session-token=${changeCookie}` } }))).status, 200);
      assert.equal((await (await changeGet(new NextRequest("http://localhost/api/account/password", { headers: { cookie: `next-auth.session-token=${changeCookie}` } }))).json()).hasPassword, true);
      assert.equal(await hasPassword(changeOwner), true);

      const wrongCurrent = await changeRoute(cookieWeb("/api/account/password", changeCookie, { currentPassword: PASSWORD_B, newPassword: PASSWORD_C }));
      assert.equal(wrongCurrent.status, 400);
      const shortNew = await changeRoute(cookieWeb("/api/account/password", changeCookie, { currentPassword: PASSWORD_A, newPassword: "short" }));
      assert.equal(shortNew.status, 400);
      assert.equal(await countSessions(client, changeOwner), 2, "failed changes keep every session");

      const changed = await changeRoute(cookieWeb("/api/account/password", changeCookie, { currentPassword: PASSWORD_A, newPassword: PASSWORD_C }));
      assert.equal(changed.status, 200);
      assert.equal((await changed.json()).revoked, 1);
      const remaining = (await client.query("SELECT token_hash FROM auth_sessions WHERE owner_id=$1", [changeOwner])).rows;
      assert.deepEqual(remaining.map(r => r.token_hash), [sessionHash(changeCookie)], "the current web session stays, the other is signed out");
      assert.equal((await client.query("SELECT token_hash FROM auth_sessions WHERE token_hash=$1", [sessionHash(otherMobile.token)])).rows.length, 0);
      assert.equal((await signinRoute(web("/api/auth/password/signin", { email: "change@example.invalid", password: PASSWORD_A }, { "cf-connecting-ip": "203.0.113.90" }))).status, 401);
      assert.equal((await signinRoute(web("/api/auth/password/signin", { email: "change@example.invalid", password: PASSWORD_C }, { "cf-connecting-ip": "203.0.113.90" }))).status, 200);

      // A phone session can change its password too, keeping only itself.
      const phoneOwner = await seedOwner(client, "phone-change@example.invalid", PASSWORD_A);
      const phoneSession = await createMobileSession(phoneOwner);
      const otherWeb = await authAdapter.createSession!({ userId: phoneOwner, sessionToken: "other-web-session", expires: new Date(Date.now() + 3600000) });
      assert.ok(otherWeb);
      const phoneChange = await changeRoute(new NextRequest("http://localhost/api/account/password", {
        method: "POST",
        headers: { authorization: `Bearer ${phoneSession.token}`, "content-type": "application/json" },
        body: JSON.stringify({ currentPassword: PASSWORD_A, newPassword: PASSWORD_B })
      }));
      assert.equal(phoneChange.status, 200);
      assert.equal((await phoneChange.json()).revoked, 1);
      assert.equal((await client.query("SELECT count(*) n FROM auth_sessions WHERE token_hash=$1", [sessionHash(phoneSession.token)])).rows[0].n, "1");

      // --- The plaintext never lands in a database or a log --------------
      const passwords = [PASSWORD_A, PASSWORD_B, PASSWORD_C, PASSWORD_D, PASSWORD_E, CUSTOM_PARAM_PASSWORD, "synthetic-demo-password-159"];
      const tables = ["auth_users", "auth_accounts", "auth_sessions", "password_credentials", "password_reset_tokens", "password_throttle", "email_sign_in_codes", "sign_in_alerts"];
      for (const table of tables) {
        const rows = (await client.query(`SELECT * FROM ${table}`)).rows;
        const dump = JSON.stringify(rows);
        for (const password of passwords) assert.ok(!dump.includes(password), `the plaintext never reaches ${table}`);
      }
      const allLogs = captured.join("\n");
      for (const password of passwords) assert.ok(!allLogs.includes(password), "the plaintext never reaches a log line");
      assert.ok(!allLogs.includes("wrong-0-synthetic"), "a failed attempt is not logged either");
      assert.ok(allLogs.length > 0, "the capture actually saw log output");
    });
  } finally {
    stopCapture();
    (process.env as Record<string, string | undefined>).NODE_ENV = savedNodeEnv;
    delete process.env.SIGNUP_MODE;
    delete process.env.INVITED_EMAILS;
  }

  console.log("password sign-in tests passed");
}

main().catch(error => { stopCapture(); console.error(error); process.exitCode = 1; });
