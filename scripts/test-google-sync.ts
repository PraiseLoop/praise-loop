import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { databaseFixture } from "./db-fixture";
import { GoogleApiError, type GoogleReview, type GoogleReviewsClient } from "../lib/integrations/googleReviews";
const rev = (n: number, extra: Partial<GoogleReview> = {}): GoogleReview => ({ reviewId: `r${n}`, rating: 5, comment: `Synthetic kind words ${n}`, reviewerName: "Example", createTime: "2026-10-01T00:00:00Z", updateTime: "2026-10-01T00:00:00Z", ...extra });
/** Fixture client: pages of reviews, scripted failures. Never touches the network. */
function fake(pages: GoogleReview[][], script: { refresh?: Error[]; list?: Error[] } = {}) {
  const calls = { list: 0, revoked: 0, tokens: [] as (string | undefined)[] };
  const client: GoogleReviewsClient = {
    async refreshAccessToken() { const e = script.refresh?.shift(); if (e) throw e; return "access"; },
    async listReviews(_a, _l, t) { calls.list++; calls.tokens.push(t); const e = script.list?.shift(); if (e) throw e; const i = t ? Number(t) : 0; return { reviews: pages[i], nextPageToken: i + 1 < pages.length ? String(i + 1) : undefined }; },
    async revoke() { calls.revoked++; }
  };
  return { client, calls };
}
async function main() {
  process.env.GOOGLE_TOKEN_KEY = randomBytes(32).toString("base64");
  const g = require("../lib/integrations/googleReviews");
  const t = g.encryptToken("refresh-secret", "o1", 1);
  assert.ok(!t.includes("refresh-secret")); assert.equal(g.decryptToken(t, "o1", 1), "refresh-secret");
  assert.throws(() => g.decryptToken(t, "o2", 1), "ciphertext is bound to owner/business");
  // The live client now exists; with no OAuth config it must fail closed. Clear
  // the keys so the assertion is the same on a machine with Google sign-in env.
  const saved = {
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_BUSINESS_REDIRECT_URI: process.env.GOOGLE_BUSINESS_REDIRECT_URI,
    NEXTAUTH_URL: process.env.NEXTAUTH_URL
  };
  for (const key of Object.keys(saved)) delete process.env[key];
  try {
    assert.throws(() => g.liveClient(), /google_business_not_configured/);
  } finally {
    for (const [key, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[key]; else process.env[key] = v;
    }
  }
  const noSleep = { sleep: async () => {} };
  await databaseFixture(async c => {
    await c.query("INSERT INTO auth_users(id,email) VALUES('g-a','ga@example.invalid'),('g-b','gb@example.invalid')");
    const bid = async (o: string) => (await c.query("INSERT INTO businesses(name,timezone,owner_id) VALUES('Synthetic','UTC',$1) RETURNING id", [o])).rows[0].id as number;
    const [a, b] = [await bid("g-a"), await bid("g-b")];
    const loc = "accounts/1/locations/2";
    assert.equal(await g.connect("g-b", a, loc, "tok"), null, "cannot connect another owner's business");
    assert.ok(await g.connect("g-a", a, loc, "tok-a"));
    const stored = (await c.query("SELECT encrypted_refresh_token t FROM google_connections WHERE business_id=$1", [a])).rows[0].t;
    assert.ok(!stored.includes("tok-a"));
    // pagination + repeat sync is duplicate-free
    const pages = [[rev(1), rev(2)], [rev(3)]];
    let f = fake(pages);
    assert.deepEqual(await g.syncReviews(f.client, a, noSleep), { status: "ok", imported: 3, updated: 0 });
    assert.equal((await g.syncReviews(fake(pages).client, a, noSleep)).imported, 0);
    assert.equal((await c.query("SELECT count(*) FROM reviews WHERE business_id=$1", [a])).rows[0].count, "3");
    // edited review updates the review row only; the approved draft quote is untouched
    const rid = (await c.query("SELECT id FROM reviews WHERE source_review_id='r1'")).rows[0].id;
    await c.query("INSERT INTO draft_posts(business_id,review_id,quote_text,caption_text,status) VALUES($1,$2,'Approved quote','cap','approved')", [a, rid]);
    const edited = await g.syncReviews(fake([[rev(1, { comment: "Edited synthetic words" })]]).client, a, noSleep);
    assert.equal(edited.updated, 1);
    assert.equal((await c.query("SELECT text FROM reviews WHERE id=$1", [rid])).rows[0].text, "Edited synthetic words");
    assert.equal((await c.query("SELECT quote_text FROM draft_posts WHERE review_id=$1", [rid])).rows[0].quote_text, "Approved quote");
    // an edit that removes the comment clears the imported text but not the approved draft quote
    const cleared = await g.syncReviews(fake([[rev(1, { comment: "" })]]).client, a, noSleep);
    assert.equal(cleared.updated, 1);
    assert.equal((await c.query("SELECT text FROM reviews WHERE id=$1", [rid])).rows[0].text, "");
    assert.equal((await c.query("SELECT quote_text FROM draft_posts WHERE review_id=$1", [rid])).rows[0].quote_text, "Approved quote");
    assert.equal((await g.syncReviews(fake([[rev(777, { comment: "" })]]).client, a, noSleep)).imported, 0, "rating-only reviews are not imported");
    // 429 retries honor Retry-After then succeed; bounded when persistent
    const waits: number[] = [];
    f = fake([[rev(4)]], { list: [new GoogleApiError(429, "rate", 1234)] });
    assert.equal((await g.syncReviews(f.client, a, { sleep: async (ms: number) => { waits.push(ms); } })).status, "ok");
    assert.deepEqual(waits, [1234]);
    f = fake([[rev(5)]], { list: Array.from({ length: 9 }, () => new GoogleApiError(429, "rate")) });
    const limited = await g.syncReviews(f.client, a, { ...noSleep, maxRetries: 2 });
    assert.deepEqual([limited.status, limited.errorCode, f.calls.list], ["failed", "google_429", 3]);
    // interrupted import resumes from the checkpoint
    f = fake([[rev(10)], [rev(11)], [rev(12)]]);
    const orig = f.client.listReviews; let n = 0;
    f.client.listReviews = async (...args) => { if (++n === 2) throw new GoogleApiError(500, "boom"); return orig(...args); };
    const partial = await g.syncReviews(f.client, a, { ...noSleep, maxRetries: 0 });
    assert.equal(partial.status, "failed"); assert.equal(partial.imported, 1);
    assert.equal((await c.query("SELECT page_checkpoint p FROM google_connections WHERE business_id=$1", [a])).rows[0].p, "1");
    f = fake([[rev(10)], [rev(11)], [rev(12)]]);
    assert.equal((await g.syncReviews(f.client, a, noSleep)).imported, 2);
    assert.deepEqual(f.calls.tokens, ["1", "2"], "resumed at the checkpoint");
    // expired/revoked consent: actionable state, credential dropped, redacted code
    await g.connect("g-a", a, loc, "tok-a2");
    const bad = await g.syncReviews(fake([[]], { refresh: [new GoogleApiError(400, "invalid_grant")] }).client, a, noSleep);
    assert.deepEqual([bad.status, bad.errorCode], ["revoked", "access_revoked"]);
    const row = (await c.query("SELECT status,encrypted_refresh_token t,last_error_code FROM google_connections WHERE business_id=$1", [a])).rows[0];
    assert.deepEqual([row.status, row.t, row.last_error_code], ["revoked", null, "access_revoked"]);
    assert.equal((await g.syncReviews(fake([[rev(99)]]).client, a, noSleep)).status, "skipped");
    // a sync that started before a reconnect cannot revoke the new credential
    await g.connect("g-a", a, loc, "tok-a4");
    const staleClient = fake([[rev(97)]]).client;
    staleClient.refreshAccessToken = async () => { await g.connect("g-a", a, loc, "tok-a5"); throw new GoogleApiError(400, "invalid_grant"); };
    await g.syncReviews(staleClient, a, noSleep);
    const live = (await c.query("SELECT status,encrypted_refresh_token t FROM google_connections WHERE business_id=$1", [a])).rows[0];
    assert.equal(live.status, "active"); assert.ok(live.t, "reconnected credential survives a stale failure");
    // a scan that outlives a reconnect or disconnect stops without importing or moving the checkpoint
    await g.connect("g-a", a, loc, "tok-a6");
    const before = (await c.query("SELECT count(*) FROM reviews WHERE business_id=$1", [a])).rows[0].count;
    const moving = fake([[rev(201)], [rev(202)]]);
    const origList = moving.client.listReviews;
    moving.client.listReviews = async (...args) => { await g.connect("g-a", a, "accounts/1/locations/9", "tok-a7"); return origList(...args); };
    assert.equal((await g.syncReviews(moving.client, a, noSleep)).status, "skipped");
    assert.equal((await c.query("SELECT count(*) FROM reviews WHERE business_id=$1", [a])).rows[0].count, before, "stale scan imported nothing");
    assert.equal((await c.query("SELECT page_checkpoint p FROM google_connections WHERE business_id=$1", [a])).rows[0].p, null);
    // a Retry-After longer than the 60s cap is surfaced, not shortened
    const waited: number[] = [];
    const longWait = await g.syncReviews(fake([[rev(203)]], { list: [new GoogleApiError(429, "rate", 120000)] }).client, a, { sleep: async (ms: number) => { waited.push(ms); } });
    assert.deepEqual([longWait.status, longWait.errorCode, waited.length], ["failed", "google_429", 0]);
    // disconnect: ownership, revokes at provider, stops sync
    await g.connect("g-a", a, loc, "tok-a3");
    const d = fake([[rev(98)]]);
    assert.equal(await g.disconnect(d.client, "g-b", a), false);
    assert.equal(await g.disconnect(d.client, "g-a", a), true); assert.equal(d.calls.revoked, 1);
    assert.equal((await g.syncReviews(d.client, a, noSleep)).status, "skipped");
    assert.equal((await c.query("SELECT encrypted_refresh_token t FROM google_connections WHERE business_id=$1", [a])).rows[0].t, null);
    assert.equal((await c.query("SELECT count(*) FROM reviews WHERE business_id=$1", [b])).rows[0].count, "0");
  });
  console.log("google sync fixture tests passed (stubbed client, no live calls)");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
