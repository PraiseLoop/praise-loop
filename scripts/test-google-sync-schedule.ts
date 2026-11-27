import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { databaseFixture } from "./db-fixture";
import { setOwnerPlan } from "../lib/services/entitlements";
import {
  connect,
  GoogleApiError,
  syncReviews,
  type GoogleReview,
  type GoogleReviewsClient
} from "../lib/integrations/googleReviews";
import {
  googleSyncBatchSize,
  googleSyncIntervalHours,
  googleSyncTick,
  type GoogleSyncDeps
} from "../lib/services/googleSync";

// Offline schedule tests: the Google client is injected, every owner and review
// is synthetic, and no provider endpoint is ever reached.
const ENV = {
  GOOGLE_REVIEW_SYNC: "1",
  GOOGLE_CLIENT_ID: "synthetic-google-client",
  GOOGLE_CLIENT_SECRET: "synthetic-google-secret",
  GOOGLE_TOKEN_KEY: "",
  NEXTAUTH_URL: "http://localhost"
};
const ZERO = { due: 0, synced: 0, failed: 0, revoked: 0, skipped: 0, imported: 0, updated: 0 };
const review = (id: string): GoogleReview => ({
  reviewId: id, rating: 5, comment: "Synthetic kind words", reviewerName: "Example",
  createTime: "2026-11-01T00:00:00Z", updateTime: "2026-11-01T00:00:00Z"
});

type Fake = {
  client: GoogleReviewsClient;
  factory: () => GoogleReviewsClient;
  calls: { built: number; refresh: number; list: string[] };
};
function fake(onList: (location: string) => GoogleReview[] | Error = () => []): Fake {
  const calls = { built: 0, refresh: 0, list: [] as string[] };
  const client: GoogleReviewsClient = {
    async refreshAccessToken() { calls.refresh += 1; return "synthetic-access-token"; },
    async listReviews(_access, location) {
      calls.list.push(location);
      const result = onList(location);
      if (result instanceof Error) throw result;
      return { reviews: result };
    },
    async revoke() { throw new Error("the schedule must not revoke a token"); }
  };
  return { client, factory: () => { calls.built += 1; return client; }, calls };
}

async function main() {
  const savedKey = process.env.GOOGLE_TOKEN_KEY;
  process.env.GOOGLE_TOKEN_KEY = randomBytes(32).toString("base64");
  ENV.GOOGLE_TOKEN_KEY = process.env.GOOGLE_TOKEN_KEY;
  let fixtureRan = false;
  try {
    await databaseFixture(async c => {
      fixtureRan = true;
      const holdAll = () => c.query("UPDATE google_connections SET last_attempt_at=now()");
      const makeDue = (businessId: number, ago = "7 hours") =>
        c.query("UPDATE google_connections SET last_attempt_at=now()-$1::interval WHERE business_id=$2", [ago, businessId]);
      const attemptOf = async (businessId: number) =>
        (await c.query<{ last_attempt_at: Date | null }>("SELECT last_attempt_at FROM google_connections WHERE business_id=$1", [businessId])).rows[0].last_attempt_at;
      const connectionOf = async (businessId: number) =>
        (await c.query<{ status: string; token: string | null }>(
          "SELECT status,encrypted_refresh_token token FROM google_connections WHERE business_id=$1", [businessId])).rows[0];

      const paid = async (owner: string): Promise<number> => {
        await c.query("INSERT INTO auth_users(id,email) VALUES($1,$2)", [owner, `${owner}@example.invalid`]);
        const business = Number((await c.query(
          "INSERT INTO businesses(owner_id,name,timezone) VALUES($1,$2,'UTC') RETURNING id",
          [owner, `Synthetic ${owner}`]
        )).rows[0].id);
        await setOwnerPlan(owner, "pro", { reason: "Synthetic schedule plan" });
        await connect(owner, business, `accounts/1/locations/${business}`, `synthetic-refresh-${owner}`);
        return business;
      };

      // Interval and batch parsing: clamp the range, default on garbage.
      assert.equal(googleSyncIntervalHours({}), 6);
      assert.equal(googleSyncIntervalHours({ GOOGLE_SYNC_INTERVAL_HOURS: "2" }), 2);
      assert.equal(googleSyncIntervalHours({ GOOGLE_SYNC_INTERVAL_HOURS: "0" }), 1);
      assert.equal(googleSyncIntervalHours({ GOOGLE_SYNC_INTERVAL_HOURS: "999" }), 168);
      assert.equal(googleSyncIntervalHours({ GOOGLE_SYNC_INTERVAL_HOURS: "garbage" }), 6);
      assert.equal(googleSyncBatchSize({}), 3);
      assert.equal(googleSyncBatchSize({ GOOGLE_SYNC_BATCH: "5" }), 5);
      assert.equal(googleSyncBatchSize({ GOOGLE_SYNC_BATCH: "0" }), 3);
      assert.equal(googleSyncBatchSize({ GOOGLE_SYNC_BATCH: "two" }), 3);

      // A flag-off tick returns zeros and neither queries nor builds a client.
      const off = fake();
      const offDeps: GoogleSyncDeps = { env: { ...ENV, GOOGLE_REVIEW_SYNC: undefined }, clientFactory: off.factory };
      assert.deepEqual(await googleSyncTick(offDeps), ZERO);
      assert.deepEqual(await googleSyncTick({ ...offDeps, env: { ...ENV, GOOGLE_CLIENT_SECRET: undefined } }), ZERO);
      assert.equal(off.calls.built, 0);
      const noWork = fake();
      assert.deepEqual(await googleSyncTick({ env: ENV, clientFactory: noWork.factory }), ZERO, "nothing is due yet");
      assert.equal(noWork.calls.built, 0, "an empty due set builds no client");

      const paidIds: number[] = [];
      for (const owner of ["gs-a", "gs-b", "gs-c", "gs-d", "gs-e", "gs-f"]) paidIds.push(await paid(owner));
      const [a, b, cBiz, d, e, f] = paidIds;
      const freeOwner = "gs-free";
      const lapsedOwner = "gs-lapsed";
      await c.query("INSERT INTO auth_users(id,email) VALUES($1,$2),($3,$4)", [freeOwner, `${freeOwner}@example.invalid`, lapsedOwner, `${lapsedOwner}@example.invalid`]);
      const businessOf = async (owner: string) => Number((await c.query(
        "INSERT INTO businesses(owner_id,name,timezone) VALUES($1,$2,'UTC') RETURNING id", [owner, `Synthetic ${owner}`]
      )).rows[0].id);
      const freeBiz = await businessOf(freeOwner);
      const lapsedBiz = await businessOf(lapsedOwner);
      await connect(freeOwner, freeBiz, `accounts/1/locations/${freeBiz}`, "synthetic-refresh-free");
      await connect(lapsedOwner, lapsedBiz, `accounts/1/locations/${lapsedBiz}`, "synthetic-refresh-lapsed");
      await setOwnerPlan(lapsedOwner, "pro", {
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000), reason: "Synthetic expired plan"
      });

      // Free and lapsed owners are skipped and not deleted. They are claimed, so they wait an
      // interval rather than being re-read on every tick, and sync after the plan is restored.
      await holdAll();
      await makeDue(freeBiz);
      await makeDue(lapsedBiz);
      const skippedClient = fake(() => [review("r-should-not-import")]);
      const skipped = await googleSyncTick({ env: ENV, client: skippedClient.client });
      assert.deepEqual([skipped.due, skipped.skipped, skipped.synced], [2, 2, 0]);
      assert.deepEqual(await googleSyncTick({ env: ENV, client: skippedClient.client }), ZERO, "not re-read before the interval");
      assert.equal(skippedClient.calls.list.length, 0);
      assert.equal((await c.query("SELECT count(*)::int n FROM reviews WHERE source_review_id='r-should-not-import'")).rows[0].n, 0);
      assert.equal((await connectionOf(freeBiz)).status, "active", "a lapsed plan keeps the connection");
      await setOwnerPlan(freeOwner, "pro", { reason: "Synthetic upgrade" });
      await setOwnerPlan(lapsedOwner, "pro", { reason: "Synthetic renewal" });
      await makeDue(freeBiz);
      await makeDue(lapsedBiz);
      const restored = await googleSyncTick({ env: ENV, client: fake(() => [review("r-restored")]).client });
      assert.deepEqual([restored.due, restored.synced, restored.imported], [2, 2, 2]);

      // Due is decided by the interval: 2 hours ago is not due at six hours.
      await holdAll();
      await makeDue(a, "2 hours");
      await makeDue(b, "7 hours");
      const intervalClient = fake(() => [review("r-interval")]);
      const byInterval = await googleSyncTick({ env: ENV, client: intervalClient.client });
      assert.deepEqual([byInterval.due, byInterval.synced], [1, 1]);
      await holdAll();
      await makeDue(a, "2 hours");
      const shortInterval = await googleSyncTick({ env: { ...ENV, GOOGLE_SYNC_INTERVAL_HOURS: "1" }, client: fake(() => [review("r-1h")]).client });
      assert.equal(shortInterval.due, 1, "a one-hour interval makes the two-hour-old row due");
      await holdAll();
      await makeDue(a, "2 hours");
      const longInterval = await googleSyncTick({ env: { ...ENV, GOOGLE_SYNC_INTERVAL_HOURS: "168" }, client: fake().client });
      assert.equal(longInterval.due, 0, "a week-long interval leaves it alone");

      // At most GOOGLE_SYNC_BATCH rows are claimed in one tick.
      await holdAll();
      for (const id of [a, b, cBiz, d, e]) await makeDue(id, "7 hours");
      const firstBatch = await googleSyncTick({ env: { ...ENV, GOOGLE_SYNC_BATCH: "2" }, client: fake(() => [review("r-batch")]).client });
      assert.deepEqual([firstBatch.due, firstBatch.synced], [2, 2]);
      const secondBatch = await googleSyncTick({ env: ENV, client: fake(() => [review("r-batch")]).client });
      assert.deepEqual([secondBatch.due, secondBatch.synced], [3, 3]);
      const thirdBatch = await googleSyncTick({ env: ENV, client: fake().client });
      assert.equal(thirdBatch.due, 0, "claimed rows are not retried immediately");

      // A failure still claims the row: the next tick backs off until the interval passes.
      await holdAll();
      await makeDue(f, "7 hours");
      const failing = await googleSyncTick({ env: ENV, client: fake(() => new Error("synthetic provider failure")).client });
      assert.deepEqual([failing.due, failing.failed], [1, 1]);
      assert.ok(await attemptOf(f), "the attempt is recorded before the provider call");
      const backedOff = await googleSyncTick({ env: ENV, client: fake(() => [review("r-backoff")]).client });
      assert.deepEqual([backedOff.due, backedOff.synced], [0, 0]);
      await makeDue(f, "7 hours");
      const retried = await googleSyncTick({ env: ENV, client: fake(() => [review("r-backoff")]).client });
      assert.deepEqual([retried.due, retried.synced], [1, 1]);

      // One connection throwing out of syncReviews cannot stop the rest of the batch.
      await holdAll();
      await makeDue(a, "7 hours");
      await makeDue(b, "7 hours");
      const resilient = await googleSyncTick({
        env: ENV,
        client: fake(() => [review("r-resilient")]).client,
        sync: async (client, businessId) => {
          if (businessId === a) throw new Error("synthetic unexpected failure");
          return syncReviews(client, businessId);
        }
      });
      assert.deepEqual([resilient.due, resilient.failed, resilient.synced, resilient.imported], [2, 1, 1, 1]);
      assert.ok(await attemptOf(a), "the throwing connection was claimed too");

      // Revoked consent is counted, drops the token and is no longer due.
      await holdAll();
      await makeDue(cBiz, "7 hours");
      const revokedClient: GoogleReviewsClient = {
        async refreshAccessToken() { throw new GoogleApiError(400, "invalid_grant"); },
        async listReviews() { return { reviews: [] }; },
        async revoke() { throw new Error("the schedule must not revoke a token"); }
      };
      const revoked = await googleSyncTick({ env: ENV, client: revokedClient });
      assert.deepEqual([revoked.due, revoked.revoked], [1, 1]);
      const revokedRow = await connectionOf(cBiz);
      assert.deepEqual([revokedRow.status, revokedRow.token], ["revoked", null]);
      await holdAll();
      const afterRevoke = await googleSyncTick({ env: ENV, client: fake().client });
      assert.equal(afterRevoke.due, 0, "a revoked connection is not due");

      // Reconnecting clears the claim so the location syncs on the next tick.
      await holdAll();
      assert.ok(await attemptOf(b), "the row was claimed by an earlier tick");
      const reconnected = await connect("gs-b", b, `accounts/1/locations/${b}`, "synthetic-refresh-reconnected");
      assert.ok(reconnected);
      assert.equal(await attemptOf(b), null, "reconnect makes it due immediately");
      const afterReconnect = await googleSyncTick({ env: ENV, client: fake(() => [review("r-reconnect")]).client });
      assert.deepEqual([afterReconnect.due, afterReconnect.synced], [1, 1]);
      assert.ok(await attemptOf(b));
    });
  } finally {
    if (savedKey === undefined) delete process.env.GOOGLE_TOKEN_KEY;
    else process.env.GOOGLE_TOKEN_KEY = savedKey;
  }
  if (!fixtureRan) console.log("Google sync schedule Postgres fixture skipped: set TEST_DATABASE_URL");
  console.log("google sync schedule tests passed (injected client, no live calls)");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
