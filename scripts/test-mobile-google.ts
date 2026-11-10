import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { databaseFixture } from "./db-fixture";
import { sessionHash } from "../lib/auth-adapter";
import { resetFailures } from "../lib/mobileSignIn";
import { flushSignInAlerts } from "../lib/signInAlerts";

const IOS = "ios-client.apps.googleusercontent.com", ANDROID = "android-client.apps.googleusercontent.com";
const ISS = "https://accounts.google.com";

async function main() {
  process.env.TRUST_PROXY_HEADERS = "1"; process.env.GOOGLE_IOS_CLIENT_ID = IOS; process.env.GOOGLE_ANDROID_CLIENT_ID = ANDROID;
  const good = await generateKeyPair("RS256"), other = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(good.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  // Mock Google: serve a test key set for the certs URL, refuse any other network call.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.equal(String(input), "https://www.googleapis.com/oauth2/v3/certs", "unexpected network call");
    return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json", "cache-control": "max-age=300" } });
  }) as typeof fetch;
  const logs: string[] = [];
  for (const level of ["log", "info", "warn", "error"] as const) { const orig = console[level]; console[level] = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); orig(...a); }; }

  const token = (claims: Record<string, unknown> = {}, o: { aud?: string; iss?: string; exp?: string | number; key?: CryptoKey } = {}) =>
    new SignJWT({ email: "owner@example.invalid", email_verified: true, name: "Synthetic Owner", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" }).setSubject("google-sub-1").setIssuer(o.iss ?? ISS)
      .setAudience(o.aud ?? IOS).setIssuedAt().setExpirationTime(o.exp ?? "1h").sign(o.key ?? good.privateKey);
  const exchange = (idToken: unknown, ip = "203.0.113.1") => (require("../app/api/mobile/session/route").POST as (r: NextRequest) => Promise<Response>)(
    new NextRequest("http://localhost/api/mobile/session", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify({ idToken }) }));

  await databaseFixture(async client => {
    const res = await exchange(await token());
    assert.equal(res.status, 200);
    const first = await res.json();
    assert.equal(first.token.length, 43);
    assert.equal((await client.query("SELECT kind FROM auth_sessions WHERE token_hash=$1", [sessionHash(first.token)])).rows[0].kind, "mobile");
    const account = (await client.query("SELECT * FROM auth_accounts")).rows;
    assert.equal(account.length, 1); assert.equal(account[0].provider, "google"); assert.equal(account[0].provider_account_id, "google-sub-1");
    // Android audience is accepted; a second sign-in reuses the owner.
    const second = await (await exchange(await token({}, { aud: ANDROID }))).json();
    assert.equal((await client.query("SELECT count(*)::int AS n FROM auth_users")).rows[0].n, 1);
    assert.equal((await client.query("SELECT count(DISTINCT owner_id)::int AS n FROM auth_sessions")).rows[0].n, 1);
    assert.notEqual(first.token, second.token);

    // Same businesses as on the web, via the bearer session.
    const ownerId = account[0].owner_id;
    const biz = (await client.query("INSERT INTO businesses(name,timezone,owner_id) VALUES('Web business','UTC',$1) RETURNING id", [ownerId])).rows[0].id;
    const list = await require("../app/api/businesses/route").GET(new NextRequest("http://localhost/api/businesses", { headers: { authorization: `Bearer ${second.token}` } }));
    assert.deepEqual((await list.json()).businesses.map((b: { id: string }) => b.id), [biz]);

    // A web owner (same verified email, no google account row yet) is linked, not duplicated.
    await client.query(`INSERT INTO auth_users(id,name,email) VALUES('web-owner','Web','web@example.invalid')`);
    const sub2 = await new SignJWT({ email: "web@example.invalid", email_verified: true }).setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setSubject("google-sub-2").setIssuer(ISS).setAudience(IOS).setIssuedAt().setExpirationTime("1h").sign(good.privateKey);
    assert.equal((await exchange(sub2)).status, 200);
    assert.equal((await client.query("SELECT owner_id FROM auth_accounts WHERE provider_account_id='google-sub-2'")).rows[0].owner_id, "web-owner");

    // A different Google subject with an already-linked email is rejected, not linked.
    const intruder = await new SignJWT({ email: "web@example.invalid", email_verified: true }).setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setSubject("google-sub-3").setIssuer(ISS).setAudience(IOS).setIssuedAt().setExpirationTime("1h").sign(good.privateKey);
    assert.equal((await exchange(intruder)).status, 401);
    assert.equal((await client.query("SELECT count(*)::int n FROM auth_accounts WHERE provider_account_id='google-sub-3'")).rows[0].n, 0);

    // Two different subjects racing on one unlinked email: exactly one links, the other is rejected.
    await client.query(`INSERT INTO auth_users(id,name,email) VALUES('race-owner','Race','race@example.invalid')`);
    const racer = (sub: string) => new SignJWT({ email: "race@example.invalid", email_verified: true }).setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setSubject(sub).setIssuer(ISS).setAudience(IOS).setIssuedAt().setExpirationTime("1h").sign(good.privateKey);
    const raced = await Promise.all([exchange(await racer("race-a"), "203.0.113.60"), exchange(await racer("race-b"), "203.0.113.61")]);
    assert.deepEqual(raced.map(r => r.status).sort(), [200, 401]);
    assert.equal((await client.query("SELECT count(*)::int n FROM auth_accounts WHERE owner_id='race-owner'")).rows[0].n, 1);

    // Rejections: all 401, no session or owner created.
    const sessionsBefore = (await client.query("SELECT count(*)::int AS n FROM auth_sessions")).rows[0].n;
    const bad: [string, unknown][] = [
      ["wrong audience", await token({}, { aud: "someone-else.apps.googleusercontent.com" })],
      ["wrong issuer", await token({}, { iss: "https://evil.invalid" })],
      ["expired", await token({}, { exp: Math.floor(Date.now() / 1000) - 3600 })],
      ["unverified email", await token({ email_verified: false })],
      ["missing email", await token({ email: undefined })],
      ["bad signature", await token({}, { key: other.privateKey })],
      ["not a jwt", "garbage"], ["missing token", undefined], ["non-string token", 42],
    ];
    for (const [name, value] of bad) { resetFailures(); assert.equal((await exchange(value)).status, 401, name); }
    assert.equal((await client.query("SELECT count(*)::int AS n FROM auth_sessions")).rows[0].n, sessionsBefore);

    // Failed attempts are rate limited per client; other clients and a good token are unaffected.
    resetFailures();
    for (let i = 0; i < 10; i++) assert.equal((await exchange("garbage", "198.51.100.9")).status, 401);
    assert.equal((await exchange("garbage", "198.51.100.9")).status, 429);
    assert.equal((await exchange(await token(), "198.51.100.9")).status, 429);
    assert.equal((await exchange(await token(), "198.51.100.10")).status, 200);

    // An oversized body is rejected from the bytes read, even when Content-Length is absent.
    resetFailures();
    const big = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify({ idToken: "x".repeat(20000) }))); c.close(); } });
    const chunked = new NextRequest("http://localhost/api/mobile/session", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.50" }, body: big, duplex: "half" } as ConstructorParameters<typeof NextRequest>[1]);
    assert.equal((await require("../app/api/mobile/session/route").POST(chunked)).status, 401);

    // Without a trusted proxy, spoofed IP headers cannot dodge the limiter: everyone shares one bucket.
    process.env.TRUST_PROXY_HEADERS = ""; resetFailures();
    for (let i = 0; i < 10; i++) assert.equal((await exchange("garbage", `192.0.2.${i}`)).status, 401);
    assert.equal((await exchange("garbage", "192.0.2.200")).status, 429);
    process.env.TRUST_PROXY_HEADERS = "1"; resetFailures();

    // Unconfigured audience list fails closed.
    delete process.env.GOOGLE_IOS_CLIENT_ID; delete process.env.GOOGLE_ANDROID_CLIENT_ID;
    assert.equal((await exchange(await token())).status, 401);

    await flushSignInAlerts();
    const out = logs.join("\n");
    assert.ok(!out.includes(first.token) && !out.includes(second.token) && !out.includes(await token().then(t => t.split(".")[2])), "no token in logs");
    assert.doesNotMatch(JSON.stringify((await client.query("SELECT * FROM auth_accounts")).rows), /eyJ/);
  });
  globalThis.fetch = realFetch;
  console.log("mobile Google sign-in exchange tests passed");
}
main().catch(e => { console.error(e); process.exit(1); });
