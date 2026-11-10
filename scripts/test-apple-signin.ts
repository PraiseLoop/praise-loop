import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { verifyAppleIdToken } from "../lib/appleIdToken";
import { resetFailures } from "../lib/mobileSignIn";
import { flushSignInAlerts } from "../lib/signInAlerts";
import { createMobileSession } from "../lib/mobileSessions";
import { sessionHash } from "../lib/auth-adapter";
import { databaseFixture } from "./db-fixture";

const BUNDLE = "ca.visda.praiseloop";
const ISS = "https://appleid.apple.com";
const RELAY = "relay-address@privaterelay.appleid.com";

async function main() {
  process.env.TRUST_PROXY_HEADERS = "1";
  process.env.APPLE_CLIENT_ID = BUNDLE;
  const good = await generateKeyPair("RS256"), other = await generateKeyPair("RS256"), wrongAlgorithm = await generateKeyPair("RS512");
  const jwk: JWK = { ...(await exportJWK(good.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  // Mock Apple: serve a test key set for the JWKS URL, refuse any other network call.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.equal(String(input), "https://appleid.apple.com/auth/keys", "unexpected network call");
    return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json", "cache-control": "max-age=300" } });
  }) as typeof fetch;

  const token = (claims: Record<string, unknown> = {}, o: { aud?: string; iss?: string; exp?: string | number; alg?: string; key?: CryptoKey; subject?: string | null } = {}) => {
    const jwt = new SignJWT({ email: "apple-owner@example.invalid", email_verified: true, ...claims })
      .setProtectedHeader({ alg: o.alg ?? "RS256", kid: "test-key" }).setIssuer(o.iss ?? ISS)
      .setAudience(o.aud ?? BUNDLE).setIssuedAt().setExpirationTime(o.exp ?? "1h");
    if (o.subject !== null) jwt.setSubject(o.subject ?? "apple-sub-1");
    return jwt.sign(o.key ?? good.privateKey);
  };
  const exchange = (idToken: unknown, fullName?: unknown, ip = "203.0.113.10") =>
    (require("../app/api/mobile/session/apple/route").POST as (r: NextRequest) => Promise<Response>)(
      new NextRequest("http://localhost/api/mobile/session/apple", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify(fullName === undefined ? { idToken } : { idToken, fullName })
      }));

  try {
    // The verifier itself: issuer, audience, expiry, signature and algorithm are
    // all required, and the name never comes from the token.
    assert.deepEqual(await verifyAppleIdToken(await token()), { subject: "apple-sub-1", email: "apple-owner@example.invalid", emailVerified: true });
    assert.deepEqual(
      await verifyAppleIdToken(await token({ email_verified: "true" }, { subject: "apple-sub-2" })),
      { subject: "apple-sub-2", email: "apple-owner@example.invalid", emailVerified: true }
    );
    assert.deepEqual(
      await verifyAppleIdToken(await token({ email: undefined }, { subject: "apple-sub-3" })),
      { subject: "apple-sub-3", email: null, emailVerified: true }
    );
    for (const value of [
      await token({}, { aud: "someone-else.invalid" }),
      await token({}, { iss: "https://evil.invalid" }),
      await token({}, { exp: Math.floor(Date.now() / 1000) - 3600 }),
      await token({}, { key: other.privateKey }),
      await token({}, { alg: "RS512", key: wrongAlgorithm.privateKey }),
      await token({}, { subject: null }),
      "garbage"
    ]) assert.equal(await verifyAppleIdToken(value), null);
    delete process.env.APPLE_CLIENT_ID;
    assert.equal(await verifyAppleIdToken(await token()), null, "missing audience fails closed");
    process.env.APPLE_CLIENT_ID = BUNDLE;

    await databaseFixture(async client => {
      // A new Apple subject creates one owner and records the method.
      const first = await exchange(await token(), "  Ada Apple  ");
      assert.equal(first.status, 200);
      const firstSession = await first.json();
      assert.equal(firstSession.token.length, 43);
      assert.equal((await client.query("SELECT kind FROM auth_sessions WHERE token_hash=$1", [sessionHash(firstSession.token)])).rows[0].kind, "mobile");
      const firstAccount = (await client.query("SELECT * FROM auth_accounts WHERE provider='apple'")).rows[0];
      assert.equal(firstAccount.provider_account_id, "apple-sub-1");
      assert.equal(firstAccount.email, "apple-owner@example.invalid");
      const firstOwner = (await client.query("SELECT name,email FROM auth_users WHERE id=$1", [firstAccount.owner_id])).rows[0];
      // Apple is not a trusted-email provider, so the owner row keeps no login address (like any provider
      // whose claim cannot select an existing owner); the address stays on the method row.
      assert.deepEqual(firstOwner, { name: "Ada Apple", email: null });

      // The same subject always reuses its owner, even when Apple reports a
      // different address on a later sign-in.
      const second = await exchange(await token({ email: "moved@example.invalid" }, { subject: "apple-sub-1" }));
      assert.equal(second.status, 200);
      assert.equal((await client.query("SELECT count(*)::int n FROM auth_users")).rows[0].n, 1);
      assert.equal((await client.query("SELECT email FROM auth_accounts WHERE provider_account_id='apple-sub-1'")).rows[0].email, "moved@example.invalid");

      // A private-relay address never auto-links an existing Google owner.
      await client.query(`INSERT INTO auth_users(id,name,email,"emailVerified") VALUES('google-owner','Google Owner','google-owner@example.invalid',now())`);
      await client.query("INSERT INTO auth_accounts(provider,provider_account_id,owner_id,email,created_at) VALUES('google','google-sub-x','google-owner','google-owner@example.invalid',now())");
      const relay = await exchange(await token({ email: RELAY }, { subject: "apple-relay-sub" }));
      assert.equal(relay.status, 200);
      const relayAccount = (await client.query("SELECT owner_id,email FROM auth_accounts WHERE provider_account_id='apple-relay-sub'")).rows[0];
      assert.notEqual(relayAccount.owner_id, "google-owner");
      assert.equal(relayAccount.email, RELAY);
      assert.equal((await client.query("SELECT email FROM auth_users WHERE id=$1", [relayAccount.owner_id])).rows[0].email, null);
      assert.equal((await client.query("SELECT count(*)::int n FROM auth_accounts WHERE owner_id='google-owner'")).rows[0].n, 1);

      // Apple never links by email, even for a real verified address that matches an existing
      // owner (#92: no account linking): it creates its own owner. Linking is done from a session.
      await client.query(`INSERT INTO auth_users(id,name,email,"emailVerified") VALUES('real-owner','Real Owner','real-owner@example.invalid',now())`);
      assert.equal((await exchange(await token({ email: "real-owner@example.invalid" }, { subject: "apple-real-sub" }))).status, 200);
      const realAccount = (await client.query("SELECT owner_id FROM auth_accounts WHERE provider_account_id='apple-real-sub'")).rows[0];
      assert.notEqual(realAccount.owner_id, "real-owner");
      assert.equal((await client.query("SELECT count(*)::int n FROM auth_accounts WHERE owner_id='real-owner'")).rows[0].n, 0);

      // Apple's first-sign-in name fills a missing name, is capped, and never
      // replaces a name the owner edited.
      const longName = "  " + "A".repeat(120) + "  ";
      const named = await exchange(await token({ email: "named@example.invalid" }, { subject: "apple-named-sub" }), longName);
      assert.equal(named.status, 200);
      assert.equal((await client.query("SELECT u.name FROM auth_users u JOIN auth_accounts a ON a.owner_id=u.id WHERE a.provider_account_id='apple-named-sub'")).rows[0].name, "A".repeat(80));
      await client.query("UPDATE auth_users SET name='Owner Chosen', name_source='owner' WHERE id=(SELECT owner_id FROM auth_accounts WHERE provider_account_id='apple-named-sub')");
      assert.equal((await exchange(await token({ email: "named@example.invalid" }, { subject: "apple-named-sub" }), "Apple Again")).status, 200);
      assert.equal((await client.query("SELECT u.name FROM auth_users u JOIN auth_accounts a ON a.owner_id=u.id WHERE a.provider_account_id='apple-named-sub'")).rows[0].name, "Owner Chosen");

      // Every invalid token is the same generic 401, with no session or owner
      // created. Each attempt starts a fresh limiter window.
      const sessionsBefore = (await client.query("SELECT count(*)::int AS n FROM auth_sessions")).rows[0].n;
      const bad: [string, unknown][] = [
        ["wrong audience", await token({}, { aud: "someone-else.invalid" })],
        ["wrong issuer", await token({}, { iss: "https://evil.invalid" })],
        ["expired", await token({}, { exp: Math.floor(Date.now() / 1000) - 3600 })],
        ["bad signature", await token({}, { key: other.privateKey })],
        ["wrong algorithm", await token({}, { alg: "RS512", key: wrongAlgorithm.privateKey })],
        ["missing subject", await token({}, { subject: null })],
        ["not a jwt", "garbage"], ["missing token", undefined], ["non-string token", 42]
      ];
      for (const [name, value] of bad) {
        resetFailures();
        const response = await exchange(value);
        assert.equal(response.status, 401, name);
        assert.deepEqual(await response.json(), { error: "Invalid Apple sign-in" }, name);
      }
      assert.equal((await client.query("SELECT count(*)::int AS n FROM auth_sessions")).rows[0].n, sessionsBefore);

      // Failed attempts are limited per client; other clients are unaffected.
      resetFailures();
      for (let i = 0; i < 10; i++) assert.equal((await exchange("garbage", undefined, "198.51.100.9")).status, 401);
      assert.equal((await exchange("garbage", undefined, "198.51.100.9")).status, 429);
      assert.equal((await exchange(await token(), undefined, "198.51.100.9")).status, 429);
      assert.equal((await exchange(await token(), undefined, "198.51.100.10")).status, 200);

      // The body limit is enforced from the bytes read, without Content-Length.
      resetFailures();
      const big = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify({ idToken: "x".repeat(20000) }))); c.close(); } });
      const chunked = new NextRequest("http://localhost/api/mobile/session/apple", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.50" },
        body: big,
        duplex: "half"
      } as ConstructorParameters<typeof NextRequest>[1]);
      assert.equal((await require("../app/api/mobile/session/apple/route").POST(chunked)).status, 401);

      // A signed-in owner can link an Apple subject, including a relay address.
      await client.query(`INSERT INTO auth_users(id,name,email) VALUES('link-owner','Link Owner','link@example.invalid')`);
      const linkSession = await createMobileSession("link-owner");
      const linkRequest = (provider: unknown, idToken: unknown) => new NextRequest("http://localhost/api/account/methods", {
        method: "POST",
        headers: { authorization: `Bearer ${linkSession.token}`, "content-type": "application/json" },
        body: JSON.stringify({ provider, idToken })
      });
      const methodsRoute = require("../app/api/account/methods/route");
      const linked = await methodsRoute.POST(linkRequest("apple", await token({ email: RELAY }, { subject: "apple-link-sub" })));
      assert.equal(linked.status, 200);
      assert.deepEqual((await linked.json()).methods.map((method: { provider: string }) => method.provider), ["apple"]);
      assert.equal((await methodsRoute.POST(linkRequest("apple", await token({ email: RELAY }, { subject: "apple-link-sub" })))).status, 200, "linking is idempotent");
      // A second Apple subject for the same owner, or one owned by somebody else,
      // is refused rather than moved.
      assert.equal((await methodsRoute.POST(linkRequest("apple", await token({ email: "another@example.invalid" }, { subject: "apple-link-other" })))).status, 409);
      assert.equal((await methodsRoute.POST(linkRequest("apple", await token({}, { subject: "apple-sub-1" })))).status, 409);
      assert.equal((await methodsRoute.POST(linkRequest("apple", "not-a-token"))).status, 400);
      assert.equal((await methodsRoute.POST(linkRequest("microsoft", "not-a-token"))).status, 400);
      assert.equal((await client.query("SELECT count(*)::int n FROM auth_accounts WHERE provider='apple' AND owner_id='link-owner'")).rows[0].n, 1);

      // Unconfigured audience fails closed at the route as well.
      delete process.env.APPLE_CLIENT_ID;
      resetFailures();
      assert.equal((await exchange(await token())).status, 401);
      process.env.APPLE_CLIENT_ID = BUNDLE;

      await flushSignInAlerts();
      assert.doesNotMatch(JSON.stringify((await client.query("SELECT * FROM auth_accounts")).rows), /eyJ/);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log("Apple sign-in exchange and linking tests passed");
}
main().catch(e => { console.error(e); process.exit(1); });
