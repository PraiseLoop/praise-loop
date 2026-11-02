import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { NextRequest } from "next/server";
import { databaseFixture } from "./db-fixture";
import { SchedulerAmbiguous, SchedulerAuthError, SchedulerRateLimited, SchedulerRejected } from "../lib/integrations/buffer";
import type { PostStatusReceipt, SchedulerAdapter, SchedulePayload } from "../lib/integrations/scheduler";
import { CHECK_BACKOFF_MS, DRAFT_IMAGE_TTL_MS, hashImageToken, IMAGE_TOKEN_PATTERN, LATE_WINDOW_MS, MAX_STATUS_CHECKS, postingMode, postingTick, publicImageUrl, resolvePublicImage, STALE_SUBMITTING_MS } from "../lib/services/bufferPosting";
import { GET as publicMedia } from "../app/api/public-media/[name]/route";

// The posting worker (#29 part 3), against a scripted fake Buffer. No real Buffer call is possible here:
// the adapter is injected and global fetch is replaced with one that fails the test.
const ENV = { NEXTAUTH_URL: "https://app.example.invalid" };
type Script = { submit?: () => Promise<{ externalId: string; status: string }>; status?: () => Promise<PostStatusReceipt> };
async function main() {
  // The gate: anything but draft/live is off, including typos and case games.
  assert.equal(postingMode({}), "off");
  for (const v of ["", "OFF", "on", "true", "1", "livee", " "]) assert.equal(postingMode({ BUFFER_POSTING_MODE: v }), "off", v);
  assert.equal(postingMode({ BUFFER_POSTING_MODE: "draft" }), "draft");
  assert.equal(postingMode({ BUFFER_POSTING_MODE: " Live " }), "live");
  // Image links are https only, built from the configured address.
  assert.equal(publicImageUrl("T", { NEXTAUTH_URL: "http://localhost:3000" }), null);
  assert.equal(publicImageUrl("T", { NEXTAUTH_URL: "https://u:p@app.example.invalid" }), null);
  assert.equal(publicImageUrl("T", {}), null);
  assert.equal(publicImageUrl("T", ENV), "https://app.example.invalid/api/public-media/T.png");

  const root = mkdtempSync(join(tmpdir(), "posting-")); process.env.MEDIA_ROOT = root;
  writeFileSync(join(root, "fixture.png"), await sharp({ create: { width: 1080, height: 1080, channels: 3, background: "#123456" } }).png().toBuffer());
  const realFetch = globalThis.fetch; globalThis.fetch = (async () => { throw new Error("no real network in the posting tests"); }) as typeof fetch;
  try {
    await databaseFixture(async (c) => {
      let n = 0;
      const calls: { payload?: SchedulePayload; id?: string; mode: string; owner: string }[] = [];
      let script: Script = {};
      const adapterFor = async ({ ownerId, mode }: { ownerId: string; channelId: string; mode: "draft" | "live" }): Promise<SchedulerAdapter> => ({
        submitPost: async (payload) => { calls.push({ payload, mode, owner: ownerId }); const r = await (script.submit ?? (async () => ({ externalId: "buf-1", status: "sending" })))(); return { provider: "buffer", ...r }; },
        getPostStatus: async (id) => { calls.push({ id, mode, owner: ownerId }); return (script.status ?? (async () => ({ status: "sending", externalLink: null, sentAt: null, errorMessage: null })))(); }
      });
      const submits = () => calls.filter((x) => x.payload).length, checks = () => calls.filter((x) => x.id).length;
      const NOW = Date.parse("2026-11-03T15:00:00Z"); let clock = NOW;
      const tick = (mode: "off" | "draft" | "live") => postingTick({ mode, env: ENV, now: () => clock, adapterFor });
      // One owner, business, connection, channel, scheduled draft and queued claim per case.
      async function seed(o: { state?: string; due?: number; service?: string; type?: string; connection?: string; draft?: string; channel?: boolean } = {}) {
        n += 1; const owner = `owner-${n}`;
        await c.query("INSERT INTO auth_users(id,email) VALUES($1,$2)", [owner, `${owner}@example.invalid`]);
        const business = Number((await c.query("INSERT INTO businesses(name,timezone,owner_id) VALUES('Synthetic','UTC',$1) RETURNING id", [owner])).rows[0].id);
        const conn = Number((await c.query("INSERT INTO buffer_connections(owner_id,organization_id,encrypted_access_token,encrypted_refresh_token,access_expires_at,scope,status) VALUES($1,'org','a','r',now()+interval '1 hour','s',$2) RETURNING id", [owner, o.connection ?? "active"])).rows[0].id);
        if (o.channel !== false) await c.query("INSERT INTO business_buffer_channels(business_id,connection_id,channel_id,channel_name,service,channel_type) VALUES($1,$2,'ch1','Synthetic',$3,$4)", [business, conn, o.service ?? "instagram", o.type ?? "business"]);
        const draft = Number((await c.query("INSERT INTO draft_posts(business_id,quote_text,caption_text,image_path,status,scheduled_for) VALUES($1,'Q','Synthetic caption','/api/media/fixture.png',$2,$3) RETURNING id", [business, o.draft ?? "scheduled", new Date(clock + (o.due ?? -60_000)).toISOString()])).rows[0].id);
        await c.query("INSERT INTO posting_slot_claims(business_id,instant,draft_id,state) VALUES($1,$2,$3,$4)", [business, new Date(clock + (o.due ?? -60_000)).toISOString(), draft, o.state ?? "queued"]);
        return draft;
      }
      const claim = async (d: number) => (await c.query("SELECT * FROM posting_slot_claims WHERE draft_id=$1", [d])).rows[0];
      const status = async (d: number) => (await c.query("SELECT status FROM draft_posts WHERE id=$1", [d])).rows[0].status;
      const reset = async () => { await c.query("DELETE FROM posting_slot_claims"); calls.length = 0; script = {}; clock = NOW; };
      const tokenOf = () => calls.find((x) => x.payload)!.payload!.mediaUrl.match(/public-media\/([^/]+)\.png$/)![1];
      const fetchImage = async (token: string) => publicMedia(new NextRequest(`http://localhost/api/public-media/${token}.png`), { params: Promise.resolve({ name: `${token}.png` }) });

      // 1. OFF never calls Buffer, even for a due, valid post.
      let d = await seed(); const off = await tick("off");
      assert.equal(off.mode, "off"); assert.equal(calls.length, 0); assert.equal((await claim(d)).state, "queued"); assert.equal(await status(d), "scheduled");
      await reset();

      // 2. DRAFT saves a Buffer draft: one call, saveToDraft side, nothing is called published.
      d = await seed(); let r = await tick("draft");
      assert.equal(r.drafted, 1); assert.equal(submits(), 1); assert.equal(calls[0].mode, "draft");
      let row = await claim(d);
      assert.deepEqual([row.state, row.mode, row.external_id, row.buffer_status], ["drafted", "draft", "buf-1", "sending"]);
      assert.equal(await status(d), "approved", "a draft in Buffer is not a published post");
      const token = tokenOf();
      assert.match(token, IMAGE_TOKEN_PATTERN); assert.equal(row.image_token_hash, hashImageToken(token)); assert.notEqual(row.image_token_hash, token);
      assert.doesNotMatch(JSON.stringify(row), new RegExp(token), "the token itself is never stored");
      assert.doesNotMatch(calls[0].payload!.mediaUrl, /draft-|fixture|\/api\/media/, "no draft filename in the public link");
      const served = await fetchImage(token);
      assert.equal(served.status, 200); assert.equal(served.headers.get("content-type"), "image/png"); assert.equal(served.headers.get("cache-control"), "no-store");
      assert.equal(served.headers.get("x-robots-tag"), "noindex, nofollow");
      assert.equal(Math.abs(Date.parse(row.image_expires_at) - (clock + DRAFT_IMAGE_TTL_MS)) < 1000, true, "draft links expire after an hour");
      await c.query("UPDATE posting_slot_claims SET image_expires_at=now()-interval '1 second' WHERE draft_id=$1", [d]);
      assert.equal((await fetchImage(token)).status, 404, "an expired link stops working");
      assert.equal((await tick("draft")).drafted, 0); assert.equal(submits(), 1, "a drafted post is never submitted again");
      await reset();

      // 3. LIVE: submitted, then polled on a backoff, then sent.
      d = await seed(); r = await tick("live");
      assert.equal(r.submitted, 1); row = await claim(d);
      assert.deepEqual([row.state, row.mode, row.external_id, row.check_count], ["submitted", "live", "buf-1", 0]);
      assert.equal(await status(d), "scheduled", "scheduled until Buffer says it was sent");
      const liveToken = tokenOf(); assert.equal((await fetchImage(liveToken)).status, 200);
      assert.equal(Date.parse(row.next_check_at), clock + CHECK_BACKOFF_MS[0]);
      await tick("live"); assert.equal(checks(), 0, "no status request before the first check time");
      clock += CHECK_BACKOFF_MS[0] + 1000; script = { status: async () => ({ status: "sending", externalLink: null, sentAt: null, errorMessage: null }) };
      r = await tick("live"); assert.equal(r.checked, 1); row = await claim(d);
      assert.deepEqual([row.state, row.check_count, row.buffer_status], ["submitted", 1, "sending"]);
      assert.equal(Date.parse(row.next_check_at), clock + CHECK_BACKOFF_MS[1], "the wait grows");
      await tick("live"); assert.equal(checks(), 1, "not asked again before the new check time");
      assert.equal(submits(), 1, "polling never resubmits");
      clock += CHECK_BACKOFF_MS[1] + 1000;
      script = { status: async () => ({ status: "sent", externalLink: "https://instagram.example/p/1", sentAt: "2026-11-03T15:07:00Z", errorMessage: null }) };
      r = await tick("live"); assert.equal(r.sent, 1); row = await claim(d);
      assert.deepEqual([row.state, row.external_link, row.image_token_hash], ["sent", "https://instagram.example/p/1", null]);
      assert.equal(row.sent_at.toISOString(), "2026-11-03T15:07:00.000Z");
      assert.equal(await status(d), "published", "published only because Buffer said sent");
      assert.equal((await fetchImage(liveToken)).status, 404, "the link is revoked once the post is out");
      await reset();

      // 4. Buffer reports an error: failed, link revoked.
      d = await seed(); await tick("live"); const errToken = tokenOf(); clock += CHECK_BACKOFF_MS[0] + 1000;
      script = { status: async () => ({ status: "error", externalLink: null, sentAt: null, errorMessage: "Image rejected" }) };
      r = await tick("live"); assert.equal(r.failed, 1); row = await claim(d);
      assert.deepEqual([row.state, row.error_code, row.image_token_hash], ["error", "buffer_error", null]); assert.equal(await status(d), "failed");
      assert.equal((await fetchImage(errToken)).status, 404);
      await reset();

      // 5. Not due yet: untouched. 6. Late: not sent late.
      d = await seed({ due: 30 * 60_000 }); await tick("live"); assert.equal(calls.length, 0); assert.equal((await claim(d)).state, "queued");
      await reset();
      d = await seed({ due: -(LATE_WINDOW_MS + 60_000) }); r = await tick("live");
      assert.equal(r.missed, 1); assert.equal(submits(), 0); row = await claim(d);
      assert.deepEqual([row.state, row.error_code], ["missed", "late"]); assert.equal(await status(d), "failed");
      d = await seed({ due: -(LATE_WINDOW_MS - 120_000) }); r = await tick("live");
      assert.equal(r.submitted, 1, "inside the window it still goes");
      await reset();

      // 7. Ambiguous outcome: unknown, never retried, the link stays alive for Buffer.
      d = await seed(); script = { submit: async () => { throw new SchedulerAmbiguous("timeout"); } };
      r = await tick("live"); assert.equal(r.unknown, 1); row = await claim(d);
      assert.deepEqual([row.state, row.error_code], ["unknown", "ambiguous"]); assert.equal(await status(d), "scheduled");
      assert.equal((await fetchImage(tokenOf())).status, 200, "Buffer may still be fetching the image");
      await tick("live"); await tick("live"); assert.equal(submits(), 1, "an unknown outcome is never resubmitted");
      await reset();

      // 8. Rate limited before processing: safe to try again on a later tick.
      d = await seed(); script = { submit: async () => { throw new SchedulerRateLimited(5000); } };
      r = await tick("live"); assert.equal(r.requeued, 1); row = await claim(d);
      assert.deepEqual([row.state, row.image_token_hash], ["queued", null]);
      script = {}; r = await tick("live"); assert.equal(r.submitted, 1); assert.equal(submits(), 2);
      await reset();

      // 9/10. Auth failure and rejection end visibly and revoke the link.
      for (const [error, code] of [[new SchedulerAuthError(), "needs_reconnect"], [new SchedulerRejected("bad"), "rejected"]] as const) {
        d = await seed(); script = { submit: async () => { throw error; } };
        r = await tick("live"); assert.equal(r.failed, 1); row = await claim(d);
        assert.deepEqual([row.state, row.error_code, row.image_token_hash], ["error", code, null]); assert.equal(await status(d), "failed");
        await reset();
      }

      // 11. Everything is re-checked at submit time; a failed check never reaches Buffer.
      const refused: [string, Parameters<typeof seed>[0]][] = [
        ["no_channel", { channel: false }], ["needs_reconnect", { connection: "needs_reconnect" }],
        ["personal_instagram", { type: "personal" }], ["personal_instagram", { type: "" }], ["draft_unavailable", { draft: "approved" }]
      ];
      for (const [code, options] of refused) {
        d = await seed(options); r = await tick("live");
        assert.equal(r.failed, 1, code); assert.equal(submits(), 0, `${code} never reaches Buffer`); assert.equal((await claim(d)).error_code, code);
        await reset();
      }
      d = await seed({ service: "facebook", type: "page" }); assert.equal((await tick("live")).submitted, 1, "a Facebook Page is not subject to the Instagram rule");
      await reset();
      d = await seed(); r = await postingTick({ mode: "live", env: { NEXTAUTH_URL: "http://insecure.example.invalid" }, now: () => clock, adapterFor });
      assert.equal(submits(), 0); assert.equal((await claim(d)).error_code, "media_url_unavailable");
      await reset();

      // 12. A crash mid-submit leaves "submitting"; the sweep marks it unknown and nothing resubmits.
      d = await seed({ state: "submitting" }); await c.query("UPDATE posting_slot_claims SET updated_at=to_timestamp($2) WHERE draft_id=$1", [d, (clock - STALE_SUBMITTING_MS - 1000) / 1000]);
      r = await tick("live"); assert.equal(r.unknown, 1); assert.equal(submits(), 0); assert.deepEqual([(await claim(d)).state, (await claim(d)).error_code], ["unknown", "interrupted"]);
      await reset();
      d = await seed({ state: "submitting" }); await c.query("UPDATE posting_slot_claims SET updated_at=to_timestamp($2) WHERE draft_id=$1", [d, (clock - 60_000) / 1000]); await tick("live"); assert.equal((await claim(d)).state, "submitting", "a fresh submit in flight is left alone");
      await reset();

      // 13. Two workers at once: exactly one submission.
      d = await seed(); script = { submit: async () => { await new Promise((ok) => setTimeout(ok, 50)); return { externalId: "buf-1", status: "sending" }; } };
      await Promise.all([tick("live"), tick("live"), tick("live")]); assert.equal(submits(), 1, "SKIP LOCKED plus the committed claim state");
      await reset();

      // 14. Status checks are budgeted: errors cost a check, and running out is "unknown", not a guess.
      d = await seed({ state: "submitted" }); await c.query("UPDATE posting_slot_claims SET external_id='buf-1',mode='live',next_check_at=to_timestamp($2),image_token_hash='x',image_expires_at=now()+interval '1 day' WHERE draft_id=$1", [d, (clock - 1000) / 1000]);
      script = { status: async () => { throw new SchedulerAmbiguous("down"); } };
      for (let i = 0; i < MAX_STATUS_CHECKS; i++) { await tick("live"); await c.query("UPDATE posting_slot_claims SET next_check_at=to_timestamp($2) WHERE draft_id=$1 AND state='submitted'", [d, (clock - 1000) / 1000]); }
      row = await claim(d); assert.deepEqual([row.state, row.error_code], ["unknown", "no_final_status"]); assert.equal(checks(), MAX_STATUS_CHECKS); assert.equal(await status(d), "scheduled");
      await reset();

      // 15. The public route: every miss looks the same.
      d = await seed(); await tick("live"); const good = tokenOf();
      const misses = [`${good.slice(0, -1)}A`, "short", "x".repeat(43), "../../etc/passwd", `${good}%00`, ""];
      for (const m of misses) { const res = await fetchImage(m); assert.equal(res.status, 404, m); assert.equal(res.headers.get("cache-control"), "no-store"); assert.equal(await res.text(), ""); }
      assert.equal((await publicMedia(new NextRequest(`http://localhost/api/public-media/${good}`), { params: Promise.resolve({ name: good }) })).status, 404, "needs the .png suffix");
      assert.equal(await resolvePublicImage(good), "fixture.png");
      for (const state of ["queued", "sent", "error", "missed"]) { await c.query("UPDATE posting_slot_claims SET state=$2 WHERE draft_id=$1", [d, state]); assert.equal(await resolvePublicImage(good), null, `${state} serves nothing`); }
      for (const state of ["submitting", "submitted", "unknown", "drafted"]) { await c.query("UPDATE posting_slot_claims SET state=$2 WHERE draft_id=$1", [d, state]); assert.equal(await resolvePublicImage(good), "fixture.png", state); }
      await c.query("DELETE FROM draft_posts WHERE id=$1", [d]); assert.equal(await resolvePublicImage(good), null, "deleting the post removes the link");
      await reset();
    });
  } finally { globalThis.fetch = realFetch; rmSync(root, { recursive: true, force: true }); }
  console.log("buffer posting gate/state machine/public image tests passed (fake Buffer only)");
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
