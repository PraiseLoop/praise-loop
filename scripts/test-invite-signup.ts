import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { databaseFixture } from "./db-fixture";
import { linkIdentityToOwner, signInWithIdentity } from "../lib/authLinking";
import { clearEmailOutbox, emailOutbox } from "../lib/email";
import { flushSignInAlerts } from "../lib/signInAlerts";
import { resetEmailCodeThrottle } from "../lib/emailAuth";
import { resetFailures } from "../lib/mobileSignIn";
import { INVITE_ONLY_MESSAGE } from "../lib/signupMessages";
import { resetSignupModeWarning } from "../lib/signupPolicy";

const ORIGIN = "http://localhost:3000";
const IOS = "ios-client.apps.googleusercontent.com";
const GOOGLE_ISS = "https://accounts.google.com";
const APPLE_BUNDLE = "ca.visda.praiseloop";
const APPLE_ISS = "https://appleid.apple.com";
const MICROSOFT_CLIENT = "microsoft-client-id";
const TENANT = "11111111-1111-4111-8111-111111111111";
const INVITED = "invited@example.invalid";
const STRANGER = "stranger@example.invalid";
const EXISTING = "unlisted-owner@example.invalid";
const RELAY = "relay-address@privaterelay.appleid.com";

function setInviteList(value: string) {
  process.env.SIGNUP_MODE = "invite";
  process.env.INVITED_EMAILS = value;
}

function clearInviteList() {
  process.env.SIGNUP_MODE = "open";
  delete process.env.INVITED_EMAILS;
}

async function main() {
  process.env.TRUST_PROXY_HEADERS = "1";
  process.env.NEXTAUTH_URL = ORIGIN;
  process.env.NEXTAUTH_SECRET = "synthetic-invite-signup-secret-for-tests-0123456789";
  process.env.GOOGLE_IOS_CLIENT_ID = IOS;
  process.env.APPLE_CLIENT_ID = APPLE_BUNDLE;
  process.env.MICROSOFT_CLIENT_ID = MICROSOFT_CLIENT;
  process.env.APP_ENV = "prod";
  delete process.env.LOG_LEVEL;
  delete process.env.EMAIL_TRANSPORT;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  setInviteList(`${INVITED}, Second@Example.invalid\nthird@example.invalid`);

  const key = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(key.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  // The JWKS fetches for the three verifiers are the only allowed network calls.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const jwks = ["https://www.googleapis.com/oauth2/v3/certs", "https://appleid.apple.com/auth/keys",
      "https://login.microsoftonline.com/common/discovery/v2.0/keys"];
    assert.ok(jwks.includes(url), `unexpected network call ${url}`);
    return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json", "cache-control": "max-age=300" } });
  }) as typeof fetch;

  const googleToken = (subject: string, email: string) =>
    new SignJWT({ email, email_verified: true, name: "Synthetic Invite Owner" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" }).setSubject(subject).setIssuer(GOOGLE_ISS)
      .setAudience(IOS).setIssuedAt().setExpirationTime("1h").sign(key.privateKey);

  const appleToken = (subject: string, email: string | null, verified = true) => {
    const claims = email === null ? { email_verified: verified } : { email, email_verified: verified };
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" }).setSubject(subject).setIssuer(APPLE_ISS)
      .setAudience(APPLE_BUNDLE).setIssuedAt().setExpirationTime("1h").sign(key.privateKey);
  };

  const microsoftToken = (subject: string, email: string) =>
    new SignJWT({ email, name: "Synthetic Microsoft Owner", tid: TENANT, oid: subject })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" }).setSubject(`${MICROSOFT_CLIENT}:${subject}`)
      .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`).setAudience(MICROSOFT_CLIENT)
      .setIssuedAt().setExpirationTime("1h").sign(key.privateKey);

  const exchange = (route: string, body: object, ip = "203.0.113.30") =>
    (require(route).POST as (r: NextRequest) => Promise<Response>)(
      new NextRequest("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify(body)
      }));

  try {
    await databaseFixture(async client => {
      const count = async (table: string) => Number((await client.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n);
      const snapshot = async () => ({
        users: await count("auth_users"),
        accounts: await count("auth_accounts"),
        sessions: await count("auth_sessions"),
        businesses: await count("businesses"),
        usage: await count("owner_usage")
      });
      const expectUnchanged = async (run: () => Promise<unknown>, label: string) => {
        const before = await snapshot();
        await run();
        assert.deepEqual(await snapshot(), before, `${label} must write no owner, method, session, business or usage row`);
      };

      // An invited Google address creates the owner and a mobile session.
      resetFailures();
      const invitedGoogle = await exchange("../app/api/mobile/session/route", { idToken: await googleToken("invited-google-sub", INVITED) });
      assert.equal(invitedGoogle.status, 200);
      const invitedGoogleBody = await invitedGoogle.json();
      assert.equal(invitedGoogleBody.token.length, 43);
      assert.equal(await count("auth_users"), 1);
      assert.equal(await count("auth_accounts"), 1);
      assert.equal(await count("auth_sessions"), 1);

      // An uninvited Google address is refused with the stable code and the message,
      // and nothing at all is written.
      resetFailures();
      await expectUnchanged(async () => {
        const refused = await exchange("../app/api/mobile/session/route", { idToken: await googleToken("stranger-google-sub", STRANGER) });
        assert.equal(refused.status, 403);
        assert.deepEqual(await refused.json(), { error: "invite_only", message: INVITE_ONLY_MESSAGE });
      }, "uninvited Google sign-up");

      // Microsoft uses the address the provider reported, even though that address is
      // never trusted for linking owners.
      resetFailures();
      const invitedMicrosoft = await exchange("../app/api/mobile/session/microsoft/route", { idToken: await microsoftToken("invited-ms-sub", "Second@Example.invalid") });
      assert.equal(invitedMicrosoft.status, 200);
      resetFailures();
      await expectUnchanged(async () => {
        const refused = await exchange("../app/api/mobile/session/microsoft/route", { idToken: await microsoftToken("stranger-ms-sub", STRANGER) });
        assert.equal(refused.status, 403);
        assert.equal((await refused.json()).error, "invite_only");
      }, "uninvited Microsoft sign-up");

      // Apple: a listed verified address is allowed, a listed but unverified one is
      // not, and a relay or missing address must itself be on the list.
      resetFailures();
      const invitedApple = await exchange("../app/api/mobile/session/apple/route", { idToken: await appleToken("invited-apple-sub", INVITED) });
      assert.equal(invitedApple.status, 200);
      resetFailures();
      await expectUnchanged(async () => {
        assert.equal((await exchange("../app/api/mobile/session/apple/route", { idToken: await appleToken("unverified-apple-sub", INVITED, false) })).status, 403);
        assert.equal((await exchange("../app/api/mobile/session/apple/route", { idToken: await appleToken("relay-apple-sub", RELAY) })).status, 403);
        assert.equal((await exchange("../app/api/mobile/session/apple/route", { idToken: await appleToken("no-email-apple-sub", null) })).status, 403);
      }, "uninvited Apple sign-ups");
      // Adding the relay address to the list lets that new Apple identity through.
      setInviteList(`${INVITED}, Second@Example.invalid\nthird@example.invalid, ${RELAY}`);
      resetFailures();
      assert.equal((await exchange("../app/api/mobile/session/apple/route", { idToken: await appleToken("relay-apple-sub", RELAY) })).status, 200);
      setInviteList(`${INVITED}, Second@Example.invalid\nthird@example.invalid`);

      // An existing owner who is not on the list keeps signing in, and linking a
      // second method from a live session is unaffected.
      await client.query(`INSERT INTO auth_users(id,name,email,"emailVerified") VALUES('unlisted-owner','Existing Owner',$1,now())`, [EXISTING]);
      await client.query(
        "INSERT INTO auth_accounts(provider,provider_account_id,owner_id,email,created_at) VALUES('google','existing-google-sub','unlisted-owner',$1,now())",
        [EXISTING]
      );
      assert.deepEqual(
        await signInWithIdentity({ provider: "google", subject: "existing-google-sub", email: EXISTING, emailVerified: true }),
        { ok: true, ownerId: "unlisted-owner" }
      );
      const linked = await linkIdentityToOwner("unlisted-owner", {
        provider: "microsoft", subject: "linked-ms-sub", email: "another@example.invalid", emailVerified: false
      });
      assert.equal(linked.ok, true);
      assert.deepEqual(linked.ok && linked.methods.map(method => method.provider).sort(), ["google", "microsoft"]);
      assert.deepEqual(
        await signInWithIdentity(
          { provider: "apple", subject: "linked-apple-sub", email: null, emailVerified: true },
          { linkToOwner: "unlisted-owner" }
        ),
        { ok: true, ownerId: "unlisted-owner" }
      );
      assert.equal(await count("auth_accounts"), 7, "the invited owners plus the existing owner's three methods");

      // The email-code request route reveals nothing: invited, uninvited and existing
      // addresses get the same status, body and work (a message is queued for each).
      resetEmailCodeThrottle();
      clearEmailOutbox();
      const requestRoute = require("../app/api/auth/email/request/route").POST as (r: NextRequest) => Promise<Response>;
      const requestFor = (email: string, ip: string) => new NextRequest("http://localhost/api/auth/email/request", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({ email })
      });
      const timings: number[] = [];
      const replies = [];
      for (const [email, ip] of [[INVITED, "198.51.100.1"], [STRANGER, "198.51.100.2"], [EXISTING, "198.51.100.3"]] as const) {
        const started = Date.now();
        replies.push(await requestRoute(requestFor(email, ip)));
        timings.push(Date.now() - started);
      }
      const bodies = await Promise.all(replies.map(reply => reply.json()));
      assert.deepEqual(replies.map(reply => reply.status), [200, 200, 200]);
      assert.deepEqual(bodies, [bodies[0], bodies[0], bodies[0]]);
      assert.equal(emailOutbox().length, 3, "every address does the same send work");
      // The fake transport and local Postgres make the three paths the same class of
      // work; nothing short-circuits an invited, uninvited or existing address.
      assert.ok(timings.every(ms => ms < 2000), `request timings ${timings.join(", ")}ms`);

      // A valid code for an invited new address creates the owner.
      const lastCode = () => {
        const message = [...emailOutbox()].reverse().find(entry => /code is (\d{6})/.test(entry.text));
        assert.ok(message, "a code email was queued");
        return /code is (\d{6})/.exec(message.text)![1];
      };
      const webVerify = require("../app/api/auth/email/verify/route").POST as (r: NextRequest) => Promise<Response>;
      const verifyRequest = (email: string, code: string) => new NextRequest("http://localhost/api/auth/email/verify", {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": "198.51.100.10" },
        body: JSON.stringify({ email, code })
      });
      resetEmailCodeThrottle();
      assert.equal((await requestRoute(requestFor(INVITED, "198.51.100.11"))).status, 200);
      assert.equal((await webVerify(verifyRequest(INVITED, lastCode()))).status, 200);

      // The same valid flow for a brand-new uninvited address is the only place the
      // refusal appears, and it creates no owner, method or session.
      resetEmailCodeThrottle();
      assert.equal((await requestRoute(requestFor(STRANGER, "198.51.100.12"))).status, 200);
      const strangerCode = lastCode();
      await expectUnchanged(async () => {
        const refused = await webVerify(verifyRequest(STRANGER, strangerCode));
        assert.equal(refused.status, 403);
        assert.deepEqual(await refused.json(), { error: "invite_only", message: INVITE_ONLY_MESSAGE });
      }, "uninvited email-code sign-up");

      // An existing owner who is not on the list can still sign in with a code.
      resetEmailCodeThrottle();
      assert.equal((await requestRoute(requestFor(EXISTING, "198.51.100.13"))).status, 200);
      const existingCode = lastCode();
      const existingReply = await webVerify(verifyRequest(EXISTING, existingCode));
      assert.equal(existingReply.status, 200);
      const cookie = existingReply.headers.get("set-cookie") ?? "";
      const token = /next-auth\.session-token=([^;]+)/.exec(cookie)![1];
      const { sessionHash } = require("../lib/auth-adapter");
      const sessionOwner = (await client.query("SELECT owner_id FROM auth_sessions WHERE token_hash=$1", [sessionHash(token)])).rows[0].owner_id;
      assert.equal(sessionOwner, "unlisted-owner");

      // The phone email route returns the same code and message.
      resetEmailCodeThrottle();
      const mobileEmail = require("../app/api/mobile/session/email/route").POST as (r: NextRequest) => Promise<Response>;
      assert.equal((await requestRoute(requestFor("phone-stranger@example.invalid", "198.51.100.14"))).status, 200);
      const phoneCode = lastCode();
      await expectUnchanged(async () => {
        const refused = await mobileEmail(new NextRequest("http://localhost/api/mobile/session/email", {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.15" },
          body: JSON.stringify({ email: "phone-stranger@example.invalid", code: phoneCode })
        }));
        assert.equal(refused.status, 403);
        assert.equal((await refused.json()).error, "invite_only");
      }, "uninvited phone email-code sign-up");

      // Open mode is unchanged: an unlisted new address creates an owner.
      clearInviteList();
      const open = await signInWithIdentity({ provider: "google", subject: "open-mode-sub", email: "open@example.invalid", emailVerified: true });
      assert.equal(open.ok, true);
      setInviteList(`${INVITED}`);

      // An invalid mode fails closed to invite, warns exactly once per process and
      // still writes nothing for an uninvited new address.
      process.env.SIGNUP_MODE = "sometimes";
      resetSignupModeWarning();
      const logs: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
      try {
        await expectUnchanged(async () => {
          assert.deepEqual(
            await signInWithIdentity({ provider: "google", subject: "invalid-mode-1", email: "invalid-1@example.invalid", emailVerified: true }),
            { ok: false, reason: "invite_only" }
          );
          assert.deepEqual(
            await signInWithIdentity({ provider: "google", subject: "invalid-mode-2", email: "invalid-2@example.invalid", emailVerified: true }),
            { ok: false, reason: "invite_only" }
          );
        }, "invalid-mode sign-ups");
      } finally {
        console.error = originalError;
      }
      const joined = logs.join("\n");
      assert.equal(logs.filter(line => line.includes("signup_mode_invalid")).length, 1, "one warning for an invalid mode");
      assert.equal(logs.filter(line => line.includes("signup_refused")).length, 2);
      assert.equal(
        logs.filter(line => line.includes(createHash("sha256").update("invalid-1@example.invalid").digest("hex").slice(0, 12))).length,
        1,
        "the refusal carries a short address hash"
      );
      for (const email of [INVITED, STRANGER, EXISTING, "invalid-1@example.invalid", "invalid-2@example.invalid"]) {
        assert.ok(!joined.includes(email), "no address in a refusal log");
      }
      setInviteList(`${INVITED}, Second@Example.invalid\nthird@example.invalid`);

      // The web NextAuth callback applies the same rule: a new uninvited Google
      // identity redirects back with the code, an invited one and a returning
      // identity are allowed.
      const signIn = require("../lib/auth").authOptions.callbacks.signIn;
      resetSignupModeWarning();
      assert.equal(await signIn({
        account: { provider: "google", providerAccountId: "web-stranger-sub" },
        profile: { email: STRANGER, email_verified: true, name: "Stranger" }
      }), `${ORIGIN}/?error=invite_only`, "NextAuth must redirect a refused sign-up");
      assert.equal((await client.query("SELECT count(*)::int n FROM auth_accounts WHERE provider_account_id='web-stranger-sub'")).rows[0].n, 0);
      assert.equal(await signIn({
        account: { provider: "google", providerAccountId: "web-invited-sub" },
        profile: { email: "Second@Example.invalid", email_verified: true, name: "Invited" }
      }), true);
      assert.equal(await signIn({
        account: { provider: "google", providerAccountId: "existing-google-sub" },
        profile: { email: EXISTING, email_verified: true, name: "Existing" }
      }), true);
      await flushSignInAlerts();
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  clearInviteList();
  console.log("invite-only sign-up tests passed");
}
main().catch(error => { console.error(error); process.exit(1); });
