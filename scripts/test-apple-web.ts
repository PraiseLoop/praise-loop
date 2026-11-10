import assert from "node:assert/strict";
import { decodeJwt, decodeProtectedHeader, exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import {
  APPLE_CLIENT_SECRET_TTL_SECONDS,
  APPLE_ISSUER,
  appleWebConfig,
  createAppleClientSecret,
  normaliseApplePrivateKey
} from "../lib/appleClientSecret";
import { databaseFixture } from "./db-fixture";

const NEXTAUTH_URL = "https://dev.praiseloop.example";
const SERVICES_ID = "ca.visda.praiseloop.web";
const TEAM_ID = "TEAM123456";
const KEY_ID = "KEY1234567";
const RELAY = "relay-address@privaterelay.appleid.com";

type AuthModule = typeof import("../lib/auth");

function loadAuth(): AuthModule {
  // lib/auth decides which providers exist at import time, so tests that change
  // the environment must load a fresh copy.
  const path = require.resolve("../lib/auth");
  delete require.cache[path];
  return require(path) as AuthModule;
}

function setAppleEnv(privateKey: string) {
  process.env.APPLE_WEB_CLIENT_ID = SERVICES_ID;
  process.env.APPLE_TEAM_ID = TEAM_ID;
  process.env.APPLE_KEY_ID = KEY_ID;
  process.env.APPLE_PRIVATE_KEY = privateKey;
}

function clearAppleEnv() {
  delete process.env.APPLE_WEB_CLIENT_ID;
  delete process.env.APPLE_TEAM_ID;
  delete process.env.APPLE_KEY_ID;
  delete process.env.APPLE_PRIVATE_KEY;
}

async function main() {
  process.env.NEXTAUTH_URL = NEXTAUTH_URL;
  process.env.NEXTAUTH_SECRET = "synthetic-apple-web-secret-for-tests-0123456789";
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.MICROSOFT_CLIENT_ID;
  delete process.env.MICROSOFT_CLIENT_SECRET;

  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const pkcs8 = await exportPKCS8(privateKey);
  // Environment files and Compose commonly carry the key with escaped newlines.
  const envKey = pkcs8.replace(/\n/g, "\\n");

  // The client secret is an ES256 JWT Apple accepts as `client_secret`: header
  // kid, Team ID as iss, Services ID as sub, Apple as aud, and an expiry.
  const config = { clientId: SERVICES_ID, teamId: TEAM_ID, keyId: KEY_ID, privateKey: normaliseApplePrivateKey(envKey) };
  assert.ok(config.privateKey.includes("\n"), "escaped newlines are restored");
  assert.deepEqual(
    appleWebConfig({
      APPLE_WEB_CLIENT_ID: SERVICES_ID,
      APPLE_TEAM_ID: TEAM_ID,
      APPLE_KEY_ID: KEY_ID,
      APPLE_PRIVATE_KEY: envKey
    }),
    config
  );
  assert.equal(appleWebConfig({ APPLE_WEB_CLIENT_ID: SERVICES_ID }), null, "a partial environment is not configured");
  const issuedAt = 1_760_000_000;
  const secret = createAppleClientSecret(config, issuedAt);
  assert.deepEqual(decodeProtectedHeader(secret), { alg: "ES256", kid: KEY_ID });
  const claims = decodeJwt(secret);
  assert.equal(claims.iss, TEAM_ID);
  assert.equal(claims.sub, SERVICES_ID);
  assert.equal(claims.aud, APPLE_ISSUER);
  assert.equal(claims.iat, issuedAt);
  assert.equal(claims.exp, issuedAt + APPLE_CLIENT_SECRET_TTL_SECONDS);
  assert.equal(Buffer.from(secret.split(".")[2], "base64url").length, 64, "P-1363 signature is raw R||S");
  await jwtVerify(secret, publicKey, {
    algorithms: ["ES256"],
    audience: APPLE_ISSUER,
    issuer: TEAM_ID,
    subject: SERVICES_ID,
    currentDate: new Date((issuedAt + 60) * 1000)
  });

  // The provider exists only when all four values are present; a partial set is
  // the same as no configuration, and the button is hidden by getProviders().
  clearAppleEnv();
  let auth = loadAuth();
  assert.equal(auth.appleSignInConfigured(), false);
  assert.equal(auth.authOptions.providers.some(provider => provider.id === "apple"), false);
  assert.equal(auth.authOptions.cookies, undefined);

  setAppleEnv(envKey);
  delete process.env.APPLE_PRIVATE_KEY;
  auth = loadAuth();
  assert.equal(auth.appleSignInConfigured(), false, "a missing key hides the provider");
  assert.equal(auth.authOptions.providers.some(provider => provider.id === "apple"), false);

  setAppleEnv(envKey);
  auth = loadAuth();
  assert.equal(auth.appleSignInConfigured(), true);
  const provider = auth.authOptions.providers.find(candidate => candidate.id === "apple") as unknown as {
    options?: { clientId?: string; clientSecret?: string };
  };
  assert.ok(provider);
  assert.equal(provider.options?.clientId, SERVICES_ID);
  assert.equal(typeof Object.getOwnPropertyDescriptor(provider.options!, "clientSecret")?.get, "function", "the secret is regenerated per request");
  const providerSecret = provider.options?.clientSecret as string;
  assert.equal(decodeJwt(providerSecret).sub, SERVICES_ID);
  await jwtVerify(providerSecret, publicKey, { algorithms: ["ES256"], audience: APPLE_ISSUER, issuer: TEAM_ID, subject: SERVICES_ID });
  // Apple's form_post callback is cross-site, so Lax cookies would never arrive.
  assert.equal(auth.authOptions.cookies?.pkceCodeVerifier?.name, "__Secure-next-auth.pkce.code_verifier");
  assert.equal(auth.authOptions.cookies?.pkceCodeVerifier?.options.sameSite, "none");
  assert.equal(auth.authOptions.cookies?.pkceCodeVerifier?.options.secure, true);
  assert.equal(auth.authOptions.cookies?.state?.options.sameSite, "none");

  // A local HTTP deployment cannot complete Apple's flow, but it must not emit a
  // SameSite=None cookie without Secure (browsers reject it), so it stays Lax.
  process.env.NEXTAUTH_URL = "http://localhost:3000";
  auth = loadAuth();
  assert.equal(auth.authOptions.cookies?.pkceCodeVerifier?.name, "next-auth.pkce.code_verifier");
  assert.equal(auth.authOptions.cookies?.pkceCodeVerifier?.options.sameSite, "lax");
  assert.equal(auth.authOptions.cookies?.pkceCodeVerifier?.options.secure, false);
  process.env.NEXTAUTH_URL = NEXTAUTH_URL;
  auth = loadAuth();

  const signIn = auth.authOptions.callbacks?.signIn as unknown as (args: {
    account: { provider: string; providerAccountId: string };
    profile: Record<string, unknown>;
  }) => Promise<unknown>;

  await databaseFixture(async client => {
    process.env.SIGNUP_MODE = "open";
    delete process.env.INVITED_EMAILS;

    // A new Apple subject creates one owner with no login email. Apple's address
    // stays on the method row for display only.
    assert.equal(await signIn({
      account: { provider: "apple", providerAccountId: "apple-web-sub-1" },
      profile: { sub: "apple-web-sub-1", email: RELAY, email_verified: true }
    }), true);
    const first = (await client.query("SELECT owner_id,email FROM auth_accounts WHERE provider='apple' AND provider_account_id='apple-web-sub-1'")).rows[0];
    assert.equal(first.email, RELAY);
    assert.equal((await client.query("SELECT email FROM auth_users WHERE id=$1", [first.owner_id])).rows[0].email, null);

    // A returning subject is the same owner even when Apple reports a new address.
    assert.equal(await signIn({
      account: { provider: "apple", providerAccountId: "apple-web-sub-1" },
      profile: { sub: "apple-web-sub-1", email: "moved@example.invalid", email_verified: true }
    }), true);
    assert.equal((await client.query("SELECT count(*)::int n FROM auth_users")).rows[0].n, 1);
    assert.equal((await client.query("SELECT email FROM auth_accounts WHERE provider_account_id='apple-web-sub-1'")).rows[0].email, "moved@example.invalid");

    // A private-relay (or any Apple) address equal to an existing owner's never
    // links to that owner. Only a signed-in session may attach an Apple method.
    await client.query(`INSERT INTO auth_users(id,name,email,"emailVerified") VALUES('relay-owner','Relay Owner',$1,now())`, [RELAY]);
    await client.query("INSERT INTO auth_accounts(provider,provider_account_id,owner_id,email,created_at) VALUES('google','relay-google-sub','relay-owner',$1,now())", [RELAY]);
    assert.equal(await signIn({
      account: { provider: "apple", providerAccountId: "apple-web-relay" },
      profile: { sub: "apple-web-relay", email: RELAY, email_verified: true }
    }), true);
    const relayAccount = (await client.query("SELECT owner_id FROM auth_accounts WHERE provider_account_id='apple-web-relay'")).rows[0];
    assert.notEqual(relayAccount.owner_id, "relay-owner");
    assert.equal((await client.query("SELECT count(*)::int n FROM auth_accounts WHERE owner_id='relay-owner'")).rows[0].n, 1);

    // Apple can omit the address entirely; in open mode that still creates its own owner.
    assert.equal(await signIn({
      account: { provider: "apple", providerAccountId: "apple-web-no-email" },
      profile: { sub: "apple-web-no-email", email_verified: true }
    }), true);
    const noEmail = (await client.query("SELECT owner_id,email FROM auth_accounts WHERE provider_account_id='apple-web-no-email'")).rows[0];
    assert.equal(noEmail.email, null);
    assert.equal((await client.query("SELECT email FROM auth_users WHERE id=$1", [noEmail.owner_id])).rows[0].email, null);

    // A missing subject fails closed, as does an unknown provider.
    assert.equal(await signIn({ account: { provider: "apple", providerAccountId: "" }, profile: {} }), false);
    assert.equal(await signIn({ account: { provider: "github", providerAccountId: "apple-web-sub-1" }, profile: { sub: "apple-web-sub-1" } }), false);

    // The pilot invite gate is the same one the phone uses: a new Apple owner is
    // refused unless its verified address is listed; a returning identity and an
    // existing owner are unaffected. Apple's private-relay address must itself be
    // invited, and an unverified or missing address cannot pass.
    process.env.SIGNUP_MODE = "invite";
    process.env.INVITED_EMAILS = "invited-web@example.invalid";
    const countApple = async () => Number((await client.query("SELECT count(*)::int n FROM auth_accounts WHERE provider='apple'")).rows[0].n);
    const appleCountBefore = await countApple();
    assert.equal(await signIn({
      account: { provider: "apple", providerAccountId: "apple-web-stranger" },
      profile: { sub: "apple-web-stranger", email: "stranger-web@example.invalid", email_verified: true }
    }), `${NEXTAUTH_URL}/?error=invite_only`);
    assert.equal(await countApple(), appleCountBefore);
    assert.equal(await signIn({
      account: { provider: "apple", providerAccountId: "apple-web-relay-stranger" },
      profile: { sub: "apple-web-relay-stranger", email: RELAY, email_verified: true }
    }), `${NEXTAUTH_URL}/?error=invite_only`, "a relay address must itself be invited");
    assert.equal(await signIn({
      account: { provider: "apple", providerAccountId: "apple-web-unverified" },
      profile: { sub: "apple-web-unverified", email: "invited-web@example.invalid", email_verified: false }
    }), `${NEXTAUTH_URL}/?error=invite_only`, "an unverified Apple address cannot pass the gate");
    assert.equal(await signIn({
      account: { provider: "apple", providerAccountId: "apple-web-no-email-invited" },
      profile: { sub: "apple-web-no-email-invited", email_verified: true }
    }), `${NEXTAUTH_URL}/?error=invite_only`, "no address cannot pass the gate");
    assert.equal(await signIn({
      account: { provider: "apple", providerAccountId: "apple-web-invited" },
      profile: { sub: "apple-web-invited", email: "Invited-Web@Example.invalid", email_verified: true }
    }), true);
    assert.equal(await signIn({
      account: { provider: "apple", providerAccountId: "apple-web-sub-1" },
      profile: { sub: "apple-web-sub-1", email: "moved@example.invalid", email_verified: true }
    }), true, "a returning subject signs in even when not on the invite list");
    assert.equal(await countApple(), appleCountBefore + 1);

    // No provider token or secret is written to the identity tables.
    assert.doesNotMatch(JSON.stringify((await client.query("SELECT * FROM auth_accounts")).rows), /eyJ/);
  });

  clearAppleEnv();
  delete process.env.SIGNUP_MODE;
  delete process.env.INVITED_EMAILS;
  console.log("Apple web provider, client secret and callback tests passed");
}

main().catch(error => { console.error(error); process.exit(1); });
