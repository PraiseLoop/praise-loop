import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { databaseFixture } from "./db-fixture";
import { sessionHash } from "../lib/auth-adapter";
import { setupBanner, setupState, type PostingSetup } from "../lib/posting/postingSetup";
import { getPostingSetup } from "../lib/services/postingSetup";

// The "is posting set up?" banner (#205): wording and state rules, then the real route.
const ig = { service: "instagram", type: "business" };
// State precedence: the gate first, then the connection, then the channel.
assert.equal(setupState({ mode: "off", connection: "active", channel: ig }), "off");
assert.equal(setupState({ mode: "draft", connection: null, channel: ig }), "not_connected");
assert.equal(setupState({ mode: "draft", connection: "needs_reconnect", channel: ig }), "needs_reconnect");
assert.equal(setupState({ mode: "draft", connection: "active", channel: null }), "no_channel");
assert.equal(setupState({ mode: "live", connection: "active", channel: { service: "instagram", type: "profile" } }), "personal_instagram");
assert.equal(setupState({ mode: "live", connection: "active", channel: { service: "instagram", type: "" } }), "personal_instagram", "an unknown Instagram type is refused like the worker does");
assert.equal(setupState({ mode: "live", connection: "active", channel: { service: "facebook", type: "page" } }), "ready", "the Instagram rule only applies to Instagram");
assert.equal(setupState({ mode: "draft", connection: "active", channel: ig }), "ready");

const make = (state: PostingSetup["state"], mode: PostingSetup["mode"] = "draft"): PostingSetup => ({ state, mode, channelName: "Synthetic Co", channelService: "instagram" });
// Live and ready: nothing to say. Draft and ready: say plainly that it is a test.
assert.equal(setupBanner(make("ready", "live")), null);
const test = setupBanner(make("ready", "draft"))!;
assert.match(test.headline, /drafts/); assert.match(test.detail, /Nothing is published/); assert.match(test.detail, /Synthetic Co/);
// Every problem state explains itself, and every one that the owner can fix links to Connections.
for (const state of ["not_connected", "needs_reconnect", "no_channel", "personal_instagram"] as const) {
  const banner = setupBanner(make(state))!;
  assert.equal(banner.tone, "warn", state); assert.ok(banner.headline && banner.detail, state); assert.equal(banner.link?.href, "/connections", state);
}
const off = setupBanner(make("off", "off"))!;
assert.equal(off.link, null, "the gate is not something the owner can change");
assert.doesNotMatch(JSON.stringify(setupBanner(make("not_connected"))), /coming soon/i);

async function main() {
  await databaseFixture(async (c) => {
    const owner = "setup-owner", other = "setup-other";
    for (const o of [owner, other]) await c.query("INSERT INTO auth_users(id,email) VALUES($1,$2)", [o, `${o}@example.invalid`]);
    await c.query("INSERT INTO auth_sessions VALUES($1,$2,now()+interval '1 hour')", [sessionHash("setup-session"), owner]);
    await c.query("INSERT INTO auth_sessions VALUES($1,$2,now()+interval '1 hour')", [sessionHash("other-session"), other]);
    const business = Number((await c.query("INSERT INTO businesses(name,timezone,owner_id) VALUES('Synthetic','UTC',$1) RETURNING id", [owner])).rows[0].id);

    assert.equal((await getPostingSetup(owner, business, "draft")).state, "not_connected", "no connection yet");
    const conn = Number((await c.query("INSERT INTO buffer_connections(owner_id,organization_id,encrypted_access_token,encrypted_refresh_token,access_expires_at,scope,status) VALUES($1,'org','a','r',now()+interval '1 hour','s','active') RETURNING id", [owner])).rows[0].id);
    assert.equal((await getPostingSetup(owner, business, "draft")).state, "no_channel", "connected, nothing chosen");
    await c.query("INSERT INTO business_buffer_channels(business_id,connection_id,channel_id,channel_name,service,channel_type) VALUES($1,$2,'ch1','Synthetic Co','instagram','business')", [business, conn]);
    const ready = await getPostingSetup(owner, business, "draft");
    assert.deepEqual([ready.state, ready.channelName, ready.channelService], ["ready", "Synthetic Co", "instagram"]);
    assert.equal((await getPostingSetup(owner, business, "off")).state, "off", "the gate wins");
    await c.query("UPDATE business_buffer_channels SET channel_type='profile' WHERE business_id=$1", [business]);
    assert.equal((await getPostingSetup(owner, business, "draft")).state, "personal_instagram");
    await c.query("UPDATE buffer_connections SET status='needs_reconnect' WHERE id=$1", [conn]);
    assert.equal((await getPostingSetup(owner, business, "draft")).state, "needs_reconnect");

    // Through the real guard: the owner can read it, another owner gets a 404, and nothing secret is in the body.
    const route = require("../app/api/businesses/[id]/posting-setup/route");
    const get = (session: string, id: number | string) => route.GET(
      new NextRequest(`https://app.example.invalid/api/businesses/${id}/posting-setup`, { headers: { cookie: `next-auth.session-token=${session}` } }),
      { params: Promise.resolve({ id: String(id) }) }
    );
    process.env.BUFFER_POSTING_MODE = "draft";
    const mine = await get("setup-session", business);
    assert.equal(mine.status, 200);
    const body = await mine.json();
    assert.deepEqual(Object.keys(body).sort(), ["channelName", "channelService", "mode", "state"]);
    assert.equal(body.state, "needs_reconnect"); assert.equal(body.mode, "draft");
    assert.equal((await get("other-session", business)).status, 404, "another owner's business is not found");
    assert.match(mine.headers.get("cache-control") ?? "", /no-store/);
  });
  console.log("posting setup banner state, wording and route tests passed");
}
void main();
