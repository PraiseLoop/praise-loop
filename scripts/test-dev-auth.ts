import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { databaseFixture } from "./db-fixture";
import { DEV_OWNER_EMAIL, DEV_OWNER_ID, DEV_OWNER_OPTIONS, DEV_OWNERS, devAuthEnabled, ensureDevOwner } from "../lib/devAuth";
import { resolveMobileSession } from "../lib/mobileSessions";
import { flushSignInAlerts } from "../lib/signInAlerts";

// The demo sign-in is the only unauthenticated way to mint an owner session. Its
// gate has to fail closed, so it is tested separately from the route inventory.
async function main() {
  process.env.NEXTAUTH_URL = "http://localhost";
  assert.equal(devAuthEnabled({}), false, "off by default");
  assert.equal(devAuthEnabled({ MOBILE_DEV_AUTH: "true", NODE_ENV: "development" }), false, "only the literal 1 enables it");
  assert.equal(devAuthEnabled({ MOBILE_DEV_AUTH: "1", NODE_ENV: "production" }), false, "production builds always answer 404");
  assert.equal(devAuthEnabled({ MOBILE_DEV_AUTH: "1", NODE_ENV: "development" }), true);

  // The web picker offers exactly the known demo owner keys, in order.
  assert.deepEqual(DEV_OWNER_OPTIONS.map(owner => owner.key), Object.keys(DEV_OWNERS));
  assert.deepEqual(DEV_OWNER_OPTIONS.map(owner => owner.label), ["Pro demo owner", "Business demo owner", "Free demo owner", "Email demo owner", "Password demo owner"]);

  // Disabled: both routes must look like unknown ones before they touch the database.
  delete process.env.MOBILE_DEV_AUTH;
  const { POST } = require("../app/api/mobile/session/dev/route");
  const web = require("../app/api/dev/session/route");
  const webPost = (owner: unknown, origin = "http://localhost") => web.POST(new NextRequest("http://localhost/api/dev/session", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ owner })
  }));
  assert.equal((await POST()).status, 404);
  assert.equal((await web.GET()).status, 404);
  assert.equal((await webPost("pro")).status, 404);

  // Production: the flag alone is not enough, on either route.
  const mutableEnv = process.env as Record<string, string | undefined>;
  const originalNodeEnv = mutableEnv.NODE_ENV;
  process.env.MOBILE_DEV_AUTH = "1";
  mutableEnv.NODE_ENV = "production";
  try {
    assert.equal((await POST()).status, 404, "mobile demo sign-in is missing in production");
    assert.equal((await web.GET()).status, 404, "web demo sign-in is missing in production");
    assert.equal((await webPost("pro")).status, 404, "web demo session cannot be minted in production");
  } finally {
    delete process.env.MOBILE_DEV_AUTH;
    if (originalNodeEnv === undefined) delete mutableEnv.NODE_ENV; else mutableEnv.NODE_ENV = originalNodeEnv;
  }

  if (!process.env.TEST_DATABASE_URL) {
    console.log("Dev auth database tests skipped: set TEST_DATABASE_URL");
    return;
  }

  await databaseFixture(async client => {
    await ensureDevOwner();
    await ensureDevOwner();
    const owners = await client.query("SELECT id,email FROM auth_users WHERE id=$1", [DEV_OWNER_ID]);
    assert.equal(owners.rowCount, 1, "the demo owner is created once");
    assert.equal(owners.rows[0].email, DEV_OWNER_EMAIL);

    process.env.MOBILE_DEV_AUTH = "1";
    try {
      const response = await POST();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.json() as { token?: string; owner?: string };
      assert.ok(body.token, "a bearer token is returned");
      assert.equal(body.owner, DEV_OWNER_ID);
      const resolved = await resolveMobileSession(body.token!);
      assert.equal(resolved?.ownerId, DEV_OWNER_ID, "the token resolves to the demo owner");

      // Every seeded owner is selectable by name; anything else is rejected.
      const asFree = (owner: unknown) => POST(new Request("http://localhost/api/mobile/session/dev", { method: "POST", body: JSON.stringify({ owner }) }));
      for (const [key, id] of [["business", "dev-owner-business"], ["free", "dev-owner-free"], ["email", "dev-owner-email"]] as const) {
        const selected = await asFree(key);
        assert.equal(selected.status, 200, key);
        const selectedBody = await selected.json() as { token: string; owner: string };
        assert.equal(selectedBody.owner, id);
        assert.equal((await resolveMobileSession(selectedBody.token))?.ownerId, id);
      }
      for (const bad of ["admin", "constructor", 1, null]) assert.equal((await asFree(bad)).status, 400, String(bad));

      // The web options list is only readable while the flag is on.
      const listed = await (await web.GET()).json() as { owners: { key: string; label: string }[] };
      assert.deepEqual(listed.owners, DEV_OWNER_OPTIONS);

      // Cookie-minting POSTs stay same-origin, then create the normal NextAuth row.
      assert.equal((await webPost("free", "https://foreign.invalid")).status, 403);
      for (const bad of ["admin", "constructor", 1, null]) assert.equal((await webPost(bad)).status, 400, String(bad));
      const webSession = await webPost("free");
      assert.equal(webSession.status, 200);
      assert.equal(webSession.headers.get("cache-control"), "no-store");
      const cookie = webSession.headers.get("set-cookie") ?? "";
      const token = /next-auth\.session-token=([^;]+)/.exec(cookie)?.[1];
      assert.ok(token, "a web session cookie is set");

      // The cookie is a real web session for that demo owner, not the default one.
      const profile = await require("../app/api/profile/route").GET(new NextRequest("http://localhost/api/profile", {
        headers: { cookie: `next-auth.session-token=${token}` }
      }));
      assert.equal(profile.status, 200);
      assert.deepEqual(await profile.json(), {
        name: null,
        email: DEV_OWNERS.free.email,
        nameSource: null,
        provider: "google",
        initials: "DF"
      });
      const stored = (await client.query("SELECT owner_id,kind FROM auth_sessions WHERE owner_id=$1 AND kind='web'", ["dev-owner-free"])).rows[0];
      assert.equal(stored.owner_id, "dev-owner-free");
      assert.equal(stored.kind, "web");

      // The demo owner is scoped like any other: another owner never sees its data.
      const business = (await client.query("INSERT INTO businesses(name,timezone,owner_id) VALUES('Demo café','UTC',$1) RETURNING id", [DEV_OWNER_ID])).rows[0].id;
      await client.query("INSERT INTO auth_users(id,email) VALUES('other-owner','other@example.invalid') ON CONFLICT DO NOTHING");
      assert.equal((await client.query("SELECT 1 FROM businesses WHERE id=$1 AND owner_id=$2", [business, "other-owner"])).rowCount, 0);
      await flushSignInAlerts();
    } finally {
      delete process.env.MOBILE_DEV_AUTH;
    }
  });

  console.log("dev auth gate and demo session tests passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
