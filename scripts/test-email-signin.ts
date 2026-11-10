import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { databaseFixture } from "./db-fixture";
import { sessionHash } from "../lib/auth-adapter";
import { EmailError, clearEmailOutbox, emailOutbox, sendEmail } from "../lib/email";
import { normalizeEmail, resetEmailCodeThrottle } from "../lib/emailAuth";
import { findOrCreateGoogleOwner, resetFailures } from "../lib/mobileSignIn";
import { flushSignInAlerts } from "../lib/signInAlerts";

const ORIGIN = "http://localhost:3000";

async function fresh() {
  await flushSignInAlerts();
  clearEmailOutbox();
  resetEmailCodeThrottle();
  resetFailures();
}

function lastCode() {
  const message = [...emailOutbox()].reverse().find(entry => /code is (\d{6})/.test(entry.text));
  assert.ok(message, "an email was queued");
  return /code is (\d{6})/.exec(message.text)![1];
}

function web(path: string, body: object, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": "203.0.113.10", ...headers },
    body: JSON.stringify(body)
  });
}

// A wrong code that is guaranteed not to be the real one, so a random code can
// never make a rejection test pass by accident.
function wrongCodeFor(code: string) {
  return code === "000000" ? "111111" : "000000";
}

function mobile(body: object, ip = "203.0.113.20") {
  return new NextRequest("http://localhost/api/mobile/session/email", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(body)
  });
}

async function main() {
  process.env.NEXTAUTH_URL = ORIGIN;
  process.env.NEXTAUTH_SECRET = "synthetic-email-sign-in-secret-for-tests-0123456789";
  process.env.TRUST_PROXY_HEADERS = "1";
  delete process.env.EMAIL_TRANSPORT;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  const savedNodeEnv = process.env.NODE_ENV;
  (process.env as Record<string, string | undefined>).NODE_ENV = "development";

  // An email-only deployment has no Google credentials. NextAuth must still answer
  // session/sign-out requests, or the email session's sign-out button cannot revoke it.
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  const { authConfigured, authOptions } = require("../lib/auth");
  assert.equal(authConfigured(), true);
  assert.equal(authOptions.providers.length, 0);

  assert.equal(normalizeEmail("  Owner@Example.INVALID "), "owner@example.invalid");
  assert.equal(normalizeEmail("not-an-address"), null);
  assert.equal(normalizeEmail(42), null);

  const request = require("../app/api/auth/email/request/route").POST as (r: NextRequest) => Promise<Response>;
  const verify = require("../app/api/auth/email/verify/route").POST as (r: NextRequest) => Promise<Response>;
  const mobileVerify = require("../app/api/mobile/session/email/route").POST as (r: NextRequest) => Promise<Response>;

  await databaseFixture(async client => {
    const count = async (sql: string, values: unknown[] = []) => Number((await client.query(sql, values)).rows[0].n);

    // A new address gets the same generic answer as an unknown one, and the code is
    // stored only as a keyed hash.
    await fresh();
    const first = await request(web("/api/auth/email/request", { email: "  New@Example.invalid " }));
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.ok, true);
    assert.ok(!JSON.stringify(firstBody).includes("new@example.invalid"), "response does not echo the address");
    const code = lastCode();
    assert.match(code, /^\d{6}$/);
    const stored = (await client.query("SELECT * FROM email_sign_in_codes")).rows[0];
    assert.equal(stored.email, "new@example.invalid");
    assert.equal(stored.code_hash.length, 64);
    assert.notEqual(stored.code_hash, code);
    assert.ok(!JSON.stringify(stored).includes(code), "the code is not stored in plain text");

    // A wrong code is rejected and counted; the correct one then signs the owner in
    // with the same hashed session row the Google flow uses.
    const wrong = await verify(web("/api/auth/email/verify", { email: "new@example.invalid", code: wrongCodeFor(code) }));
    assert.equal(wrong.status, 400);
    assert.equal((await client.query("SELECT attempts FROM email_sign_in_codes")).rows[0].attempts, 1);
    const success = await verify(web("/api/auth/email/verify", { email: "new@example.invalid", code }));
    assert.equal(success.status, 200);
    const cookie = success.headers.get("set-cookie") ?? "";
    assert.match(cookie, /next-auth\.session-token=/);
    assert.match(cookie, /HttpOnly/i);
    const token = /next-auth\.session-token=([^;]+)/.exec(cookie)![1];
    const session = (await client.query("SELECT owner_id,kind FROM auth_sessions WHERE token_hash=$1", [sessionHash(token)])).rows[0];
    assert.equal(session.kind, "web");
    const owner = (await client.query("SELECT * FROM auth_users WHERE id=$1", [session.owner_id])).rows[0];
    assert.equal(owner.email, "new@example.invalid");
    assert.ok(owner.emailVerified);
    const account = (await client.query("SELECT * FROM auth_accounts WHERE owner_id=$1", [session.owner_id])).rows[0];
    assert.equal(account.provider, "email");
    assert.equal(account.provider_account_id, "new@example.invalid");
    // It goes through the shared linking policy (#156), so the method records when it was added and used.
    assert.equal(account.email, "new@example.invalid");
    assert.ok(account.created_at && account.last_used_at, "the email method has its added and last-used times");

    // A code is single use.
    assert.equal((await verify(web("/api/auth/email/verify", { email: "new@example.invalid", code }))).status, 400);

    // A newer request invalidates the older code.
    await fresh();
    assert.equal((await request(web("/api/auth/email/request", { email: "supersede@example.invalid" }))).status, 200);
    const oldCode = lastCode();
    assert.equal((await request(web("/api/auth/email/request", { email: "supersede@example.invalid" }))).status, 200);
    const newCode = lastCode();
    assert.notEqual(oldCode, newCode);
    assert.equal((await verify(web("/api/auth/email/verify", { email: "supersede@example.invalid", code: oldCode }))).status, 400);
    assert.equal((await verify(web("/api/auth/email/verify", { email: "supersede@example.invalid", code: newCode }))).status, 200);

    // Two requests for one address at once leave exactly one live code, not two.
    await fresh();
    const concurrent = await Promise.all([
      request(web("/api/auth/email/request", { email: "concurrent@example.invalid" })),
      request(web("/api/auth/email/request", { email: "concurrent@example.invalid" }))
    ]);
    assert.deepEqual(concurrent.map(r => r.status), [200, 200]);
    assert.equal(await count("SELECT count(*)::int n FROM email_sign_in_codes WHERE email='concurrent@example.invalid' AND consumed_at IS NULL AND superseded_at IS NULL"), 1);
    const concurrentCodes = emailOutbox()
      .filter(message => /code is (\d{6})/.test(message.text))
      .map(message => /code is (\d{6})/.exec(message.text)![1]);
    assert.equal(concurrentCodes.length, 2);
    const concurrentResults = [];
    for (const value of concurrentCodes) {
      concurrentResults.push((await verify(web("/api/auth/email/verify", { email: "concurrent@example.invalid", code: value }))).status);
    }
    assert.deepEqual(concurrentResults.sort(), [200, 400]);

    // An expired code is rejected.
    await fresh();
    assert.equal((await request(web("/api/auth/email/request", { email: "expired@example.invalid" }))).status, 200);
    const expiredCode = lastCode();
    await client.query("UPDATE email_sign_in_codes SET expires_at=now()-interval '1 minute' WHERE email='expired@example.invalid'");
    assert.equal((await verify(web("/api/auth/email/verify", { email: "expired@example.invalid", code: expiredCode }))).status, 400);

    // The email transport has its own hourly budget (five per recipient), which a request can hit before
    // the request limiter does. A request whose message cannot be sent must not invalidate the code that
    // was already delivered.
    await fresh();
    for (let i = 0; i < 5; i++) {
      resetEmailCodeThrottle();
      assert.equal((await request(web("/api/auth/email/request", { email: "budget@example.invalid" }))).status, 200);
    }
    const deliveredCode = lastCode();
    resetEmailCodeThrottle();
    const sentBefore = emailOutbox().length;
    assert.equal((await request(web("/api/auth/email/request", { email: "budget@example.invalid" }))).status, 200, "the same answer when nothing could be sent");
    assert.equal(emailOutbox().length, sentBefore, "no sixth message went out");
    assert.equal((await verify(web("/api/auth/email/verify", { email: "budget@example.invalid", code: deliveredCode }))).status, 200, "the delivered code still signs in");

    // Five wrong guesses kill the code, even if the right one follows.
    await fresh();
    assert.equal((await request(web("/api/auth/email/request", { email: "guesses@example.invalid" }))).status, 200);
    const guessedCode = lastCode();
    const wrongGuess = wrongCodeFor(guessedCode);
    for (let i = 0; i < 5; i++) {
      assert.equal((await verify(web("/api/auth/email/verify", { email: "guesses@example.invalid", code: wrongGuess }))).status, 400);
    }
    assert.equal((await verify(web("/api/auth/email/verify", { email: "guesses@example.invalid", code: guessedCode }))).status, 400);
    assert.equal((await client.query("SELECT attempts,consumed_at FROM email_sign_in_codes WHERE email='guesses@example.invalid'")).rows[0].attempts, 5);

    // A new code resets its own guess count, so wrong guesses are also capped per address across codes.
    for (let round = 0; round < 3; round++) {
      await fresh();
      assert.equal((await request(web("/api/auth/email/request", { email: "grind@example.invalid" }))).status, 200);
      const grindWrong = wrongCodeFor(lastCode());
      for (let i = 0; i < 5; i++) {
        assert.equal((await verify(web("/api/auth/email/verify", { email: "grind@example.invalid", code: grindWrong }))).status, 400);
      }
    }
    await fresh();
    assert.equal((await request(web("/api/auth/email/request", { email: "grind@example.invalid" }))).status, 200);
    const lockedCode = lastCode();
    assert.equal((await verify(web("/api/auth/email/verify", { email: "grind@example.invalid", code: lockedCode }))).status, 400,
      "the right code is refused once the address has used up its guesses");
    assert.equal((await client.query("SELECT attempts FROM email_sign_in_codes WHERE email='grind@example.invalid' ORDER BY id DESC LIMIT 1")).rows[0].attempts, 0, "a refused attempt is not counted again");
    // Once the window has passed the same address can sign in again.
    await client.query("UPDATE email_sign_in_codes SET created_at=created_at-interval '2 hours' WHERE email='grind@example.invalid' AND id < (SELECT max(id) FROM email_sign_in_codes WHERE email='grind@example.invalid')");
    assert.equal((await verify(web("/api/auth/email/verify", { email: "grind@example.invalid", code: lockedCode }))).status, 200);

    // An address already known as a Google owner keeps one owner and gains an email
    // method; the existing businesses are untouched.
    await client.query(`INSERT INTO auth_users(id,name,email,"emailVerified") VALUES('google-owner','Google Owner','google@example.invalid',now())`);
    await client.query("INSERT INTO auth_accounts(provider,provider_account_id,owner_id) VALUES('google','google-sub-1','google-owner')");
    await client.query("INSERT INTO businesses(name,timezone,owner_id) VALUES('Google business','UTC','google-owner')");
    await fresh();
    assert.equal((await request(web("/api/auth/email/request", { email: "google@example.invalid" }))).status, 200);
    const linkedCode = lastCode();
    const linked = await verify(web("/api/auth/email/verify", { email: "google@example.invalid", code: linkedCode }));
    assert.equal(linked.status, 200);
    const linkedToken = /next-auth\.session-token=([^;]+)/.exec(linked.headers.get("set-cookie") ?? "")![1];
    const linkedOwner = (await client.query("SELECT owner_id FROM auth_sessions WHERE token_hash=$1", [sessionHash(linkedToken)])).rows[0].owner_id;
    assert.equal(linkedOwner, "google-owner");
    assert.equal(await count("SELECT count(*)::int n FROM auth_users WHERE email='google@example.invalid'"), 1);
    assert.equal(await count("SELECT count(*)::int n FROM auth_accounts WHERE owner_id='google-owner'"), 2);
    assert.equal(await count("SELECT count(*)::int n FROM businesses WHERE owner_id='google-owner'"), 1);

    // A reassigned Google subject with the same email is still rejected (#116/#117), so
    // it cannot inherit the owner's data. The verified email code is the documented
    // recovery path instead.
    assert.equal(await findOrCreateGoogleOwner({ sub: "google-sub-2", email: "google@example.invalid", name: "Intruder" }), null);
    assert.equal(await count("SELECT count(*)::int n FROM auth_accounts WHERE provider='google' AND provider_account_id='google-sub-2'"), 0);

    // A different address never attaches to that owner.
    await fresh();
    assert.equal((await request(web("/api/auth/email/request", { email: "other@example.invalid" }))).status, 200);
    const otherCode = lastCode();
    assert.equal((await verify(web("/api/auth/email/verify", { email: "other@example.invalid", code: otherCode }))).status, 200);
    assert.equal(await count("SELECT count(*)::int n FROM auth_accounts WHERE owner_id='google-owner'"), 2);
    assert.equal(await count("SELECT count(*)::int n FROM auth_users WHERE email='other@example.invalid'"), 1);

    // Two verifications of one code race: exactly one session is created.
    await fresh();
    assert.equal((await request(web("/api/auth/email/request", { email: "race@example.invalid" }))).status, 200);
    const raceCode = lastCode();
    const raced = await Promise.all([
      verify(web("/api/auth/email/verify", { email: "race@example.invalid", code: raceCode }, { "cf-connecting-ip": "198.51.100.1" })),
      verify(web("/api/auth/email/verify", { email: "race@example.invalid", code: raceCode }, { "cf-connecting-ip": "198.51.100.2" }))
    ]);
    assert.deepEqual(raced.map(r => r.status).sort(), [200, 400]);

    // A cookie-minting request must be same-origin.
    await fresh();
    assert.equal((await request(web("/api/auth/email/request", { email: "csrf@example.invalid" }))).status, 200);
    const csrfCode = lastCode();
    assert.equal((await verify(web("/api/auth/email/verify", { email: "csrf@example.invalid", code: csrfCode }, { origin: "" }))).status, 403);
    assert.equal((await verify(web("/api/auth/email/verify", { email: "csrf@example.invalid", code: csrfCode }, { origin: "https://evil.invalid" }))).status, 403);
    assert.equal((await verify(web("/api/auth/email/verify", { email: "csrf@example.invalid", code: csrfCode }))).status, 200);

    // The phone gets a normal bearer session. A wrong code is a 400, never a 401,
    // because the app treats 401 as an ended session and would clear its token.
    await fresh();
    assert.equal((await request(web("/api/auth/email/request", { email: "phone@example.invalid" }))).status, 200);
    const phoneCode = lastCode();
    assert.equal((await mobileVerify(mobile({ email: "phone@example.invalid", code: wrongCodeFor(phoneCode) }))).status, 400);
    const phone = await mobileVerify(mobile({ email: "phone@example.invalid", code: phoneCode }, "198.51.100.20"));
    assert.equal(phone.status, 200);
    const phoneBody = await phone.json();
    assert.equal(phoneBody.token.length, 43);
    assert.equal((await client.query("SELECT kind FROM auth_sessions WHERE token_hash=$1", [sessionHash(phoneBody.token)])).rows[0].kind, "mobile");

    // Unknown and known addresses get byte-identical answers.
    await fresh();
    const unknownBody = await (await request(web("/api/auth/email/request", { email: "nobody@example.invalid" }))).json();
    const knownBody = await (await request(web("/api/auth/email/request", { email: "phone@example.invalid" }))).json();
    assert.deepEqual(knownBody, unknownBody);

    // Request throttling: the sixth request for one address sends nothing more.
    await fresh();
    for (let i = 0; i < 5; i++) assert.equal((await request(web("/api/auth/email/request", { email: "throttle@example.invalid" }))).status, 200);
    assert.equal(emailOutbox().length, 5);
    assert.equal((await request(web("/api/auth/email/request", { email: "throttle@example.invalid" }))).status, 200);
    assert.equal(emailOutbox().length, 5);

    // The transport itself refuses to spam one recipient.
    await fresh();
    for (let i = 0; i < 5; i++) await sendEmail({ to: "transport@example.invalid", subject: "Test", text: "Synthetic" });
    await assert.rejects(
      sendEmail({ to: "transport@example.invalid", subject: "Test", text: "Synthetic" }),
      (error: unknown) => error instanceof EmailError && error.code === "email_throttled"
    );

    // A malformed address is rejected before anything is stored or sent.
    await fresh();
    assert.equal((await request(web("/api/auth/email/request", { email: "not-an-address" }))).status, 400);
    assert.equal(emailOutbox().length, 0);

    // Missing configuration fails closed with a clear message, without touching the body.
    await fresh();
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    assert.equal((await request(web("/api/auth/email/request", { email: "config@example.invalid" }))).status, 503);
    assert.equal((await mobileVerify(mobile({ email: "config@example.invalid", code: "123456" }))).status, 503);
    process.env.EMAIL_FROM = "PraiseLoop <signin@example.invalid>";
    process.env.RESEND_API_KEY = "re_test_only";
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";

    // A missing session secret also fails closed.
    const secret = process.env.NEXTAUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    assert.equal((await request(web("/api/auth/email/request", { email: "nosecret@example.invalid" }))).status, 503);
    process.env.NEXTAUTH_SECRET = secret;
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;

    // The code never reaches a log line.
    await fresh();
    const logs: string[] = [];
    const original = { log: console.log, info: console.info, error: console.error };
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    console.info = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    try {
      assert.equal((await request(web("/api/auth/email/request", { email: "logs@example.invalid" }))).status, 200);
      const logCode = lastCode();
      assert.equal((await verify(web("/api/auth/email/verify", { email: "logs@example.invalid", code: logCode }))).status, 200);
      // The fake transport records the code in its dev-only outbox line; nothing
      // else may log it.
      const leaked = logs.filter(line => line.includes(logCode) && !line.startsWith("email_outbox "));
      assert.deepEqual(leaked, [], "only the fake outbox may record the code");
    } finally {
      console.log = original.log;
      console.info = original.info;
      console.error = original.error;
    }
    await flushSignInAlerts();
  });

  (process.env as Record<string, string | undefined>).NODE_ENV = savedNodeEnv;
  delete process.env.NEXTAUTH_SECRET;
  delete process.env.TRUST_PROXY_HEADERS;
  delete process.env.EMAIL_TRANSPORT;
  delete process.env.NEXTAUTH_URL;
  console.log("email sign-in tests passed");
}

main().catch(error => { console.error(error); process.exit(1); });
