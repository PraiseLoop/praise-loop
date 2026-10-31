import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from "jose";
import { verifyMicrosoftIdToken } from "../lib/microsoftIdToken";
import { resetFailures } from "../lib/mobileSignIn";
import { createMobileSession } from "../lib/mobileSessions";
import { sessionHash } from "../lib/auth-adapter";
import { databaseFixture } from "./db-fixture";

const CLIENT = "microsoft-client-id";
const SECOND_CLIENT = "microsoft-client-id-2";
const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const issuer = (tid: string) => `https://login.microsoftonline.com/${tid}/v2.0`;

async function main() {
  process.env.TRUST_PROXY_HEADERS = "1";
  process.env.MICROSOFT_CLIENT_ID = `${CLIENT}, ${SECOND_CLIENT}`;
  const good = await generateKeyPair("RS256"), other = await generateKeyPair("RS256"), wrongAlgorithm = await generateKeyPair("RS512");
  const jwk: JWK = { ...(await exportJWK(good.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  const localKeys = createLocalJWKSet({ keys: [jwk] });
  // Mock Microsoft: serve a test key set for the multi-tenant JWKS URL, refuse any other network call.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.equal(String(input), "https://login.microsoftonline.com/common/discovery/v2.0/keys", "unexpected network call");
    return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json", "cache-control": "max-age=300" } });
  }) as typeof fetch;

  const token = (claims: Record<string, unknown> = {}, o: { aud?: string; iss?: string; exp?: string | number; alg?: string; key?: CryptoKey; subject?: string | null; tid?: string } = {}) => {
    const jwt = new SignJWT({ email: "microsoft-owner@example.invalid", name: "Synthetic Microsoft Owner", tid: o.tid ?? TENANT, ...claims })
      .setProtectedHeader({ alg: o.alg ?? "RS256", kid: "test-key" })
      .setIssuer(o.iss ?? issuer(o.tid ?? TENANT))
      .setAudience(o.aud ?? CLIENT)
      .setIssuedAt()
      .setExpirationTime(o.exp ?? "1h");
    if (o.subject !== null) jwt.setSubject(o.subject ?? "microsoft-sub-1");
    return jwt.sign(o.key ?? good.privateKey);
  };
  const exchange = (idToken: unknown, ip = "203.0.113.20") =>
    (require("../app/api/mobile/session/microsoft/route").POST as (r: NextRequest) => Promise<Response>)(
      new NextRequest("http://localhost/api/mobile/session/microsoft", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({ idToken })
      }));

  try {
    // The verifier itself: RS256, audience, expiry, the v2.0 issuer pattern and
    // the issuer's tenant must all agree. The subject includes the tenant.
    assert.deepEqual(await verifyMicrosoftIdToken(await token(), localKeys), {
      subject: `${TENANT}:microsoft-sub-1`,
      email: "microsoft-owner@example.invalid",
      name: "Synthetic Microsoft Owner",
      emailVerified: false
    });
    assert.deepEqual(
      await verifyMicrosoftIdToken(await token({ email: "Microsoft-Owner@Example.Invalid" }, { aud: SECOND_CLIENT, subject: "microsoft-sub-2" }), localKeys),
      { subject: `${TENANT}:microsoft-sub-2`, email: "microsoft-owner@example.invalid", name: "Synthetic Microsoft Owner", emailVerified: false }
    );
    // preferred_username is the fallback, but only when it looks like an address.
    assert.equal((await verifyMicrosoftIdToken(await token({ email: undefined, preferred_username: "Alias@Example.Invalid" }), localKeys))?.email, "alias@example.invalid");
    assert.equal((await verifyMicrosoftIdToken(await token({ email: "not-an-address", preferred_username: "Alias@Example.Invalid" }), localKeys))?.email, "alias@example.invalid");
    assert.equal((await verifyMicrosoftIdToken(await token({ email: undefined, preferred_username: "not-an-email" }), localKeys))?.email, null);
    assert.equal((await verifyMicrosoftIdToken(await token({ name: undefined }), localKeys))?.name, null);

    for (const value of [
      await token({}, { aud: "someone-else.invalid" }),
      await token({}, { iss: "https://evil.invalid" }),
      await token({ tid: OTHER_TENANT }, { iss: issuer(TENANT) }),
      await token({ tid: undefined }, { iss: issuer(TENANT) }),
      await token({}, { exp: Math.floor(Date.now() / 1000) - 3600 }),
      await token({}, { key: other.privateKey }),
      await token({}, { alg: "RS512", key: wrongAlgorithm.privateKey }),
      await token({}, { subject: null }),
      "garbage"
    ]) assert.equal(await verifyMicrosoftIdToken(value, localKeys), null);
    delete process.env.MICROSOFT_CLIENT_ID;
    assert.equal(await verifyMicrosoftIdToken(await token(), localKeys), null, "missing audience fails closed");
    process.env.MICROSOFT_CLIENT_ID = `${CLIENT}, ${SECOND_CLIENT}`;

    await databaseFixture(async client => {
      // A new Microsoft subject creates one owner and records the method. The
      // address stays on the method row because it is not verified.
      const first = await exchange(await token());
      assert.equal(first.status, 200);
      const firstSession = await first.json();
      assert.equal(firstSession.token.length, 43);
      assert.equal((await client.query("SELECT kind FROM auth_sessions WHERE token_hash=$1", [sessionHash(firstSession.token)])).rows[0].kind, "mobile");
      const firstAccount = (await client.query("SELECT * FROM auth_accounts WHERE provider='microsoft'")).rows[0];
      assert.equal(firstAccount.provider_account_id, `${TENANT}:microsoft-sub-1`);
      assert.equal(firstAccount.email, "microsoft-owner@example.invalid");
      const firstOwner = (await client.query("SELECT name,email FROM auth_users WHERE id=$1", [firstAccount.owner_id])).rows[0];
      assert.deepEqual(firstOwner, { name: "Synthetic Microsoft Owner", email: null });

      // The same tenant and subject always reuse their owner, even when Microsoft
      // reports a different address on a later sign-in.
      const second = await exchange(await token({ email: "moved@example.invalid" }, { subject: "microsoft-sub-1" }));
      assert.equal(second.status, 200);
      assert.equal((await client.query("SELECT count(*)::int n FROM auth_users")).rows[0].n, 1);
      assert.equal((await client.query("SELECT email FROM auth_accounts WHERE provider_account_id=$1", [`${TENANT}:microsoft-sub-1`])).rows[0].email, "moved@example.invalid");

      // The same sub under a different tenant is a different owner, because the
      // tenant id is part of the subject.
      const otherTenant = await exchange(await token({ tid: OTHER_TENANT, email: "other@example.invalid" }, { subject: "microsoft-sub-1", tid: OTHER_TENANT }));
      assert.equal(otherTenant.status, 200);
      const otherAccount = (await client.query("SELECT owner_id FROM auth_accounts WHERE provider_account_id=$1", [`${OTHER_TENANT}:microsoft-sub-1`])).rows[0];
      assert.notEqual(otherAccount.owner_id, firstAccount.owner_id);
      assert.equal((await client.query("SELECT count(*)::int n FROM auth_users")).rows[0].n, 2);

      // A Microsoft address equal to an existing Google owner's address never
      // signs in as that owner (#156): it creates its own owner with no login email.
      await client.query(`INSERT INTO auth_users(id,name,email,"emailVerified") VALUES('google-owner','Google Owner','google-owner@example.invalid',now())`);
      await client.query("INSERT INTO auth_accounts(provider,provider_account_id,owner_id,email,created_at) VALUES('google','google-sub-x','google-owner','google-owner@example.invalid',now())");
      const sameEmail = await exchange(await token({ email: "google-owner@example.invalid" }, { subject: "microsoft-google-email" }));
      assert.equal(sameEmail.status, 200);
      const sameEmailAccount = (await client.query("SELECT owner_id,email FROM auth_accounts WHERE provider_account_id=$1", [`${TENANT}:microsoft-google-email`])).rows[0];
      assert.notEqual(sameEmailAccount.owner_id, "google-owner");
      assert.equal(sameEmailAccount.email, "google-owner@example.invalid");
      assert.equal((await client.query("SELECT email FROM auth_users WHERE id=$1", [sameEmailAccount.owner_id])).rows[0].email, null);
      assert.equal((await client.query("SELECT count(*)::int n FROM auth_accounts WHERE owner_id='google-owner'")).rows[0].n, 1);

      // Every invalid token is the same generic 401, with no session or owner
      // created. Each attempt starts a fresh limiter window.
      const sessionsBefore = (await client.query("SELECT count(*)::int AS n FROM auth_sessions")).rows[0].n;
      const ownersBefore = (await client.query("SELECT count(*)::int AS n FROM auth_users")).rows[0].n;
      const bad: [string, unknown][] = [
        ["wrong audience", await token({}, { aud: "someone-else.invalid" })],
        ["wrong issuer", await token({}, { iss: "https://evil.invalid" })],
        ["issuer tenant mismatch", await token({ tid: OTHER_TENANT }, { iss: issuer(TENANT) })],
        ["expired", await token({}, { exp: Math.floor(Date.now() / 1000) - 3600 })],
        ["bad signature", await token({}, { key: other.privateKey })],
        ["wrong algorithm", await token({}, { alg: "RS512", key: wrongAlgorithm.privateKey })],
        ["missing subject", await token({}, { subject: null })],
        ["missing tenant", await token({ tid: undefined }, { iss: issuer(TENANT) })],
        ["not a jwt", "garbage"], ["missing token", undefined], ["non-string token", 42]
      ];
      for (const [name, value] of bad) {
        resetFailures();
        const response = await exchange(value);
        assert.equal(response.status, 401, name);
        assert.deepEqual(await response.json(), { error: "Invalid Microsoft sign-in" }, name);
      }
      assert.equal((await client.query("SELECT count(*)::int AS n FROM auth_sessions")).rows[0].n, sessionsBefore);
      assert.equal((await client.query("SELECT count(*)::int AS n FROM auth_users")).rows[0].n, ownersBefore);

      // Failed attempts are limited per client; other clients are unaffected.
      resetFailures();
      for (let i = 0; i < 10; i++) assert.equal((await exchange("garbage", "198.51.100.20")).status, 401);
      assert.equal((await exchange("garbage", "198.51.100.20")).status, 429);
      assert.equal((await exchange(await token(), "198.51.100.20")).status, 429);
      assert.equal((await exchange(await token(), "198.51.100.21")).status, 200);

      // The body limit is enforced from the bytes read, without Content-Length.
      resetFailures();
      const big = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify({ idToken: "x".repeat(20000) }))); c.close(); } });
      const chunked = new NextRequest("http://localhost/api/mobile/session/microsoft", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.50" },
        body: big,
        duplex: "half"
      } as ConstructorParameters<typeof NextRequest>[1]);
      assert.equal((await require("../app/api/mobile/session/microsoft/route").POST(chunked)).status, 401);

      // A signed-in owner can link a Microsoft subject. The same subject linked to
      // another owner is refused, and one owner cannot hold two Microsoft subjects.
      await client.query(`INSERT INTO auth_users(id,name,email) VALUES('link-owner','Link Owner','link@example.invalid')`);
      const linkSession = await createMobileSession("link-owner");
      const linkRequest = (provider: unknown, idToken: unknown) => new NextRequest("http://localhost/api/account/methods", {
        method: "POST",
        headers: { authorization: `Bearer ${linkSession.token}`, "content-type": "application/json" },
        body: JSON.stringify({ provider, idToken })
      });
      const methodsRoute = require("../app/api/account/methods/route");
      const linked = await methodsRoute.POST(linkRequest("microsoft", await token({}, { subject: "microsoft-link-sub" })));
      assert.equal(linked.status, 200);
      assert.deepEqual((await linked.json()).methods.map((method: { provider: string }) => method.provider), ["microsoft"]);
      assert.equal((await methodsRoute.POST(linkRequest("microsoft", await token({}, { subject: "microsoft-link-sub" })))).status, 200, "linking is idempotent");
      assert.equal((await methodsRoute.POST(linkRequest("microsoft", await token({}, { subject: "microsoft-link-other" })))).status, 409);
      assert.equal((await methodsRoute.POST(linkRequest("microsoft", await token({}, { subject: "microsoft-sub-1" })))).status, 409, "a subject owned by somebody else cannot be taken");
      assert.equal((await methodsRoute.POST(linkRequest("microsoft", "not-a-token"))).status, 400);
      assert.equal((await client.query("SELECT count(*)::int n FROM auth_accounts WHERE provider='microsoft' AND owner_id='link-owner'")).rows[0].n, 1);

      // The web NextAuth callback applies the same policy. NextAuth's provider id
      // is `azure-ad`, while auth_accounts stores the canonical `microsoft` name;
      // the adapter maps the lookup so NextAuth finds the owner the policy wrote.
      const signIn = require("../lib/auth").authOptions.callbacks.signIn;
      assert.equal(await signIn({
        account: { provider: "azure-ad", providerAccountId: `${TENANT}:microsoft-web-sub` },
        profile: { tid: TENANT, sub: "microsoft-web-sub", email: "Web@Example.Invalid", name: "Web Microsoft Owner" }
      }), true);
      const webAccount = (await client.query("SELECT owner_id,email FROM auth_accounts WHERE provider='microsoft' AND provider_account_id=$1", [`${TENANT}:microsoft-web-sub`])).rows[0];
      assert.equal(webAccount.email, "web@example.invalid");
      assert.equal((await client.query("SELECT name,email FROM auth_users WHERE id=$1", [webAccount.owner_id])).rows[0].name, "Web Microsoft Owner");
      assert.equal((await client.query("SELECT email FROM auth_users WHERE id=$1", [webAccount.owner_id])).rows[0].email, null);
      const adapter = require("../lib/auth-adapter").authAdapter;
      assert.equal((await adapter.getUserByAccount({ provider: "azure-ad", providerAccountId: `${TENANT}:microsoft-web-sub` }))?.id, webAccount.owner_id);
      assert.equal(await signIn({
        account: { provider: "azure-ad", providerAccountId: "missing-tenant" },
        profile: { sub: "microsoft-web-sub" }
      }), false);
      assert.equal(await signIn({
        account: { provider: "azure-ad", providerAccountId: "missing-sub" },
        profile: { tid: TENANT }
      }), false);
      assert.equal(await signIn({
        account: { provider: "github", providerAccountId: "callback-github" },
        profile: { tid: TENANT, sub: "github-sub" }
      }), false, "an unknown provider fails closed");

      // Unconfigured audience fails closed at the route as well.
      delete process.env.MICROSOFT_CLIENT_ID;
      resetFailures();
      assert.equal((await exchange(await token())).status, 401);
      process.env.MICROSOFT_CLIENT_ID = `${CLIENT}, ${SECOND_CLIENT}`;

      assert.doesNotMatch(JSON.stringify((await client.query("SELECT * FROM auth_accounts")).rows), /eyJ/);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log("Microsoft sign-in exchange, linking and web callback tests passed");
}
main().catch(e => { console.error(e); process.exit(1); });
