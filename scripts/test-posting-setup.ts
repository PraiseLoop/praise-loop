import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { databaseFixture } from "./db-fixture";
import { sessionHash } from "../lib/auth-adapter";
import { setupBanner, setupState, type PostingSetup } from "../lib/posting/postingSetup";
import { getPostingSetup } from "../lib/services/postingSetup";

// The "is posting set up?" banner (#205) and its provider-neutral connected-state
// rule (#234): wording and state decisions, then the real route.
const ig = { service: "instagram", type: "business" };
const noBuffer = { connection: null, channel: null } as const;
const noMeta = { connection: null, target: null } as const;

const state = (input: {
  mode?: PostingSetup["mode"];
  buffer?: typeof noBuffer | { connection: "active" | "needs_reconnect" | null; channel: { service: string; type: string } | null };
  meta?: typeof noMeta | { connection: "active" | "needs_reconnect" | null; target: { target: "instagram" | "facebook"; pageStatus: "active" | "needs_reconnect"; tasks: string[] } | null };
}) => setupState({ mode: input.mode ?? "draft", buffer: input.buffer ?? noBuffer, meta: input.meta ?? noMeta });

// State precedence: the gate first, then the provider choice, then its target.
assert.equal(state({ mode: "off", buffer: { connection: "active", channel: ig } }), "off");
assert.equal(state({ buffer: { connection: null, channel: ig } }), "not_connected", "a channel without a connection is not usable");
assert.equal(state({ buffer: { connection: "needs_reconnect", channel: ig } }), "needs_reconnect");
assert.equal(state({ buffer: { connection: "active", channel: null } }), "no_channel", "a connection without a target is still connected");
assert.equal(state({ buffer: { connection: "needs_reconnect", channel: null } }), "needs_reconnect", "a flagged connection is actionable before a target exists");
assert.equal(state({ meta: { connection: "needs_reconnect", target: null } }), "needs_reconnect");
assert.equal(state({ buffer: { connection: "active", channel: { service: "instagram", type: "profile" } } }), "personal_instagram");
assert.equal(state({ buffer: { connection: "active", channel: { service: "instagram", type: "" } } }), "personal_instagram", "an unknown Instagram type is refused like the worker does");
assert.equal(state({ buffer: { connection: "active", channel: { service: "facebook", type: "page" } } }), "ready", "the Instagram rule only applies to Instagram");
assert.equal(state({ buffer: { connection: "active", channel: ig } }), "ready");

const metaReady = {
  connection: "active" as const,
  target: { target: "instagram" as const, pageStatus: "active" as const, tasks: ["CREATE_CONTENT"] }
};
assert.equal(state({ meta: metaReady }), "ready", "a Meta target is enough; no Buffer connection is needed");
assert.equal(state({ meta: { ...metaReady, connection: null } }), "not_connected");
assert.equal(state({ meta: { ...metaReady, connection: "needs_reconnect" } }), "needs_reconnect");
assert.equal(state({ meta: { ...metaReady, target: { ...metaReady.target, pageStatus: "needs_reconnect" } } }), "needs_reconnect", "a Page flagged for reconnect holds posting");
assert.equal(state({ meta: { ...metaReady, target: { ...metaReady.target, tasks: ["ANALYZE"] } } }), "page_cannot_publish");
assert.equal(state({ meta: { connection: "active", target: null } }), "no_channel", "a Meta connection without a target is still connected");

// Both providers: Meta wins, exactly as the scheduler and worker choose.
assert.equal(state({ buffer: { connection: "active", channel: ig }, meta: metaReady }), "ready");
assert.equal(
  state({ buffer: { connection: "active", channel: ig }, meta: { ...metaReady, target: { ...metaReady.target, pageStatus: "needs_reconnect" } } }),
  "needs_reconnect",
  "the banner follows Meta even when Buffer is ready"
);

const make = (state: PostingSetup["state"], mode: PostingSetup["mode"] = "draft", provider: PostingSetup["provider"] = "buffer"): PostingSetup =>
  ({ state, mode, provider, channelName: "Synthetic Co", channelService: provider === "meta" ? "instagram" : "instagram" });
// Live and ready: nothing to say. Draft and ready: say plainly that it is a test.
assert.equal(setupBanner(make("ready", "live")), null);
const test = setupBanner(make("ready", "draft"))!;
assert.match(test.headline, /drafts/); assert.match(test.detail, /Nothing is published/); assert.match(test.detail, /Synthetic Co/);
const metaTest = setupBanner(make("ready", "draft", "meta"))!;
assert.match(metaTest.headline, /nothing is published/i); assert.match(metaTest.detail, /test mode/i); assert.match(metaTest.detail, /Synthetic Co/);
// Every problem state explains itself, and every one that the owner can fix links to Connections.
for (const state of ["not_connected", "needs_reconnect", "no_channel", "personal_instagram", "page_cannot_publish"] as const) {
  const banner = setupBanner(make(state))!;
  assert.equal(banner.tone, "warn", state); assert.ok(banner.headline && banner.detail, state); assert.equal(banner.link?.href, "/connections", state);
}
assert.match(setupBanner(make("not_connected"))!.headline, /Posting isn’t connected yet/);
assert.match(setupBanner(make("not_connected"))!.detail, /Instagram, Facebook or Buffer/);
assert.match(setupBanner(make("needs_reconnect", "draft", "meta"))!.headline, /Instagram or Facebook needs to be reconnected/);
assert.match(setupBanner(make("needs_reconnect", "draft", "buffer"))!.headline, /Buffer needs to be reconnected/);
assert.match(setupBanner({ state: "needs_reconnect", mode: "draft", provider: null, channelName: null, channelService: null })!.headline, /A posting connection needs to be reconnected/);
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
    const connected = await getPostingSetup(owner, business, "draft");
    assert.equal(connected.state, "no_channel", "connected, nothing chosen");
    assert.equal(connected.provider, null);
    await c.query("INSERT INTO business_buffer_channels(business_id,connection_id,channel_id,channel_name,service,channel_type) VALUES($1,$2,'ch1','Synthetic Co','instagram','business')", [business, conn]);
    const ready = await getPostingSetup(owner, business, "draft");
    assert.deepEqual([ready.state, ready.provider, ready.channelName, ready.channelService], ["ready", "buffer", "Synthetic Co", "instagram"]);
    assert.equal((await getPostingSetup(owner, business, "off")).state, "off", "the gate wins");
    await c.query("UPDATE business_buffer_channels SET channel_type='profile' WHERE business_id=$1", [business]);
    assert.equal((await getPostingSetup(owner, business, "draft")).state, "personal_instagram");
    await c.query("UPDATE buffer_connections SET status='needs_reconnect' WHERE id=$1", [conn]);
    assert.equal((await getPostingSetup(owner, business, "draft")).state, "needs_reconnect");

    // A Meta target alone makes the business posting-connected, and Meta wins when
    // a Buffer channel also exists.
    const metaConn = Number((await c.query("INSERT INTO meta_connections(owner_id,status) VALUES($1,'active') RETURNING id", [owner])).rows[0].id);
    const metaPage = Number((await c.query("INSERT INTO meta_pages(connection_id,page_id,name,encrypted_page_token,instagram_business_account_id,tasks,status) VALUES($1,'page-1','Synthetic Meta','encrypted','ig-1',ARRAY['CREATE_CONTENT'],'active') RETURNING id", [metaConn])).rows[0].id);
    await c.query("INSERT INTO business_meta_targets(business_id,meta_page_id,target) VALUES($1,$2,'instagram')", [business, metaPage]);
    await c.query("UPDATE buffer_connections SET status='active' WHERE id=$1", [conn]);
    const meta = await getPostingSetup(owner, business, "draft");
    assert.deepEqual([meta.state, meta.provider, meta.channelName, meta.channelService], ["ready", "meta", "Synthetic Meta", "instagram"]);
    assert.equal((await getPostingSetup(other, business, "draft")).state, "not_connected", "a foreign owner never sees the target");

    await c.query("UPDATE meta_pages SET status='needs_reconnect' WHERE id=$1", [metaPage]);
    assert.equal((await getPostingSetup(owner, business, "draft")).state, "needs_reconnect", "Meta wins over a ready Buffer");
    await c.query("UPDATE meta_pages SET status='active',tasks=ARRAY['ANALYZE'] WHERE id=$1", [metaPage]);
    assert.equal((await getPostingSetup(owner, business, "draft")).state, "page_cannot_publish");
    await c.query("UPDATE meta_connections SET status='needs_reconnect' WHERE id=$1", [metaConn]);
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
    assert.deepEqual(Object.keys(body).sort(), ["channelName", "channelService", "mode", "provider", "state"]);
    assert.equal(body.state, "needs_reconnect"); assert.equal(body.mode, "draft"); assert.equal(body.provider, "meta");
    assert.equal((await get("other-session", business)).status, 404, "another owner's business is not found");
    assert.match(mine.headers.get("cache-control") ?? "", /no-store/);

    // A Meta-only owner with a connection but no target yet (review on #255): the
    // connection status is read on its own, not through the target join.
    await c.query("DELETE FROM business_meta_targets WHERE business_id=$1", [business]);
    await c.query("DELETE FROM business_buffer_channels WHERE business_id=$1", [business]);
    await c.query("DELETE FROM buffer_connections WHERE owner_id=$1", [owner]);
    assert.equal((await getPostingSetup(owner, business, "draft")).state, "needs_reconnect", "a flagged Meta connection without a target");
    await c.query("UPDATE meta_connections SET status='active' WHERE id=$1", [metaConn]);
    assert.equal((await getPostingSetup(owner, business, "draft")).state, "no_channel", "a working Meta connection without a target asks for the target");
    assert.equal((await getPostingSetup(other, business, "draft")).state, "not_connected", "another owner's connection never counts");
  });
  console.log("posting setup banner state, provider choice, wording and route tests passed");
}
void main();
