import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { databaseFixture } from "./db-fixture";
import { sessionHash } from "../lib/auth-adapter";
import { clearEmailOutbox, emailOutbox } from "../lib/email";
import { resetEmailCodeThrottle } from "../lib/emailAuth";
import { createMobileSession, revokeSession } from "../lib/mobileSessions";
import { resetFailures } from "../lib/mobileSignIn";
import { STEP_UP_TTL_MS, requireRecentStepUp } from "../lib/stepUp";

const ORIGIN = "http://localhost:3000";
const STEP_REQUEST = "/api/account/step-up/request";
const STEP_VERIFY = "/api/account/step-up/verify";
const SIGNIN_REQUEST = "/api/auth/email/request";
const SIGNIN_VERIFY = "/api/auth/email/verify";

function fresh() {
  clearEmailOutbox();
  resetEmailCodeThrottle();
  resetFailures();
}

function post(path: string, token: string | undefined, body: object | undefined, ip = "203.0.113.50") {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: ORIGIN,
    "cf-connecting-ip": ip
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

function codeFrom(text: string) {
  const match = /code is (\d{6})/.exec(text);
  assert.ok(match, "the message contains a six-digit code");
  return match[1];
}

function lastCode() {
  const message = emailOutbox().at(-1);
  assert.ok(message, "an email was queued");
  return codeFrom(message.text);
}

function wrongCodeFor(code: string) {
  return code === "000000" ? "111111" : "000000";
}

function expectDenied(value: Response | null): Response {
  assert.ok(value, "expected a denial response");
  return value;
}

async function main() {
  process.env.NEXTAUTH_URL = ORIGIN;
  process.env.NEXTAUTH_SECRET = "synthetic-step-up-secret-for-tests-0123456789";
  process.env.TRUST_PROXY_HEADERS = "1";
  delete process.env.EMAIL_TRANSPORT;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  const savedNodeEnv = process.env.NODE_ENV;
  (process.env as Record<string, string | undefined>).NODE_ENV = "development";

  const requestRoute = require("../app/api/account/step-up/request/route").POST as (r: NextRequest) => Promise<Response>;
  const verifyRoute = require("../app/api/account/step-up/verify/route").POST as (r: NextRequest) => Promise<Response>;
  const signInRequest = require("../app/api/auth/email/request/route").POST as (r: NextRequest) => Promise<Response>;
  const signInVerify = require("../app/api/auth/email/verify/route").POST as (r: NextRequest) => Promise<Response>;

  assert.equal(STEP_UP_TTL_MS, 10 * 60 * 1000, "the step-up window is ten minutes in one constant");

  await databaseFixture(async client => {
    const addOwner = async (id: string, email: string | null) => {
      await client.query("INSERT INTO auth_users(id,name,email) VALUES($1,$2,$3)", [id, id, email]);
    };
    const newSession = async (owner: string) => {
      const created = await createMobileSession(owner);
      return { owner, kind: "mobile" as const, token: created.token };
    };

    // Anonymous requests are refused, both through the guard and by the helper itself.
    fresh();
    assert.equal((await requestRoute(post(STEP_REQUEST, undefined, {}))).status, 401);
    assert.equal((await verifyRoute(post(STEP_VERIFY, undefined, { code: "123456" }))).status, 401);
    assert.equal(expectDenied(await requireRecentStepUp(null)).status, 401);
    assert.equal(expectDenied(await requireRecentStepUp()).status, 401);

    // A signed-in owner with an address needs a step-up before the helper passes.
    await addOwner("core-owner", "core@example.invalid");
    const core = await newSession("core-owner");
    const before = expectDenied(await requireRecentStepUp(core));
    assert.equal(before.status, 403);
    assert.deepEqual(await before.json(), { error: "step_up_required" });

    // The address comes from auth_users, never from the request body, and the
    // response never echoes it.
    fresh();
    const sent = await requestRoute(post(STEP_REQUEST, core.token, { email: "attacker@example.invalid" }));
    assert.equal(sent.status, 200);
    const sentBody = await sent.json() as { ok: boolean; method: string };
    assert.equal(sentBody.ok, true);
    assert.equal(sentBody.method, "email");
    assert.doesNotMatch(JSON.stringify(sentBody), /core@example\.invalid/);
    const message = emailOutbox().at(-1)!;
    assert.equal(message.to, "core@example.invalid");
    assert.match(message.subject, /confirmation code/i);
    const coreCode = codeFrom(message.text);
    const stored = (await client.query("SELECT purpose,code_hash,attempts FROM email_sign_in_codes WHERE email='core@example.invalid'")).rows[0];
    assert.equal(stored.purpose, "step_up");
    assert.equal(stored.code_hash.length, 64);
    assert.ok(!JSON.stringify(stored).includes(coreCode), "the step-up code is not stored in plain text");

    // A wrong code is rejected and counted, then the right one marks this session.
    assert.equal((await verifyRoute(post(STEP_VERIFY, core.token, { code: wrongCodeFor(coreCode) }))).status, 400);
    assert.equal((await client.query("SELECT attempts FROM email_sign_in_codes WHERE email='core@example.invalid' AND purpose='step_up'")).rows[0].attempts, 1);
    const verified = await verifyRoute(post(STEP_VERIFY, core.token, { code: coreCode }));
    assert.equal(verified.status, 200);
    assert.deepEqual(await verified.json(), { ok: true });
    assert.equal(await requireRecentStepUp(core), null);
    assert.ok((await client.query("SELECT step_up_at FROM auth_sessions WHERE token_hash=$1", [sessionHash(core.token)])).rows[0].step_up_at);

    // Another open session of the same owner is not marked by that step-up.
    const coreSecond = await newSession("core-owner");
    const secondDenied = expectDenied(await requireRecentStepUp(coreSecond));
    assert.equal(secondDenied.status, 403);
    assert.deepEqual(await secondDenied.json(), { error: "step_up_required" });
    assert.equal((await client.query("SELECT step_up_at FROM auth_sessions WHERE token_hash=$1", [sessionHash(coreSecond.token)])).rows[0].step_up_at, null);

    // The check lasts ten minutes: nine is still fresh, eleven is stale.
    await client.query("UPDATE auth_sessions SET step_up_at=now()-interval '9 minutes' WHERE token_hash=$1", [sessionHash(core.token)]);
    assert.equal(await requireRecentStepUp(core), null);
    await client.query("UPDATE auth_sessions SET step_up_at=now()-interval '11 minutes' WHERE token_hash=$1", [sessionHash(core.token)]);
    const stale = expectDenied(await requireRecentStepUp(core));
    assert.equal(stale.status, 403);
    assert.deepEqual(await stale.json(), { error: "step_up_required" });

    // Signing out deletes the marked session, and a new session starts without it.
    await client.query("UPDATE auth_sessions SET step_up_at=now() WHERE token_hash=$1", [sessionHash(core.token)]);
    await revokeSession(core.token);
    assert.equal(expectDenied(await requireRecentStepUp(core)).status, 401, "the signed-out session is gone");
    const coreFresh = await newSession("core-owner");
    const freshDenied = expectDenied(await requireRecentStepUp(coreFresh));
    assert.equal(freshDenied.status, 403, "a new session needs its own step-up");
    assert.deepEqual(await freshDenied.json(), { error: "step_up_required" });

    // An expired code is rejected.
    await addOwner("expired-owner", "expired@example.invalid");
    const expiredSession = await newSession("expired-owner");
    fresh();
    assert.equal((await requestRoute(post(STEP_REQUEST, expiredSession.token, {}))).status, 200);
    const expiredCode = lastCode();
    await client.query("UPDATE email_sign_in_codes SET expires_at=now()-interval '1 minute' WHERE email='expired@example.invalid' AND purpose='step_up'");
    assert.equal((await verifyRoute(post(STEP_VERIFY, expiredSession.token, { code: expiredCode }))).status, 400);
    const expiredDenied = await requireRecentStepUp(expiredSession);
    assert.ok(expiredDenied, "an expired code does not mark the session");
    assert.equal(expiredDenied.status, 403);

    // Five wrong guesses consume the code, even if the right one follows.
    await addOwner("attempts-owner", "attempts@example.invalid");
    const attemptsSession = await newSession("attempts-owner");
    fresh();
    assert.equal((await requestRoute(post(STEP_REQUEST, attemptsSession.token, {}))).status, 200);
    const attemptsCode = lastCode();
    const wrong = wrongCodeFor(attemptsCode);
    for (let i = 0; i < 5; i++) {
      assert.equal((await verifyRoute(post(STEP_VERIFY, attemptsSession.token, { code: wrong }))).status, 400);
    }
    assert.equal((await verifyRoute(post(STEP_VERIFY, attemptsSession.token, { code: attemptsCode }))).status, 400);
    assert.equal((await client.query("SELECT attempts FROM email_sign_in_codes WHERE email='attempts@example.invalid' AND purpose='step_up'")).rows[0].attempts, 5);

    // Requests are throttled per address; the extra attempt gets the same answer
    // and sends nothing.
    await addOwner("throttle-owner", "throttle@example.invalid");
    const throttleSession = await newSession("throttle-owner");
    fresh();
    for (let i = 0; i < 5; i++) {
      assert.equal((await requestRoute(post(STEP_REQUEST, throttleSession.token, {}))).status, 200);
    }
    assert.equal(emailOutbox().length, 5);
    assert.equal((await requestRoute(post(STEP_REQUEST, throttleSession.token, {}))).status, 200);
    assert.equal(emailOutbox().length, 5, "the sixth request sends nothing");

    // A step-up code belongs to the owner it was sent to, and the two purposes
    // never accept each other's codes.
    await addOwner("cross-a", "cross-a@example.invalid");
    await addOwner("cross-b", "cross-b@example.invalid");
    const crossA = await newSession("cross-a");
    const crossB = await newSession("cross-b");
    fresh();
    assert.equal((await requestRoute(post(STEP_REQUEST, crossA.token, {}))).status, 200);
    const stepCode = lastCode();
    assert.equal((await verifyRoute(post(STEP_VERIFY, crossB.token, { code: stepCode }))).status, 400, "another owner cannot use the code");
    assert.equal((await signInVerify(post(SIGNIN_VERIFY, undefined, { email: "cross-a@example.invalid", code: stepCode }))).status, 400, "a step-up code is not a sign-in code");
    assert.equal((await signInRequest(post(SIGNIN_REQUEST, undefined, { email: "cross-a@example.invalid" }))).status, 200);
    const signInCode = lastCode();
    assert.equal((await verifyRoute(post(STEP_VERIFY, crossA.token, { code: signInCode }))).status, 400, "a sign-in code is not a step-up code");
    // The sign-in request only superseded its own purpose, so the step-up code still works.
    assert.equal((await verifyRoute(post(STEP_VERIFY, crossA.token, { code: stepCode }))).status, 200);
    assert.equal((await signInVerify(post(SIGNIN_VERIFY, undefined, { email: "cross-a@example.invalid", code: signInCode }))).status, 200, "sign-in itself is unchanged");

    // An owner with no auth_users.email (Apple or Microsoft) cannot receive a code.
    // They pass only while their session is under ten minutes old.
    await addOwner("noemail-owner", null);
    const noEmail = await newSession("noemail-owner");
    assert.equal(await requireRecentStepUp(noEmail), null, "a fresh session without an address passes");
    fresh();
    const recentRequest = await requestRoute(post(STEP_REQUEST, noEmail.token, {}));
    assert.equal(recentRequest.status, 200);
    assert.equal((await recentRequest.json()).method, "recent_sign_in");
    assert.equal(emailOutbox().length, 0, "no message is attempted without an address");
    const noEmailVerify = await verifyRoute(post(STEP_VERIFY, noEmail.token, { code: "123456" }));
    assert.equal(noEmailVerify.status, 403);
    assert.deepEqual(await noEmailVerify.json(), { error: "sign_in_again" });
    await client.query("UPDATE auth_sessions SET created_at=now()-interval '11 minutes' WHERE token_hash=$1", [sessionHash(noEmail.token)]);
    const staleNoEmail = expectDenied(await requireRecentStepUp(noEmail));
    assert.equal(staleNoEmail.status, 403);
    assert.deepEqual(await staleNoEmail.json(), { error: "sign_in_again" });
    const staleNoEmailRequest = await requestRoute(post(STEP_REQUEST, noEmail.token, {}));
    assert.equal(staleNoEmailRequest.status, 403);
    assert.deepEqual(await staleNoEmailRequest.json(), { error: "sign_in_again" });
  });

  (process.env as Record<string, string | undefined>).NODE_ENV = savedNodeEnv;
  delete process.env.NEXTAUTH_SECRET;
  delete process.env.TRUST_PROXY_HEADERS;
  delete process.env.NEXTAUTH_URL;
  console.log("step-up code tests passed");
}

main().catch(error => { console.error(error); process.exit(1); });
