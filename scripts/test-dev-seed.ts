import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { databaseFixture } from "./db-fixture";
import { assertSeedable } from "./seed/guard";
import { SEED_BUSINESSES } from "./seed/fixtures";
import { runSeed } from "./seed/seed";
import { entitlementsFor } from "../lib/services/entitlements";

const DEV = { MOBILE_DEV_AUTH: "1", NODE_ENV: "development" };

// Everything a person can see, without row ids (a re-seed rebuilds rows, so ids move).
async function snapshot(client: PoolClient, media: string) {
  const rows = async (sql: string) => (await client.query(sql)).rows;
  return {
    owners: await rows("SELECT id,email,name FROM auth_users ORDER BY id"),
    methods: await rows("SELECT owner_id,provider,provider_account_id,email FROM auth_accounts ORDER BY owner_id,provider"),
    plans: await rows("SELECT owner_id,plan,source FROM owner_plans ORDER BY owner_id"),
    planEvents: await rows("SELECT owner_id,plan,actor FROM owner_plan_events ORDER BY owner_id,id"),
    tokens: await rows("SELECT owner_id,token,platform FROM device_push_tokens ORDER BY token"),
    businesses: await rows("SELECT name,owner_id,timezone,brand_tone,brand_colors,weekly_target,brand_voice FROM businesses ORDER BY name"),
    reviews: await rows(`SELECT b.name,r.source_review_id,r.rating,r.author_name,r.text,r.reviewed_at,r.duplicate_of IS NULL canonical
      FROM reviews r JOIN businesses b ON b.id=r.business_id ORDER BY b.name,r.source_review_id`),
    drafts: await rows(`SELECT b.name,r.source_review_id,d.status,d.quote_text,d.caption_text,d.audit_note,d.image_path IS NOT NULL has_image,
      d.shared_at IS NOT NULL has_shared_at,d.version,
      (SELECT string_agg(e.from_status||'>'||e.to_status||':'||e.reason,',' ORDER BY e.id) FROM draft_events e WHERE e.draft_id=d.id) history,
      (SELECT state||':'||attempts FROM generation_jobs j WHERE j.draft_id=d.id) job
      FROM draft_posts d JOIN businesses b ON b.id=d.business_id JOIN reviews r ON r.id=d.review_id ORDER BY b.name,r.source_review_id`),
    periods: await rows("SELECT b.name,p.target,p.allocated,p.completed,p.reason FROM generation_periods p JOIN businesses b ON b.id=p.business_id ORDER BY b.name"),
    google: await rows("SELECT b.name,g.location_name,g.status,g.encrypted_refresh_token IS NULL no_token FROM google_connections g JOIN businesses b ON b.id=g.business_id ORDER BY b.name"),
    images: readdirSync(media).length
  };
}

async function main() {
  // The guard fails closed before any database is touched.
  assert.throws(() => assertSeedable({ DATABASE_URL: "postgres://u:p@localhost:5432/d" }), /MOBILE_DEV_AUTH/);
  assert.throws(() => assertSeedable({ ...DEV, NODE_ENV: "production", DATABASE_URL: "postgres://u:p@localhost:5432/d" }), /production/);
  assert.throws(() => assertSeedable({ ...DEV }), /DATABASE_URL is not set/);
  assert.throws(() => assertSeedable({ ...DEV, DATABASE_URL: "not a url" }), /not a valid URL/);
  for (const remote of ["postgres://u:p@db.example.com:5432/d", "postgres://u:p@10.0.0.5/d", "postgres://u:p@postgres.internal/d", "postgres://u:p@localhost.example.com/d"]) {
    assert.throws(() => assertSeedable({ ...DEV, DATABASE_URL: remote }), /not a local development database/, remote);
  }
  for (const local of ["postgres://u:p@localhost:55432/d", "postgres://u:p@127.0.0.1/d", "postgres://u:p@[::1]:5432/d", "postgresql://u:p@postgres:5432/d", "postgres:///d"]) {
    assert.doesNotThrow(() => assertSeedable({ ...DEV, DATABASE_URL: local }), local);
  }

  if (!process.env.TEST_DATABASE_URL) {
    console.log("Dev seed database tests skipped: set TEST_DATABASE_URL");
    return;
  }

  const media = mkdtempSync(join(tmpdir(), "dev-seed-media-"));
  const saved = { MOBILE_DEV_AUTH: process.env.MOBILE_DEV_AUTH, MEDIA_ROOT: process.env.MEDIA_ROOT, NODE_ENV: process.env.NODE_ENV };
  try {
    await databaseFixture(async client => {
      process.env.MOBILE_DEV_AUTH = "1";
      process.env.MEDIA_ROOT = media;
      (process.env as Record<string, string>).NODE_ENV = "development";

      // A real owner's data, which the seeder must never touch.
      await client.query("INSERT INTO auth_users(id,email) VALUES('real-owner','real@example.invalid')");
      await client.query("INSERT INTO businesses(name,timezone,owner_id) VALUES('Real Bakery','UTC','real-owner')");
      await client.query("INSERT INTO owner_plans(owner_id,plan) VALUES('real-owner','pro')");
      const before = (await client.query("SELECT count(*) n FROM businesses")).rows[0].n;

      // A non-local database is refused with nothing written.
      await assert.rejects(runSeed({ ...DEV, DATABASE_URL: "postgres://u:p@db.example.com:5432/d" }), /not a local development database/);
      assert.equal((await client.query("SELECT count(*) n FROM businesses")).rows[0].n, before);

      const first = await runSeed();
      const one = await snapshot(client, media);

      assert.deepEqual(first.owners, { "dev-owner": "pro", "dev-owner-free": "free", "dev-owner-email": "free" });
      assert.deepEqual(one.methods.map(m => [m.owner_id, m.provider, m.email]), [
        ["dev-owner", "google", "demo@praiseloop.invalid"],
        ["dev-owner-email", "email", "demo-email@praiseloop.invalid"],
        ["dev-owner-free", "google", "demo-free@praiseloop.invalid"]
      ], "each demo owner has a synthetic method to walk the account screen");
      assert.equal(first.businesses.length, SEED_BUSINESSES.length);
      const seeded = one.businesses.filter(b => b.owner_id !== "real-owner");
      assert.deepEqual(seeded.map(b => b.name).sort(), SEED_BUSINESSES.map(b => b.name).sort());
      assert.equal(seeded.every(b => b.name.startsWith("Demo — ")), true);
      assert.deepEqual(first.businesses.map(b => b.reviews), [21, 24, 17], "every CSV row is imported");
      assert.equal((await entitlementsFor("dev-owner")).plan, "pro");
      assert.equal((await entitlementsFor("dev-owner-free")).plan, "free");
      assert.equal((await entitlementsFor("dev-owner-email")).plan, "free");
      assert.equal((await client.query("SELECT count(*)::int n FROM auth_accounts WHERE provider='email' AND owner_id='dev-owner-email'")).rows[0].n, 1);
      assert.equal(one.owners.every(o => String(o.email).endsWith(".invalid")), true, "synthetic emails only");
      assert.equal(one.owners.find(o => o.id === "dev-owner-free")!.name, null, "the Free demo owner has no name for the profile empty state");
      assert.equal(one.owners.find(o => o.id === "dev-owner")!.name, "Demo Owner");

      // Reviews span ratings and dates; the Hespeler CSV came in through the same import.
      const ratings = new Set(one.reviews.map(r => r.rating));
      assert.deepEqual([...ratings].sort(), [1, 2, 3, 4, 5]);
      assert.ok(one.reviews.every(r => r.canonical && /^sample-(cafe|hpc|bike)-\d{3}$/.test(r.source_review_id)));
      assert.ok(new Set(one.reviews.map(r => String(r.reviewed_at.getUTCFullYear()) + r.reviewed_at.getUTCMonth())).size >= 4, "reviews span several months");

      // Every lifecycle status is present, quotes are verbatim, and images exist where a draft has one.
      const statuses = new Set(one.drafts.map(d => d.status));
      assert.deepEqual([...statuses].sort(), ["approved", "archived", "draft", "failed", "shared"]);
      const reviewText = new Map(one.reviews.map(r => [`${r.name}/${r.source_review_id}`, r.text as string]));
      for (const d of one.drafts) {
        assert.ok(reviewText.get(`${d.name}/${d.source_review_id}`)!.includes(d.quote_text), `${d.source_review_id} quote is verbatim`);
        assert.equal(d.has_image, d.status !== "failed");
        assert.equal(d.caption_text === "", d.status === "failed");
        assert.equal(d.has_shared_at, d.status === "shared");
      }
      assert.equal(one.drafts.filter(d => d.status === "failed").every(d => d.job === "failed:3" && d.audit_note === "generation_failed"), true);
      assert.equal(one.images, one.drafts.filter(d => d.has_image).length, "one rendered file per imaged draft");
      for (const file of readdirSync(media)) assert.ok(file.endsWith(".png"));
      assert.equal(one.tokens.length, 1);
      assert.deepEqual(one.google.map(g => [g.name, g.no_token]), [["Demo — Copper Kettle Café", true]]);
      assert.equal(one.periods.length, SEED_BUSINESSES.length);
      assert.ok(one.periods.find(p => p.name.includes("Harbour"))!.target <= 1, "the Free business is capped at its plan");
      assert.match(one.businesses.find(b => b.name.includes("Copper Kettle"))!.brand_voice, /Warm, neighbourly/, "the Pro demo business has a sample voice");
      assert.equal(one.businesses.filter(b => b.name.startsWith("Demo — ") && !b.name.includes("Copper Kettle")).every(b => b.brand_voice === null), true, "the other demo businesses keep the tone fallback");

      // The seeded rows are the only ones changed.
      assert.equal((await client.query("SELECT count(*) n FROM businesses WHERE owner_id='real-owner'")).rows[0].n, "1");
      assert.equal((await client.query("SELECT plan FROM owner_plans WHERE owner_id='real-owner'")).rows[0].plan, "pro");

      // Running it again changes nothing a person can see.
      const second = await runSeed();
      const two = await snapshot(client, media);
      assert.deepEqual(second, first);
      assert.deepEqual(two, one);
      assert.equal((await client.query("SELECT count(*) n FROM businesses")).rows[0].n, String(Number(before) + SEED_BUSINESSES.length));
      assert.equal((await client.query("SELECT count(*) n FROM businesses WHERE owner_id='real-owner'")).rows[0].n, "1");
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(media, { recursive: true, force: true });
  }

  console.log("dev seed tests passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
