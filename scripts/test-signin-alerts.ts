import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { databaseFixture } from "./db-fixture";
import { clearEmailOutbox, emailOutbox, type EmailTransport } from "../lib/email";
import { resetEmailCodeThrottle } from "../lib/emailAuth";
import { resetFailures } from "../lib/mobileSignIn";
import { createMobileSession, resolveMobileSession } from "../lib/mobileSessions";
import {
  canonicalSignInMethod,
  deliverSignInAlert,
  describeSignInClient,
  flushSignInAlerts,
  formatSignInTime,
  newSignInEmail,
  signInMethodLabel
} from "../lib/signInAlerts";

const ORIGIN = "http://localhost:3000";
const IOS = "ios-client.apps.googleusercontent.com";
const GOOGLE_ISS = "https://accounts.google.com";
const APPLE_BUNDLE = "ca.visda.praiseloop";
const APPLE_ISS = "https://appleid.apple.com";
const MICROSOFT_CLIENT = "microsoft-client-id";
const TENANT = "11111111-1111-4111-8111-111111111111";
const WEB_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ANDROID_UA = "okhttp/4.12.0 (Linux; Android 14)";
const IPHONE_UA = "PraiseLoop/1.0 CFNetwork/1490 Darwin/23.0.0";
const ALERT_SUBJECT = "New sign-in to your Praise Loop account";

function alerts() {
  return emailOutbox().filter(message => message.subject === ALERT_SUBJECT);
}

function fresh() {
  clearEmailOutbox();
  resetEmailCodeThrottle();
  resetFailures();
}

function web(path: string, body: object, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "cf-connecting-ip": "203.0.113.70",
      "user-agent": WEB_UA,
      ...headers
    },
    body: JSON.stringify(body)
  });
}

function exchange(path: string, body: object, userAgent = ANDROID_UA, ip = "203.0.113.71") {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, "user-agent": userAgent },
    body: JSON.stringify(body)
  });
}

function lastCode() {
  const message = emailOutbox().at(-1);
  assert.ok(message, "a code email was queued");
  return /code is (\d{6})/.exec(message.text)![1];
}

function countingTransport() {
  const sent: { to: string; subject: string; text: string }[] = [];
  const transport: EmailTransport = {
    name: "fake",
    from: "Praise Loop <no-reply@praiseloop.invalid>",
    async send(envelope) {
      sent.push({ to: envelope.to, subject: envelope.subject, text: envelope.text });
      return { transport: "fake", accepted: true };
    }
  };
  return { sent, transport };
}

async function main() {
  process.env.NEXTAUTH_URL = ORIGIN;
  process.env.NEXTAUTH_SECRET = "synthetic-sign-in-alert-secret-for-tests-0123456789";
  process.env.TRUST_PROXY_HEADERS = "1";
  process.env.GOOGLE_IOS_CLIENT_ID = IOS;
  process.env.APPLE_CLIENT_ID = APPLE_BUNDLE;
  process.env.MICROSOFT_CLIENT_ID = MICROSOFT_CLIENT;
  process.env.MOBILE_DEV_AUTH = "1";
  delete process.env.EMAIL_TRANSPORT;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  const savedNodeEnv = process.env.NODE_ENV;
  (process.env as Record<string, string | undefined>).NODE_ENV = "development";

  const key = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(key.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  const realFetch = globalThis.fetch;
  const realConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const jwks = [
      "https://www.googleapis.com/oauth2/v3/certs",
      "https://appleid.apple.com/auth/keys",
      "https://login.microsoftonline.com/common/discovery/v2.0/keys"
    ];
    assert.ok(jwks.includes(url), `unexpected network call ${url}`);
    return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json", "cache-control": "max-age=300" } });
  }) as typeof fetch;

  const googleToken = (subject: string, email: string) =>
    new SignJWT({ email, email_verified: true, name: "Synthetic Alert Owner" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" }).setSubject(subject).setIssuer(GOOGLE_ISS)
      .setAudience(IOS).setIssuedAt().setExpirationTime("1h").sign(key.privateKey);
  const appleToken = (subject: string, email: string) =>
    new SignJWT({ email, email_verified: true })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" }).setSubject(subject).setIssuer(APPLE_ISS)
      .setAudience(APPLE_BUNDLE).setIssuedAt().setExpirationTime("1h").sign(key.privateKey);
  const microsoftToken = (subject: string, email: string) =>
    new SignJWT({ email, name: "Synthetic Microsoft Owner", tid: TENANT, oid: subject })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" }).setSubject(`${MICROSOFT_CLIENT}:${subject}`)
      .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`).setAudience(MICROSOFT_CLIENT)
      .setIssuedAt().setExpirationTime("1h").sign(key.privateKey);

  // --- Template and description: plain text, no tokens or codes. ---
  const at = new Date("2026-11-09T23:59:00Z");
  const template = newSignInEmail({
    method: "google",
    client: "web",
    userAgent: WEB_UA,
    at,
    timeZone: "America/Toronto",
    accountUrl: "https://dev.praiseloop.ca/account"
  });
  assert.equal(template.subject, ALERT_SUBJECT);
  assert.match(template.text, /Method: Google/);
  assert.match(template.text, /Client: Chrome on macOS/);
  assert.match(template.text, /Time: 2026-11-09 23:59 UTC/);
  assert.match(template.text, /America\/Toronto/);
  assert.match(template.text, /https:\/\/dev\.praiseloop\.ca\/account/);
  assert.match(template.text, /admin@praiseloop\.ca/);
  assert.doesNotMatch(template.text, /tok|code is|eyJ/i);
  assert.doesNotMatch(template.text, /<a\s|<img|https?:\/\/[^\s]+\.(png|jpg)/i);
  assert.ok(template.text.length < 700);
  assert.equal(canonicalSignInMethod("azure-ad"), "microsoft");
  assert.equal(canonicalSignInMethod("google"), "google");
  assert.equal(canonicalSignInMethod("not a provider"), null);
  assert.equal(signInMethodLabel("email"), "email code");
  assert.equal(describeSignInClient("mobile", ANDROID_UA), "Android phone app (Android)");
  assert.equal(describeSignInClient("mobile", IPHONE_UA), "iPhone app");
  assert.equal(describeSignInClient("web", "curl/8.0"), "web browser");
  assert.equal(formatSignInTime(at, "Not/AZone"), "2026-11-09 23:59 UTC");
  const hostile = newSignInEmail({ method: "google\r\nX-Evil: 1", client: "web", userAgent: "x".repeat(100_000), at, accountUrl: "javascript:alert(1)" });
  assert.match(hostile.text, /Method: unknown/);
  assert.doesNotMatch(hostile.text, /X-Evil|javascript:|x{500}/);

  await databaseFixture(async client => {
    const requestRoute = require("../app/api/auth/email/request/route").POST as (r: NextRequest) => Promise<Response>;
    const verifyRoute = require("../app/api/auth/email/verify/route").POST as (r: NextRequest) => Promise<Response>;
    const mobileEmail = require("../app/api/mobile/session/email/route").POST as (r: NextRequest) => Promise<Response>;
    const mobileGoogle = require("../app/api/mobile/session/route").POST as (r: NextRequest) => Promise<Response>;
    const mobileApple = require("../app/api/mobile/session/apple/route").POST as (r: NextRequest) => Promise<Response>;
    const mobileMicrosoft = require("../app/api/mobile/session/microsoft/route").POST as (r: NextRequest) => Promise<Response>;
    const mobileDev = require("../app/api/mobile/session/dev/route").POST as (r: Request) => Promise<Response>;
    const authOptions = require("../lib/auth").authOptions;
    const authAdapter = require("../lib/auth-adapter").authAdapter;

    // --- Web email code: exactly one alert after the session is created. ---
    fresh();
    const webEmail = "web-alert@example.invalid";
    assert.equal((await requestRoute(web("/api/auth/email/request", { email: webEmail }))).status, 200);
    const webCode = lastCode();
    const verified = await verifyRoute(web("/api/auth/email/verify", { email: webEmail, code: webCode }));
    assert.equal(verified.status, 200);
    const webToken = /next-auth\.session-token=([^;]+)/.exec(verified.headers.get("set-cookie") ?? "")![1];
    await flushSignInAlerts();
    const webAlerts = alerts();
    assert.equal(webAlerts.length, 1, "one alert for one new web session");
    assert.equal(webAlerts[0].to, webEmail);
    assert.match(webAlerts[0].text, /Method: email code/);
    assert.match(webAlerts[0].text, /Client: Chrome on macOS/);
    assert.ok(!webAlerts[0].text.includes(webCode), "no sign-in code in the alert");
    assert.ok(!webAlerts[0].text.includes(webToken), "no session token in the alert");

    // Refreshing the same web session never sends another alert.
    await authAdapter.updateSession!({ sessionToken: webToken, expires: new Date(Date.now() + 60 * 60 * 1000) });
    await flushSignInAlerts();
    assert.equal(alerts().length, 1, "an existing session refresh sends nothing");

    // --- Phone email code. ---
    fresh();
    const phoneEmail = "phone-alert@example.invalid";
    assert.equal((await requestRoute(web("/api/auth/email/request", { email: phoneEmail, ip: "203.0.113.72" }))).status, 200);
    const phoneCode = lastCode();
    const phone = await mobileEmail(exchange("/api/mobile/session/email", { email: phoneEmail, code: phoneCode }));
    assert.equal(phone.status, 200);
    const phoneToken = (await phone.json()).token;
    await flushSignInAlerts();
    assert.equal(alerts().length, 1, "one alert for one new phone session");
    assert.equal(alerts()[0].to, phoneEmail);
    assert.match(alerts()[0].text, /Method: email code/);
    assert.match(alerts()[0].text, /phone app/);
    assert.ok(!alerts()[0].text.includes(phoneCode) && !alerts()[0].text.includes(phoneToken), "no code or token in the alert");

    // --- Phone Google, Apple and Microsoft. ---
    fresh();
    const google = await mobileGoogle(exchange("/api/mobile/session", { idToken: await googleToken("alert-google-sub", "phone-google@example.invalid") }));
    assert.equal(google.status, 200);
    const googleBody = await google.json();
    await flushSignInAlerts();
    assert.equal(alerts().length, 1);
    assert.equal(alerts()[0].to, "phone-google@example.invalid");
    assert.match(alerts()[0].text, /Method: Google/);
    assert.match(alerts()[0].text, /Android phone app/);
    await resolveMobileSession(googleBody.token);
    await flushSignInAlerts();
    assert.equal(alerts().length, 1, "refreshing a phone session sends nothing");

    fresh();
    const apple = await mobileApple(exchange("/api/mobile/session/apple", { idToken: await appleToken("alert-apple-sub", "phone-apple@example.invalid") }, IPHONE_UA));
    assert.equal(apple.status, 200);
    await flushSignInAlerts();
    assert.equal(alerts().length, 1);
    assert.equal(alerts()[0].to, "phone-apple@example.invalid", "Apple's verified relay/address is eligible");
    assert.match(alerts()[0].text, /Method: Apple/);
    assert.match(alerts()[0].text, /iPhone app/);

    // Microsoft's address is not trusted, but an existing owner's verified address is.
    await client.query(`INSERT INTO auth_users(id,name,email,"emailVerified") VALUES('ms-alert-owner','Microsoft Alert','ms-owner@example.invalid',now())`);
    await client.query(
      "INSERT INTO auth_accounts(provider,provider_account_id,owner_id,email,created_at,last_used_at) VALUES('microsoft',$1,'ms-alert-owner','untrusted-ms@example.invalid',now(),now())",
      [`${TENANT}:alert-ms-sub`]
    );
    fresh();
    const microsoft = await mobileMicrosoft(exchange("/api/mobile/session/microsoft", { idToken: await microsoftToken("alert-ms-sub", "untrusted-ms@example.invalid") }));
    assert.equal(microsoft.status, 200);
    await flushSignInAlerts();
    assert.equal(alerts().length, 1);
    assert.equal(alerts()[0].to, "ms-owner@example.invalid", "Microsoft's own address is never used");
    assert.match(alerts()[0].text, /Method: Microsoft/);

    // --- Web NextAuth events: Google and Microsoft, after the session event. ---
    await client.query(`INSERT INTO auth_users(id,name,email,"emailVerified") VALUES('oauth-alert-owner','OAuth Alert','oauth-alert@example.invalid',now())`);
    fresh();
    await authOptions.events.signIn({
      user: { id: "oauth-alert-owner" },
      account: { provider: "google", providerAccountId: "oauth-alert-sub" }
    });
    await flushSignInAlerts();
    assert.equal(alerts().length, 1);
    assert.match(alerts()[0].text, /Method: Google/);
    assert.match(alerts()[0].text, /web browser|Chrome|Safari/, "NextAuth outside a request still gets a generic web client");
    await authOptions.events.signIn({
      user: { id: "oauth-alert-owner" },
      account: { provider: "azure-ad", providerAccountId: `${TENANT}:oauth-alert-ms` }
    });
    await flushSignInAlerts();
    assert.equal(alerts().length, 2);
    assert.match(alerts()[1].text, /Method: Microsoft/);

    // --- Dev sessions use the same hooks (and stay synthetic). ---
    fresh();
    const dev = await mobileDev(exchange("/api/mobile/session/dev", { owner: "email" }));
    assert.equal(dev.status, 200);
    await flushSignInAlerts();
    assert.equal(alerts().length, 1);
    assert.equal(alerts()[0].to, "demo-email@praiseloop.invalid");
    assert.match(alerts()[0].text, /Method: demo sign-in/);

    // --- Rate limit is per owner and method, and recovers after ten minutes. ---
    await client.query(`INSERT INTO auth_users(id,name,email,"emailVerified") VALUES('rate-alert-owner','Rate Alert','rate-alert@example.invalid',now())`);
    const { sent, transport } = countingTransport();
    const t0 = new Date("2026-11-09T12:00:00Z");
    await deliverSignInAlert({ ownerId: "rate-alert-owner", method: "google", client: "web", now: t0, transport });
    await deliverSignInAlert({ ownerId: "rate-alert-owner", method: "google", client: "web", now: new Date(t0.getTime() + 5 * 60_000), transport });
    assert.equal(sent.length, 1, "a second alert for the same method inside ten minutes is suppressed");
    await deliverSignInAlert({ ownerId: "rate-alert-owner", method: "microsoft", client: "web", now: new Date(t0.getTime() + 5 * 60_000), transport });
    assert.equal(sent.length, 2, "another method has its own budget");
    await deliverSignInAlert({ ownerId: "rate-alert-owner", method: "google", client: "web", now: new Date(t0.getTime() + 11 * 60_000), transport });
    assert.equal(sent.length, 3, "the budget recovers after ten minutes");
    assert.equal((await client.query("SELECT count(*)::int n FROM sign_in_alerts WHERE owner_id='rate-alert-owner'")).rows[0].n, 2);

    // Concurrent sign-ins in one window reserve only one row.
    await client.query(`INSERT INTO auth_users(id,name,email,"emailVerified") VALUES('race-alert-owner','Race Alert','race-alert@example.invalid',now())`);
    const race = countingTransport();
    await Promise.all([
      deliverSignInAlert({ ownerId: "race-alert-owner", method: "google", client: "web", now: t0, transport: race.transport }),
      deliverSignInAlert({ ownerId: "race-alert-owner", method: "google", client: "mobile", now: t0, transport: race.transport }),
      deliverSignInAlert({ ownerId: "race-alert-owner", method: "google", client: "web", now: t0, transport: race.transport })
    ]);
    assert.equal(race.sent.length, 1, "concurrent alerts send once");
    assert.equal((await client.query("SELECT count(*)::int n FROM sign_in_alerts WHERE owner_id='race-alert-owner'")).rows[0].n, 1);

    // Only verified addresses are used, once each: owner row plus Google and Apple methods.
    await client.query(`INSERT INTO auth_users(id,name,email,"emailVerified") VALUES('address-alert-owner','Address Alert','owner-address@example.invalid',now())`);
    for (const [provider, sub, email] of [
      ["google", "address-google", "google-alias@example.invalid"],
      ["google", "address-google-dupe", "OWNER-ADDRESS@example.invalid"],
      ["apple", "address-apple", "apple-relay@privaterelay.appleid.com"],
      ["microsoft", "address-microsoft", "untrusted-microsoft@example.invalid"]
    ]) {
      await client.query(
        "INSERT INTO auth_accounts(provider,provider_account_id,owner_id,email,created_at,last_used_at) VALUES($1,$2,'address-alert-owner',$3,now(),now())",
        [provider, sub, email]
      );
    }
    const addresses = countingTransport();
    await deliverSignInAlert({ ownerId: "address-alert-owner", method: "email", client: "web", now: t0, transport: addresses.transport });
    assert.deepEqual(addresses.sent.map(message => message.to).sort(), [
      "apple-relay@privaterelay.appleid.com",
      "google-alias@example.invalid",
      "owner-address@example.invalid"
    ]);

    // --- A send failure never breaks the sign-in that created the session. ---
    await client.query(`INSERT INTO auth_users(id,name,email,"emailVerified") VALUES('failure-alert-owner','Failure Alert','failure-alert@example.invalid',now())`);
    const failureLogs: string[] = [];
    console.error = (...args: unknown[]) => { failureLogs.push(args.map(String).join(" ")); };
    const savedTransport = process.env.EMAIL_TRANSPORT;
    const savedFrom = process.env.EMAIL_FROM;
    const savedKey = process.env.RESEND_API_KEY;
    try {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      process.env.EMAIL_TRANSPORT = "resend";
      delete process.env.EMAIL_FROM;
      delete process.env.RESEND_API_KEY;
      const session = await createMobileSession("failure-alert-owner", { method: "email", userAgent: ANDROID_UA });
      assert.equal(session.token.length, 43, "the session is still created");
      await flushSignInAlerts();
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = savedNodeEnv;
      if (savedTransport === undefined) delete process.env.EMAIL_TRANSPORT; else process.env.EMAIL_TRANSPORT = savedTransport;
      if (savedFrom === undefined) delete process.env.EMAIL_FROM; else process.env.EMAIL_FROM = savedFrom;
      if (savedKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = savedKey;
      console.error = realConsole.error;
    }
    const failureText = failureLogs.join("\n");
    assert.match(failureText, /sign_in_alert_failed/);
    assert.match(failureText, /email_unavailable/);
    assert.doesNotMatch(failureText, /failure-alert@example\.invalid/, "the address is never logged");
    assert.doesNotMatch(failureText, /eyJ|Bearer |token/i);

    // A direct send failure also resolves without throwing.
    const failing: EmailTransport = {
      name: "fake",
      from: "Praise Loop <no-reply@praiseloop.invalid>",
      async send() { throw new Error("synthetic transport failure with failure-alert@example.invalid"); }
    };
    await assert.doesNotReject(deliverSignInAlert({
      ownerId: "failure-alert-owner",
      method: "apple",
      client: "mobile",
      now: t0,
      transport: failing
    }));
  });

  globalThis.fetch = realFetch;
  (process.env as Record<string, string | undefined>).NODE_ENV = savedNodeEnv;
  console.log("new sign-in alert tests passed");
}

main().catch(error => { console.error(error); process.exit(1); });
