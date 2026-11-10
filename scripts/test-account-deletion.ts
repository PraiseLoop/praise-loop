import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NextRequest } from "next/server";
import type { PoolClient } from "pg";
import { databaseFixture } from "./db-fixture";
import { sessionHash } from "../lib/auth-adapter";
import { createMobileSession } from "../lib/mobileSessions";
import { mediaFilename, removeMediaFiles } from "../lib/services/accountDeletion";
import {
  failFakeBillingCancellation,
  fakeBillingCancelledIds,
  resetFakeBillingCancellations
} from "../lib/integrations/billing";

const PERIOD = "2026-10-26";

type Seeded = {
  owner: string;
  businessId: number;
  reviewId: number;
  draftIds: number[];
  webToken: string;
  mobileToken: string;
  emails: string[];
};

async function seedOwner(client: PoolClient, owner: string, label: string, withDirectory = false): Promise<Seeded> {
  const email = `${owner}@example.invalid`;
  const alias = `alias-${owner}@example.invalid`;
  const webToken = `${owner}-web-session`;
  await client.query("INSERT INTO auth_users(id,name,email) VALUES($1,$2,$3)", [owner, `Synthetic ${label}`, email]);
  await client.query(
    "INSERT INTO auth_accounts(provider,provider_account_id,owner_id,email) VALUES('google',$1,$2,$3)",
    [`sub-${owner}`, owner, alias]
  );
  await client.query(
    "INSERT INTO auth_sessions(token_hash,owner_id,expires,kind) VALUES($1,$2,now()+interval '1 hour','web')",
    [sessionHash(webToken), owner]
  );
  const mobile = await createMobileSession(owner);
  await client.query("INSERT INTO owner_usage(owner_id,day,kind,calls) VALUES($1,current_date,'generation',2)", [owner]);
  await client.query("INSERT INTO owner_plans(owner_id,plan) VALUES($1,'free')", [owner]);
  await client.query(
    "INSERT INTO owner_plan_events(owner_id,plan,source,actor,reason) VALUES($1,'free','manual','test','Synthetic event')",
    [owner]
  );
  // Billing (#219): a provider subscription and the event that created it both
  // belong to the owner and must disappear with the account.
  await client.query(
    "INSERT INTO owner_subscriptions(owner_id,provider,external_id,plan,status,current_period_end) VALUES($1,'fake',$2,'pro','active',now()+interval '30 days')",
    [owner, `sub-${owner}`]
  );
  await client.query(
    "INSERT INTO billing_events(provider,event_id,owner_id,type,occurred_at) VALUES('stripe',$1,$2,'checkout.completed',now())",
    [`evt-${owner}`, owner]
  );
  await client.query(
    "INSERT INTO device_push_tokens(owner_id,token,platform) VALUES($1,$2,'ios')",
    [owner, `ExponentPushToken[${owner}]`]
  );
  await client.query(
    "INSERT INTO sign_in_alerts(owner_id,method,last_sent_at) VALUES($1,'google',now())",
    [owner]
  );
  const business = (await client.query(
    "INSERT INTO businesses(name,timezone,owner_id,logo_url) VALUES($1,'UTC',$2,$3) RETURNING id",
    [`Synthetic ${label}`, owner, `/api/media/logo-${owner}.png`]
  )).rows[0].id;
  const review = (await client.query(
    "INSERT INTO reviews(business_id,source,rating,text,reviewed_at) VALUES($1,'manual',5,'Synthetic deletion review','2026-10-01') RETURNING id",
    [business]
  )).rows[0].id;
  const draft = (await client.query(
    "INSERT INTO draft_posts(business_id,review_id,quote_text,caption_text,image_path) VALUES($1,$2,'Synthetic quote','Synthetic caption',$3) RETURNING id",
    [business, review, `/api/media/draft-${owner}.png`]
  )).rows[0].id;
  const extra = (await client.query(
    "INSERT INTO draft_posts(business_id,quote_text,caption_text,image_path) VALUES($1,'Synthetic extra','Synthetic extra',$2) RETURNING id",
    [business, `/api/media/../outside-${owner}.png`]
  )).rows[0].id;
  const draftIds = [draft, extra];
  if (withDirectory) {
    draftIds.push((await client.query(
      "INSERT INTO draft_posts(business_id,quote_text,caption_text,image_path) VALUES($1,'Synthetic dir','Synthetic dir',$2) RETURNING id",
      [business, `/api/media/draft-dir-${owner}.png`]
    )).rows[0].id);
  }
  await client.query(
    "INSERT INTO generation_periods(business_id,period_start,timezone,target,allocated,completed) VALUES($1,$2,'UTC',3,1,1)",
    [business, PERIOD]
  );
  await client.query(
    "INSERT INTO generation_jobs(business_id,period_start,draft_id,state) VALUES($1,$2,$3,'complete')",
    [business, PERIOD, draft]
  );
  await client.query(
    "INSERT INTO draft_events(draft_id,actor_id,action,reason,from_status,to_status) VALUES($1,$2,'approve','Synthetic','draft','approved')",
    [draft, owner]
  );
  await client.query(
    "INSERT INTO posting_slot_claims(business_id,instant,draft_id,state) VALUES($1,'2026-11-02T10:00:00Z',$2,'queued')",
    [business, draft]
  );
  await client.query(
    "INSERT INTO google_connections(business_id,owner_id,location_name) VALUES($1,$2,'accounts/1/locations/2')",
    [business, owner]
  );
  // Apify stopgap (#232): a confirmed place and one run must cascade with the business.
  await client.query(
    "INSERT INTO apify_review_places(business_id,place_input,place_kind,confirmed_by) VALUES($1,$2,'place_id',$3)",
    [business, `ChIJsynthetic${owner}`, owner]
  );
  await client.query(
    "INSERT INTO apify_review_runs(business_id,run_id,dataset_id,status) VALUES($1,$2,$3,'SUCCEEDED')",
    [business, `apify-run-${owner}`, `apify-dataset-${owner}`]
  );
  // Buffer connect (#29): the owner connection, a pending state and a channel
  // selection. All three cascade from auth_users/businesses.
  await client.query(
    "INSERT INTO buffer_connections(owner_id,organization_id,encrypted_access_token,encrypted_refresh_token,access_expires_at,scope) VALUES($1,$2,'v1.synthetic','v1.synthetic',now()+interval '1 hour','posts:read')",
    [owner, `org-${owner}`]
  );
  await client.query(
    "INSERT INTO buffer_oauth_states(state_hash,owner_id,encrypted_code_verifier,expires_at) VALUES($1,$2,'v1.synthetic',now()+interval '10 minutes')",
    [`state-${owner}`, owner]
  );
  await client.query(
    "INSERT INTO business_buffer_channels(business_id,connection_id,channel_id,channel_name,service) SELECT $1,id,$2,'Synthetic channel','instagram' FROM buffer_connections WHERE owner_id=$3",
    [business, `channel-${owner}`, owner]
  );
  await client.query(
    "INSERT INTO push_deliveries(business_id,period_start,token,count) VALUES($1,$2,$3,1)",
    [business, PERIOD, `ExponentPushToken[delivery-${owner}]`]
  );
  await client.query(
    "INSERT INTO email_sign_in_codes(email,code_hash,expires_at) VALUES($1,'hash-a',now()+interval '10 minutes'),($2,'hash-b',now()+interval '10 minutes')",
    [email, alias]
  );
  return { owner, businessId: business, reviewId: review, draftIds, webToken, mobileToken: mobile.token, emails: [email, alias] };
}

// Every table an owner or their businesses can own. Scanning information_schema
// makes a table added later fail this test instead of silently keeping rows.
async function ownershipCounts(client: PoolClient, owner: string, businessIds: number[]) {
  const columns = (await client.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema=current_schema() AND column_name IN ('owner_id','business_id')`
  )).rows;
  const tables = new Map<string, Set<string>>();
  for (const row of columns) {
    if (!tables.has(row.table_name)) tables.set(row.table_name, new Set());
    tables.get(row.table_name)!.add(row.column_name);
  }
  const counts: Record<string, number> = {};
  for (const [table, cols] of tables) {
    const byOwner = cols.has("owner_id");
    const result = await client.query(
      `SELECT count(*) FROM "${table}" WHERE ${byOwner ? "owner_id=$1" : "business_id = ANY($1::bigint[])"}`,
      [byOwner ? owner : businessIds]
    );
    counts[table] = Number(result.rows[0].count);
  }
  return counts;
}

async function codeCount(client: PoolClient, emails: string[]) {
  return Number((await client.query(
    "SELECT count(*) FROM email_sign_in_codes WHERE lower(email) = ANY($1::text[])",
    [emails.map(email => email.toLowerCase())]
  )).rows[0].count);
}

function cookieRequest(token: string, method = "GET", body?: unknown, origin = "http://localhost") {
  return new NextRequest("http://localhost/api/account", {
    method,
    headers: {
      cookie: `next-auth.session-token=${token}`,
      origin,
      "content-type": "application/json"
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

function bearerRequest(token: string, method = "GET", body?: unknown) {
  return new NextRequest("http://localhost/api/account", {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

async function main() {
  process.env.NEXTAUTH_URL = "http://localhost";
  const savedBilling = process.env.BILLING_PROVIDER;
  const savedNodeEnv = process.env.NODE_ENV;
  process.env.BILLING_PROVIDER = "fake";
  (process.env as Record<string, string>).NODE_ENV = "test";
  resetFakeBillingCancellations();
  const root = mkdtempSync(join(tmpdir(), "account-deletion-media-"));
  const outside = resolve(root, "..", "outside-delete-a.png");
  process.env.MEDIA_ROOT = root;
  try {
    await databaseFixture(async client => {
      const a = await seedOwner(client, "delete-a", "A", true);
      const b = await seedOwner(client, "delete-b", "B");
      const d = await seedOwner(client, "delete-d", "D");
      const c = await seedOwner(client, "delete-c", "C");
      const e = await seedOwner(client, "delete-e", "E");
      const f = await seedOwner(client, "delete-f", "F");
      const g = await seedOwner(client, "delete-g", "G");

      // Every status that can still bill must be cancelled; a dead one must not.
      // The active row also has cancel_at_period_end set, which must not skip it.
      await client.query(
        "UPDATE owner_subscriptions SET cancel_at_period_end=true WHERE owner_id=$1 AND external_id=$2",
        [a.owner, `sub-${a.owner}`]
      );
      for (const status of ["past_due", "unpaid", "incomplete", "paused", "canceled", "incomplete_expired"]) {
        await client.query(
          "INSERT INTO owner_subscriptions(owner_id,provider,external_id,plan,status) VALUES($1,'fake',$2,'pro',$3)",
          [a.owner, `sub-${a.owner}-${status}`, status]
        );
      }

      // C has only a store subscription, which we cannot cancel. E has none.
      await client.query("UPDATE owner_subscriptions SET provider='store' WHERE owner_id=$1", [c.owner]);
      await client.query("DELETE FROM owner_subscriptions WHERE owner_id=$1", [e.owner]);

      // F walks a partial failure: one fake cancel succeeds, the next fails, and
      // a row from a provider with no adapter in this process follows.
      await client.query(
        "INSERT INTO owner_subscriptions(owner_id,provider,external_id,plan,status) VALUES($1,'fake',$2,'pro','active'),($1,'stripe',$3,'pro','active')",
        [f.owner, `sub-${f.owner}-second`, `sub-${f.owner}-unknown-provider`]
      );

      // Owner A's media, plus a traversal target outside MEDIA_ROOT. The directory
      // named like an image makes the real cleanup fail for one file.
      for (const name of ["draft-delete-a.png", "logo-delete-a.png"]) writeFileSync(join(root, name), Buffer.from([137, 80, 78, 71]));
      mkdirSync(join(root, "draft-dir-delete-a.png"));
      writeFileSync(outside, Buffer.from([137, 80, 78, 71]));
      for (const name of ["draft-delete-b.png", "logo-delete-b.png"]) writeFileSync(join(root, name), Buffer.from([137, 80, 78, 71]));

      // A file that both A and B reference (images are content-addressed, so identical posts share one).
      writeFileSync(join(root, "shared-delete.png"), Buffer.from([137, 80, 78, 71]));
      for (const owner of [a, b]) {
        await client.query(
          "INSERT INTO draft_posts(business_id,quote_text,caption_text,image_path) VALUES($1,'Synthetic shared','Synthetic shared','/api/media/shared-delete.png')",
          [owner.businessId]
        );
      }

      // B's draft points at one of A's superseded renders: deleting A must keep that file.
      await client.query(
        "INSERT INTO draft_posts(business_id,quote_text,caption_text,image_path) VALUES($1,'Synthetic ref','Synthetic ref',$2)",
        [b.businessId, `/api/media/draft-${a.draftIds[0]}-0123456789abcdef0123.png`]
      );

      // Superseded renders of A's and B's drafts: no row points at them, but the names carry the draft id.
      for (const owner of [a, b]) {
        for (const suffix of ["-0123456789abcdef0123", "-fedcba98765432100123"]) {
          writeFileSync(join(root, `draft-${owner.draftIds[0]}${suffix}.png`), Buffer.from([137, 80, 78, 71]));
        }
      }

      const route = require("../app/api/account/route");
      const businesses = require("../app/api/businesses/route").GET;

      const beforeA = await ownershipCounts(client, a.owner, [a.businessId]);
      const beforeB = await ownershipCounts(client, b.owner, [b.businessId]);
      for (const table of [
        "auth_accounts", "auth_sessions", "owner_usage", "owner_plans",
        "owner_plan_events", "owner_subscriptions", "billing_events",
        "device_push_tokens", "sign_in_alerts", "businesses", "google_connections",
        "buffer_connections", "buffer_oauth_states", "business_buffer_channels",
        "apify_review_places", "apify_review_runs",
        "reviews", "draft_posts", "generation_periods", "generation_jobs",
        "posting_slot_claims", "push_deliveries"
      ]) {
        assert.ok(beforeA[table] > 0, `${table} has owner A data before deletion`);
      }
      assert.equal(await codeCount(client, a.emails), 2);
      assert.equal(await codeCount(client, b.emails), 2);
      assert.equal((await client.query(
        "SELECT count(*) FROM draft_events WHERE draft_id = ANY($1::bigint[])", [a.draftIds]
      )).rows[0].count, "1");
      const aSubscriptions = (await client.query<{ external_id: string; status: string }>(
        "SELECT external_id,status FROM owner_subscriptions WHERE owner_id=$1 ORDER BY id",
        [a.owner]
      )).rows;
      const aCancellable = aSubscriptions
        .filter(row => row.status !== "canceled" && row.status !== "incomplete_expired")
        .map(row => row.external_id);
      const aDead = aSubscriptions
        .filter(row => row.status === "canceled" || row.status === "incomplete_expired")
        .map(row => row.external_id);
      assert.equal(aCancellable.length, 5, "A has five subscriptions that can still bill");
      assert.equal(aDead.length, 2, "A has two dead subscriptions");

      // A wrong or missing confirmation changes nothing, for either session kind.
      assert.equal((await route.DELETE(cookieRequest(b.webToken, "DELETE", { confirm: "delete" }))).status, 400);
      assert.equal((await route.DELETE(cookieRequest(b.webToken, "DELETE"))).status, 400);
      assert.equal((await route.DELETE(bearerRequest(b.mobileToken, "DELETE", { confirm: "DELETE " }))).status, 400);
      assert.equal((await route.DELETE(cookieRequest(b.webToken, "DELETE", { confirm: "DELETE" }, "https://foreign.invalid"))).status, 403);
      assert.deepEqual(await ownershipCounts(client, b.owner, [b.businessId]), beforeB);
      assert.equal(await codeCount(client, b.emails), 2);
      assert.ok(existsSync(join(root, "draft-delete-b.png")));

      // Cookie session deletion: 200, cookie cleared, everything of A gone.
      const deleted = await route.DELETE(cookieRequest(a.webToken, "DELETE", { confirm: "DELETE" }));
      assert.equal(deleted.status, 200);
      assert.deepEqual(await deleted.json(), { ok: true });
      const cleared = deleted.headers.get("set-cookie") ?? "";
      assert.match(cleared, /next-auth\.session-token=/);
      assert.match(cleared, /Expires=Thu, 01 Jan 1970/);

      const afterA = await ownershipCounts(client, a.owner, [a.businessId]);
      for (const [table, count] of Object.entries(afterA)) assert.equal(count, 0, `${table} still has owner A rows`);
      assert.equal((await client.query("SELECT count(*) FROM auth_users WHERE id=$1", [a.owner])).rows[0].count, "0");
      assert.equal((await client.query(
        "SELECT count(*) FROM draft_events WHERE draft_id = ANY($1::bigint[])", [a.draftIds]
      )).rows[0].count, "0");
      assert.equal(await codeCount(client, a.emails), 0);
      assert.equal((await route.DELETE(cookieRequest(a.webToken, "DELETE", { confirm: "DELETE" }))).status, 401);
      for (const id of aCancellable) assert.ok(fakeBillingCancelledIds().includes(id), `${id} was cancelled before deletion`);
      for (const id of aDead) assert.equal(fakeBillingCancelledIds().includes(id), false, `${id} was already dead and not cancelled`);

      // B is untouched: same rows, same code, same media, still signed in.
      assert.deepEqual(await ownershipCounts(client, b.owner, [b.businessId]), beforeB);
      assert.equal(await codeCount(client, b.emails), 2);
      for (const name of ["draft-delete-b.png", "logo-delete-b.png", "shared-delete.png"]) assert.ok(existsSync(join(root, name)), `${name} remains`);
      assert.equal((await businesses(cookieRequest(b.webToken))).status, 200);
      assert.equal((await businesses(bearerRequest(b.mobileToken))).status, 200);

      // A's files are gone; the failed directory removal did not fail the request,
      // and the traversal target outside MEDIA_ROOT was never touched.
      for (const name of ["draft-delete-a.png", "logo-delete-a.png"]) assert.equal(existsSync(join(root, name)), false, `${name} removed`);
      assert.equal(existsSync(join(root, `draft-${a.draftIds[0]}-fedcba98765432100123.png`)), false, "A's older image version removed");
      assert.ok(existsSync(join(root, `draft-${a.draftIds[0]}-0123456789abcdef0123.png`)), "an older version B's draft still uses remains");
      for (const suffix of ["-0123456789abcdef0123", "-fedcba98765432100123"]) {
        assert.ok(existsSync(join(root, `draft-${b.draftIds[0]}${suffix}.png`)), "B's own older image version remains");
      }
      assert.ok(existsSync(join(root, "draft-dir-delete-a.png")), "unremovable path left the request successful");
      assert.ok(existsSync(outside), "path traversal target remains");
      rmSync(join(root, "draft-dir-delete-a.png"), { recursive: true, force: true });
      await removeMediaFiles(["draft-dir-delete-a.png"]);

      // The deleted owner's bearer token stops working immediately, as does the cookie.
      assert.equal((await businesses(bearerRequest(a.mobileToken))).status, 401);
      assert.equal((await businesses(cookieRequest(a.webToken))).status, 401);
      assert.equal((await client.query("SELECT count(*) FROM auth_sessions WHERE owner_id=$1", [a.owner])).rows[0].count, "0");

      // Bearer deletion works too and sends no cookie.
      const bearerDeleted = await route.DELETE(bearerRequest(d.mobileToken, "DELETE", { confirm: "DELETE" }));
      assert.equal(bearerDeleted.status, 200);
      assert.equal(bearerDeleted.headers.get("set-cookie"), null);
      assert.equal((await businesses(cookieRequest(d.webToken))).status, 401);
      assert.equal((await businesses(bearerRequest(d.mobileToken))).status, 401);

      // A failed cancel stops the deletion and keeps the account and session. The
      // first subscription was already cancelled, so the retry must cope with it.
      resetFakeBillingCancellations();
      const fSubscriptions = (await client.query<{ external_id: string }>(
        "SELECT external_id FROM owner_subscriptions WHERE owner_id=$1 ORDER BY id",
        [f.owner]
      )).rows.map(row => row.external_id);
      assert.deepEqual(fSubscriptions, [
        `sub-${f.owner}`, `sub-${f.owner}-second`, `sub-${f.owner}-unknown-provider`
      ]);
      const beforeF = await ownershipCounts(client, f.owner, [f.businessId]);
      failFakeBillingCancellation(fSubscriptions[1]);
      const failedCancel = await route.DELETE(cookieRequest(f.webToken, "DELETE", { confirm: "DELETE" }));
      assert.equal(failedCancel.status, 503);
      assert.match((await failedCancel.json()).error, /not deleted.*try again/i);
      assert.deepEqual(fakeBillingCancelledIds(), [fSubscriptions[0]], "only the first cancellation completed");
      assert.deepEqual(await ownershipCounts(client, f.owner, [f.businessId]), beforeF);
      assert.equal((await businesses(cookieRequest(f.webToken))).status, 200, "the session still works after a failed cancel");

      // The retry cancels the previously failed row, then stops on a provider
      // that has no adapter in this process instead of deleting and leaving it.
      failFakeBillingCancellation(fSubscriptions[1], false);
      const unknownProvider = await route.DELETE(cookieRequest(f.webToken, "DELETE", { confirm: "DELETE" }));
      assert.equal(unknownProvider.status, 503);
      assert.deepEqual(fakeBillingCancelledIds(), fSubscriptions.slice(0, 2), "the retry cancelled the previously failed row");
      assert.deepEqual(await ownershipCounts(client, f.owner, [f.businessId]), beforeF);
      assert.equal((await businesses(bearerRequest(f.mobileToken))).status, 200, "the bearer session still works too");

      // Once that row can be cancelled, the same request deletes the account.
      await client.query("UPDATE owner_subscriptions SET provider='fake' WHERE external_id=$1", [fSubscriptions[2]]);
      const fDeleted = await route.DELETE(cookieRequest(f.webToken, "DELETE", { confirm: "DELETE" }));
      assert.equal(fDeleted.status, 200);
      assert.deepEqual(fakeBillingCancelledIds(), fSubscriptions);
      for (const [table, count] of Object.entries(await ownershipCounts(client, f.owner, [f.businessId]))) {
        assert.equal(count, 0, `${table} still has owner F rows`);
      }
      assert.equal((await businesses(cookieRequest(f.webToken))).status, 401);

      // A store-only owner deletes without a billing provider: we cannot cancel
      // the store, and the store row does not need a provider adapter here.
      delete process.env.BILLING_PROVIDER;
      const cStoreId = (await client.query<{ external_id: string }>(
        "SELECT external_id FROM owner_subscriptions WHERE owner_id=$1", [c.owner]
      )).rows[0].external_id;
      const cDeleted = await route.DELETE(cookieRequest(c.webToken, "DELETE", { confirm: "DELETE" }));
      assert.equal(cDeleted.status, 200);
      assert.equal(fakeBillingCancelledIds().includes(cStoreId), false, "the store subscription was not cancelled by us");

      // A fake subscription can't charge anyone, so it doesn't block a deletion when
      // the fake provider is switched off, like the seeded demo owner in a dev stack.
      assert.equal((await route.DELETE(bearerRequest(g.mobileToken, "DELETE", { confirm: "DELETE" }))).status, 200);
      assert.equal((await businesses(bearerRequest(g.mobileToken))).status, 401);

      // An owner with no subscriptions deletes exactly as before, still with no
      // billing provider configured and so no provider call.
      const eDeleted = await route.DELETE(bearerRequest(e.mobileToken, "DELETE", { confirm: "DELETE" }));
      assert.equal(eDeleted.status, 200);
      assert.equal((await businesses(bearerRequest(e.mobileToken))).status, 401);

      // The cleanup helper is idempotent and safe to retry after a half failure.
      const retryRoot = mkdtempSync(join(tmpdir(), "account-deletion-retry-"));
      const previous = process.env.MEDIA_ROOT;
      process.env.MEDIA_ROOT = retryRoot;
      try {
        for (const name of ["retry-1.png", "retry-2.png"]) writeFileSync(join(retryRoot, name), Buffer.from([137, 80, 78, 71]));
        let calls = 0;
        await removeMediaFiles(["retry-1.png", "retry-2.png"], async file => {
          calls += 1;
          if (calls === 1) throw new Error("synthetic halfway failure");
          rmSync(file, { force: true });
        });
        assert.ok(existsSync(join(retryRoot, "retry-1.png")), "failed file remains for retry");
        assert.equal(existsSync(join(retryRoot, "retry-2.png")), false, "later file still removed");
        await removeMediaFiles(["retry-1.png", "retry-2.png"]);
        assert.equal(existsSync(join(retryRoot, "retry-1.png")), false, "retry completes");
        await removeMediaFiles(["retry-1.png"]);
      } finally {
        process.env.MEDIA_ROOT = previous;
        rmSync(retryRoot, { recursive: true, force: true });
      }

      // Collector rules: only one owned media name, never a traversal path.
      assert.equal(mediaFilename("/api/media/draft-1.png"), "draft-1.png");
      assert.equal(mediaFilename("/api/media/../outside.png"), null);
      assert.equal(mediaFilename("data:image/png;base64,AAAA"), null);
    });
    console.log("account deletion Postgres, session, isolation and media tests passed");
  } finally {
    resetFakeBillingCancellations();
    if (savedBilling === undefined) delete process.env.BILLING_PROVIDER;
    else process.env.BILLING_PROVIDER = savedBilling;
    if (savedNodeEnv === undefined) delete (process.env as Record<string, string>).NODE_ENV;
    else (process.env as Record<string, string>).NODE_ENV = savedNodeEnv;
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
