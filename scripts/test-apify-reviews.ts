import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { databaseFixture } from "./db-fixture";
import {
  ApifyError,
  FakeApifyReviewsClient,
  apifyRunInProgress,
  liveApifyClient,
  parseApifyPlace,
  type ApifyReviewsClient
} from "../lib/integrations/apifyReviews";
import {
  ApifyReviewError,
  apifyMaxChargeUsd,
  apifyReviewLimit,
  apifyRunIntervalHours,
  getApifyReviewsStatus,
  importApifyItems,
  shortReviewerName,
  startApifyReviews
} from "../lib/services/apifyReviews";

const REVIEW_TEXT = "A synthetic welcome from a friendly invented customer";
const ITEMS = [{
  reviews: [
    {
      reviewId: "apify-review-1",
      name: "Jane Doe",
      stars: 5,
      text: REVIEW_TEXT,
      publishedAtDate: "2026-10-01T10:00:00.000Z",
      reviewerId: "MUST_NOT_STORE_ID",
      reviewerUrl: "https://example.invalid/profile",
      reviewerPhotoUrl: "https://example.invalid/photo.jpg",
      reviewUrl: "https://example.invalid/review"
    },
    {
      reviewId: "apify-review-1",
      name: "Jane Doe",
      stars: 5,
      text: REVIEW_TEXT,
      publishedAtDate: "2026-10-01T10:00:00.000Z"
    },
    {
      reviewId: "apify-review-2",
      name: "Invalid Stars",
      stars: 6,
      text: "Synthetic review with invalid stars",
      publishedAtDate: "2026-10-02T10:00:00.000Z"
    },
    {
      reviewId: "apify-review-3",
      name: "No Text",
      stars: 4,
      text: "   ",
      publishedAtDate: "2026-10-03T10:00:00.000Z"
    },
    {
      reviewId: "apify-review-4",
      name: "Pat Lee",
      stars: 4,
      text: "Synthetic review with an invalid date",
      publishedAtDate: "not-a-date"
    }
  ]
}];

function responseQueue(responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected synthetic fetch");
    return next;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function headersOf(init: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(init.headers ?? {})) out[key.toLowerCase()] = String(value);
  return out;
}

async function main() {
  process.env.NEXTAUTH_URL = "http://localhost";
  delete process.env.APIFY_TOKEN;

  // Pure provider helpers: one place only, short reviewer name, plan caps.
  assert.deepEqual(parseApifyPlace("ChIJsynthetic123"), { kind: "place_id", value: "ChIJsynthetic123" });
  assert.equal(parseApifyPlace("https://www.google.com/maps/place/Synthetic/@1,2,17z/data=abc")?.kind, "place_url");
  assert.equal(parseApifyPlace("https://maps.app.goo.gl/synthetic")?.kind, "short_url");
  for (const invalid of [
    "coffee shop near me",
    "https://www.google.com/maps/search/coffee",
    "https://www.google.com/maps/dir/a/b",
    "https://example.invalid/maps/place/Synthetic",
    "ChIJone ChIJtwo",
    "ChIJone https://www.google.com/maps/place/Synthetic"
  ]) assert.equal(parseApifyPlace(invalid), null, invalid);

  assert.equal(shortReviewerName("Jane Doe"), "Jane D.");
  assert.equal(shortReviewerName("Jane"), "Jane");
  assert.equal(shortReviewerName("Jane Doe-Smith"), "Jane D.");
  assert.equal(shortReviewerName("Jane D."), "Jane D.");
  assert.equal(shortReviewerName("   "), null);
  assert.equal(shortReviewerName(null), null);

  const limitsEnv = {
    APIFY_REVIEW_LIMIT_FREE: "2",
    APIFY_REVIEW_LIMIT_PRO: "3",
    APIFY_REVIEW_LIMIT_BUSINESS: "4",
    APIFY_REVIEW_RUN_INTERVAL_HOURS: "6",
    APIFY_MAX_CHARGE_USD: "0.25"
  };
  assert.deepEqual(
    ["free", "pro", "business", "unknown"].map(plan => apifyReviewLimit(plan, limitsEnv)),
    [2, 3, 4, 2]
  );
  assert.equal(apifyReviewLimit("free", { APIFY_REVIEW_LIMIT_FREE: "not-a-number" }), 5);
  assert.equal(apifyReviewLimit("pro", {}), 10);
  assert.equal(apifyReviewLimit("business", {}), 15);
  assert.equal(apifyRunIntervalHours(limitsEnv), 6);
  assert.equal(apifyRunIntervalHours({ APIFY_REVIEW_RUN_INTERVAL_HOURS: "0" }), 24);
  assert.equal(apifyMaxChargeUsd(limitsEnv), 0.25);
  assert.equal(apifyMaxChargeUsd({ APIFY_MAX_CHARGE_USD: "-1" }), 0.5);
  assert.equal(apifyRunInProgress("READY"), true);
  assert.equal(apifyRunInProgress("ABORTING"), true);
  assert.equal(apifyRunInProgress("SUCCEEDED"), false);

  // Live client contract against a mocked fetch: token only in the header, never a URL,
  // and the actor fields a live run confirmed.
  const token = "synthetic-apify-token";
  const started = responseQueue([
    json({ data: { id: "run-live-1", status: "READY", defaultDatasetId: "dataset-live-1" } }),
    json({ data: { id: "run-live-1", status: "SUCCEEDED", defaultDatasetId: "dataset-live-1" } }),
    json([{ reviews: [] }])
  ]);
  const live = liveApifyClient({ env: { APIFY_TOKEN: token }, fetchImpl: started.fetchImpl });
  const run = await live.startRun({
    place: { kind: "place_id", value: "ChIJsynthetic123" },
    maxReviews: 7,
    maxChargeUsd: 0.5,
    since: "2026-10-01"
  });
  assert.deepEqual(run, { runId: "run-live-1", status: "READY", datasetId: "dataset-live-1" });
  assert.equal(started.calls[0].url, "https://api.apify.com/v2/actors/compass~crawler-google-places/runs?maxTotalChargeUsd=0.5");
  assert.equal(started.calls[0].url.includes(token), false, "token must not be in the URL");
  assert.equal(headersOf(started.calls[0].init).authorization, `Bearer ${token}`);
  const body = JSON.parse(String(started.calls[0].init.body));
  assert.deepEqual(body, {
    maxReviews: 7,
    reviewsSort: "newest",
    maxCrawledPlacesPerSearch: 1,
    scrapeReviewsPersonalData: true,
    language: "en",
    maxImages: 0,
    reviewsStartDate: "2026-10-01",
    placeIds: ["ChIJsynthetic123"]
  });
  assert.deepEqual(await live.getRun("run-live-1"), { runId: "run-live-1", status: "SUCCEEDED", datasetId: "dataset-live-1" });
  assert.equal(started.calls[1].url, "https://api.apify.com/v2/actor-runs/run-live-1");
  assert.deepEqual(await live.getDatasetItems("dataset-live-1"), [{ reviews: [] }]);
  assert.equal(started.calls[2].url, "https://api.apify.com/v2/datasets/dataset-live-1/items?clean=true&format=json");
  assert.equal(headersOf(started.calls[2].init).authorization, `Bearer ${token}`);
  assert.equal(JSON.stringify(started.calls.map(call => call.url)).includes(token), false);

  const urlPlace = responseQueue([json({ data: { id: "run-live-2", status: "READY", defaultDatasetId: "ds" } })]);
  await liveApifyClient({ env: { APIFY_TOKEN: token }, fetchImpl: urlPlace.fetchImpl }).startRun({
    place: { kind: "short_url", value: "https://maps.app.goo.gl/synthetic" },
    maxReviews: 5,
    maxChargeUsd: 0.5,
    since: null
  });
  assert.deepEqual(JSON.parse(String(urlPlace.calls[0].init.body)).startUrls, [{ url: "https://maps.app.goo.gl/synthetic" }]);
  assert.equal("reviewsStartDate" in JSON.parse(String(urlPlace.calls[0].init.body)), false);

  assert.throws(() => liveApifyClient({ env: {} }), (error: unknown) => error instanceof ApifyError && error.code === "unavailable");
  const denied = liveApifyClient({ env: { APIFY_TOKEN: token }, fetchImpl: async () => json({ error: "denied" }, 401) });
  await assert.rejects(
    () => denied.startRun({ place: { kind: "place_id", value: "ChIJsynthetic123" }, maxReviews: 5, maxChargeUsd: 0.5, since: null }),
    (error: unknown) => error instanceof ApifyError && error.code === "auth" && !error.message.includes(token)
  );

  // Route: GET reports the feature disabled without a token, POST fails closed.
  const boundary = require("../lib/authorization");
  boundary.ownerRoute = (handler: unknown) => handler;
  boundary.currentOwner = () => "apify-a";
  const route = require("../app/api/businesses/[id]/apify-reviews/route");

  const savedDailyLimit = process.env.OWNER_GENERATION_DAILY_LIMIT;
  try {
    await databaseFixture(async c => {
      await c.query("INSERT INTO auth_users(id,email) VALUES('apify-a','a@example.invalid'),('apify-b','b@example.invalid'),('apify-pro','pro@example.invalid'),('apify-daily','daily@example.invalid')");
      await c.query("INSERT INTO owner_plans(owner_id,plan) VALUES('apify-pro','pro')");
      const business = async (name: string, owner: string) =>
        (await c.query("INSERT INTO businesses(name,timezone,owner_id) VALUES($1,'UTC',$2) RETURNING id", [name, owner])).rows[0].id as number;
      const a = await business("Synthetic Apify A", "apify-a");
      const b = await business("Synthetic Apify B", "apify-b");
      const pro = await business("Synthetic Apify Pro", "apify-pro");
      const fail = await business("Synthetic Apify Failure", "apify-a");
      const daily = await business("Synthetic Apify Daily", "apify-daily");

      assert.equal((await route.GET(new NextRequest(`http://localhost/api/businesses/${a}/apify-reviews`), { params: Promise.resolve({ id: String(a) }) })).status, 200);
      const disabled = await (await route.GET(new NextRequest(`http://localhost/api/businesses/${a}/apify-reviews`), { params: Promise.resolve({ id: String(a) }) })).json();
      assert.equal(disabled.enabled, false, "missing token hides the feature");
      // GET is anonymous-route-safe at the wrapper level; the route itself returns 401 there.

      const post = route.POST(new NextRequest(`http://localhost/api/businesses/${a}/apify-reviews`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ place: "ChIJsynthetic123", confirmed: true })
      }), { params: Promise.resolve({ id: String(a) }) });
      assert.equal((await post).status, 503, "missing token fails the start closed");

      const now = new Date("2026-11-04T12:00:00.000Z");
      const env = { ...limitsEnv, APIFY_REVIEW_LIMIT_FREE: "2" };
      const fake = new FakeApifyReviewsClient({
        starts: [{ runId: "run-a-1", status: "READY", datasetId: "dataset-a-1" }],
        runs: { "run-a-1": { runId: "run-a-1", status: "SUCCEEDED", datasetId: "dataset-a-1" } },
        datasets: { "dataset-a-1": ITEMS }
      });
      const deps = { client: fake, env, now: () => now };

      await assert.rejects(
        () => startApifyReviews("apify-b", a, { place: "ChIJsynthetic123", confirmed: true }, deps),
        (error: unknown) => error instanceof ApifyReviewError && error.code === "not_found" && error.status === 404
      );
      await assert.rejects(
        () => getApifyReviewsStatus("apify-b", a, deps),
        (error: unknown) => error instanceof ApifyReviewError && error.code === "not_found"
      );
      await assert.rejects(
        () => startApifyReviews("apify-a", a, { place: "ChIJsynthetic123", confirmed: false }, deps),
        (error: unknown) => error instanceof ApifyReviewError && error.code === "confirmation_required"
      );
      await assert.rejects(
        () => startApifyReviews("apify-a", a, { place: "ChIJone ChIJtwo", confirmed: true }, deps),
        (error: unknown) => error instanceof ApifyReviewError && error.code === "invalid_place"
      );
      await assert.rejects(
        () => startApifyReviews("apify-a", a, { place: "coffee shop near me", confirmed: true }, deps),
        (error: unknown) => error instanceof ApifyReviewError && error.code === "invalid_place"
      );

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
      let startResponse!: Awaited<ReturnType<typeof startApifyReviews>>;
      let firstStatus!: Awaited<ReturnType<typeof getApifyReviewsStatus>>;
      try {
        startResponse = await startApifyReviews("apify-a", a, { place: "ChIJsynthetic123", confirmed: true }, deps);
        firstStatus = await getApifyReviewsStatus("apify-a", a, deps);
      } finally {
        console.log = originalLog;
      }
      assert.equal(fake.startRequests.length, 1);
      assert.deepEqual(fake.startRequests[0], {
        place: { kind: "place_id", value: "ChIJsynthetic123" },
        maxReviews: 2,
        maxChargeUsd: 0.25,
        since: null
      });
      const place = (await c.query("SELECT place_input,place_kind,confirmed_by FROM apify_review_places WHERE business_id=$1", [a])).rows[0];
      assert.deepEqual(place, { place_input: "ChIJsynthetic123", place_kind: "place_id", confirmed_by: "apify-a" });
      const runRow = (await c.query("SELECT run_id,status FROM apify_review_runs WHERE business_id=$1", [a])).rows[0];
      assert.deepEqual(runRow, { run_id: "run-a-1", status: "SUCCEEDED" });

      assert.deepEqual(
        [firstStatus.run?.imported, firstStatus.run?.duplicates, firstStatus.run?.rejected, firstStatus.run?.skipped],
        [1, 1, 2, 1]
      );
      assert.equal(firstStatus.run?.importedAt !== null, true);
      assert.equal(JSON.stringify(firstStatus).includes(REVIEW_TEXT), false, "review text never appears in a response");
      assert.equal(JSON.stringify(startResponse).includes(REVIEW_TEXT), false);
      assert.equal(logs.join("\n").includes(REVIEW_TEXT), false, "review text is never logged");
      assert.equal(logs.join("\n").includes(token), false, "the token is never logged");

      const stored = (await c.query(
        "SELECT source,source_review_id,rating,author_name,text,reviewed_at::text,source_url FROM reviews WHERE business_id=$1",
        [a]
      )).rows;
      assert.equal(stored.length, 1);
      assert.equal(stored[0].source, "apify_google");
      assert.equal(stored[0].source_review_id, "apify-review-1");
      assert.equal(stored[0].rating, 5);
      assert.equal(stored[0].author_name, "Jane D.", "only a short name is kept");
      assert.equal(stored[0].source_url, null, "the review URL is discarded");
      const storedJson = JSON.stringify(stored);
      for (const discarded of ["MUST_NOT_STORE_ID", "example.invalid/profile", "example.invalid/photo", "example.invalid/review"]) {
        assert.equal(storedJson.includes(discarded), false, discarded);
      }

      // A second poll must not import again, even when two polls race.
      await c.query("UPDATE apify_review_runs SET imported_at=NULL, imported=0, duplicates=0, rejected=0, skipped=0 WHERE business_id=$1", [a]);
      await Promise.all([getApifyReviewsStatus("apify-a", a, deps), getApifyReviewsStatus("apify-a", a, deps)]);
      assert.equal((await c.query("SELECT count(*) FROM reviews WHERE business_id=$1", [a])).rows[0].count, "1");
      const raced = (await c.query("SELECT imported,duplicates,imported_at IS NOT NULL claimed FROM apify_review_runs WHERE business_id=$1", [a])).rows[0];
      // Two polls of the same dataset produce two duplicates, not four: only one claimed the import.
      assert.deepEqual(raced, { imported: 0, duplicates: 2, claimed: true });

      // A fresh in-progress run refuses another start until it finishes.
      const busy = new FakeApifyReviewsClient({
        starts: [{ runId: "run-busy", status: "RUNNING", datasetId: "dataset-busy" }],
        runs: { "run-busy": { runId: "run-busy", status: "RUNNING", datasetId: "dataset-busy" } }
      });
      await startApifyReviews("apify-b", b, { place: "ChIJsynthetic123", confirmed: true }, { client: busy, env, now: () => now });
      await assert.rejects(
        () => startApifyReviews("apify-b", b, { place: "ChIJsynthetic123", confirmed: true }, { client: busy, env, now: () => now }),
        (error: unknown) => error instanceof ApifyReviewError && error.code === "run_in_progress" && error.status === 409
      );

      // Provider failure is stored, does not import, and allows a retry.
      const failing = new FakeApifyReviewsClient({
        starts: [
          { runId: "run-fail-1", status: "RUNNING", datasetId: "dataset-fail-1" },
          { runId: "run-fail-2", status: "RUNNING", datasetId: "dataset-fail-2" },
          { runId: "run-fail-3", status: "RUNNING", datasetId: "dataset-fail-3" }
        ],
        runs: { "run-fail-1": { runId: "run-fail-1", status: "FAILED", datasetId: "dataset-fail-1" } }
      });
      await startApifyReviews("apify-a", fail, { place: "https://maps.app.goo.gl/synthetic", confirmed: true }, { client: failing, env, now: () => now });
      const failedStatus = await getApifyReviewsStatus("apify-a", fail, { client: failing, env, now: () => now });
      assert.equal(failedStatus.run?.status, "FAILED");
      assert.equal(failedStatus.run?.errorCode, "provider_failed");
      assert.equal(failedStatus.canStart, true);
      await startApifyReviews("apify-a", fail, { place: "https://maps.app.goo.gl/synthetic", confirmed: true }, { client: failing, env, now: () => now });
      assert.equal(failing.startRequests.length, 2);

      // A run started long ago without a finish is marked failed, then a new run is allowed.
      await c.query("UPDATE apify_review_runs SET started_at=now()-interval '3 hours' WHERE run_id='run-fail-2'");
      const timedOut = await getApifyReviewsStatus("apify-a", fail, { client: failing, env, now: () => new Date() });
      assert.equal(timedOut.run?.status, "FAILED");
      assert.equal(timedOut.run?.errorCode, "timeout");
      assert.equal(timedOut.canStart, true);
      await startApifyReviews("apify-a", fail, { place: "https://maps.app.goo.gl/synthetic", confirmed: true }, { client: failing, env, now: () => new Date() });
      assert.equal(failing.startRequests.length, 3);

      // Plan limits come from the raw plan name; pro is not the free cap.
      const proFake = new FakeApifyReviewsClient({ starts: [{ runId: "run-pro", status: "READY", datasetId: "dataset-pro" }] });
      await startApifyReviews("apify-pro", pro, { place: "ChIJsynthetic123", confirmed: true }, { client: proFake, env, now: () => now });
      assert.equal(proFake.startRequests[0].maxReviews, 3);
      await c.query("UPDATE apify_review_runs SET status='SUCCEEDED', imported_at=now(), started_at=$2 WHERE business_id=$1", [pro, now]);

      // Daily limit: one successful start uses the day's allowance; a later run after the
      // interval is refused before the provider is called.
      process.env.OWNER_GENERATION_DAILY_LIMIT = "1";
      const dailyEnv = { ...env, APIFY_REVIEW_RUN_INTERVAL_HOURS: "1" };
      const dailyFake = new FakeApifyReviewsClient({
        starts: [
          { runId: "run-daily-1", status: "READY", datasetId: "dataset-daily-1" },
          { runId: "run-daily-2", status: "READY", datasetId: "dataset-daily-2" }
        ]
      });
      await startApifyReviews("apify-daily", daily, { place: "ChIJsynthetic123", confirmed: true }, { client: dailyFake, env: dailyEnv, now: () => now });
      await c.query("UPDATE apify_review_runs SET status='SUCCEEDED', imported_at=now(), started_at=now()-interval '2 hours' WHERE business_id=$1", [daily]);
      await assert.rejects(
        () => startApifyReviews("apify-daily", daily, { place: "ChIJsynthetic123", confirmed: true }, { client: dailyFake, env: dailyEnv, now: () => new Date() }),
        (error: unknown) => error instanceof ApifyReviewError && error.code === "daily_limit" && error.status === 429
      );
      assert.equal(dailyFake.startRequests.length, 1, "the provider is not called after the daily limit");

      // A run interval still applies to successful runs on the next day.
      process.env.OWNER_GENERATION_DAILY_LIMIT = "25";
      await assert.rejects(
        () => startApifyReviews("apify-pro", pro, { place: "ChIJsynthetic123", confirmed: true }, { client: proFake, env, now: () => new Date("2026-11-04T13:00:00.000Z") }),
        (error: unknown) => error instanceof ApifyReviewError && error.code === "run_interval" && error.status === 429
      );

      // A lapsed paid plan gets the Free cap, like every other limit.
      await c.query("UPDATE owner_plans SET expires_at=now()-interval '1 day' WHERE owner_id='apify-pro'");
      const lapsed = await getApifyReviewsStatus("apify-pro", pro, { client: proFake, env, now: () => now });
      assert.equal(lapsed.limits.maxReviews, 2, "an expired plan does not keep its review cap");
      await c.query("UPDATE owner_plans SET expires_at=NULL WHERE owner_id='apify-pro'");

      // The browser never receives Apify's run ID, or the spend cap.
      assert.equal(JSON.stringify(lapsed).includes("run-pro"), false, "Apify's run ID stays on the server");
      assert.equal(JSON.stringify(lapsed).includes("maxChargeUsd"), false);

      // Two quick clicks start one paid run, not two.
      const raceBusiness = Number((await c.query("INSERT INTO businesses(name,timezone,owner_id) VALUES('Synthetic race','UTC','apify-a') RETURNING id")).rows[0].id);
      const raceFake = new FakeApifyReviewsClient();
      const raceDeps = { client: raceFake, env, now: () => now };
      const clicks = await Promise.allSettled([
        startApifyReviews("apify-a", raceBusiness, { place: "ChIJsynthetic123", confirmed: true }, raceDeps),
        startApifyReviews("apify-a", raceBusiness, { place: "ChIJsynthetic123", confirmed: true }, raceDeps)
      ]);
      assert.equal(raceFake.startRequests.length, 1, "only one click reaches the provider");
      assert.equal(clicks.filter(click => click.status === "fulfilled").length, 1);
      assert.equal((await c.query("SELECT count(*) FROM apify_review_runs WHERE business_id=$1", [raceBusiness])).rows[0].count, "1");

      // A provider failure spends nothing, so it leaves no daily count and no stored place.
      const refusedBusiness = Number((await c.query("INSERT INTO businesses(name,timezone,owner_id) VALUES('Synthetic refused','UTC','apify-b') RETURNING id")).rows[0].id);
      const usedBefore = (await c.query("SELECT coalesce(sum(calls),0)::int n FROM owner_usage WHERE owner_id='apify-b' AND kind='apify_reviews'")).rows[0].n;
      await assert.rejects(
        () => startApifyReviews("apify-b", refusedBusiness, { place: "ChIJsynthetic123", confirmed: true }, {
          client: new FakeApifyReviewsClient({ starts: [new ApifyError("auth", 401)] }), env, now: () => now
        }),
        (error: unknown) => error instanceof ApifyReviewError && error.code === "provider_auth"
      );
      assert.equal((await c.query("SELECT coalesce(sum(calls),0)::int n FROM owner_usage WHERE owner_id='apify-b' AND kind='apify_reviews'")).rows[0].n, usedBefore);
      assert.equal((await c.query("SELECT count(*) FROM apify_review_places WHERE business_id=$1", [refusedBusiness])).rows[0].count, "0");

      // A changed place has no date limit; the same place only asks for what's new.
      const moveFake = new FakeApifyReviewsClient({ starts: ["move-1", "move-2", "move-3"].map(runId => ({ runId, status: "READY", datasetId: `${runId}-dataset` })) });
      const moveBusiness = Number((await c.query("INSERT INTO businesses(name,timezone,owner_id) VALUES('Synthetic move','UTC','apify-b') RETURNING id")).rows[0].id);
      await startApifyReviews("apify-b", moveBusiness, { place: "ChIJsyntheticOne", confirmed: true }, { client: moveFake, env, now: () => now });
      await c.query("UPDATE apify_review_runs SET status='SUCCEEDED', imported_at=now(), started_at=now()-interval '3 days' WHERE business_id=$1", [moveBusiness]);
      await startApifyReviews("apify-b", moveBusiness, { place: "ChIJsyntheticTwo", confirmed: true }, { client: moveFake, env, now: () => new Date() });
      assert.equal(moveFake.startRequests[1].since, null, "a different place starts with no date limit");
      await c.query("UPDATE apify_review_runs SET status='SUCCEEDED', imported_at=now(), started_at=now()-interval '3 days' WHERE business_id=$1", [moveBusiness]);
      await startApifyReviews("apify-b", moveBusiness, { place: "ChIJsyntheticTwo", confirmed: true }, { client: moveFake, env, now: () => new Date() });
      assert.notEqual(moveFake.startRequests[2].since, null, "the same place only asks for new reviews");

      // A row the database refuses is counted, and the rest of the run still imports.
      const badRowBusiness = Number((await c.query("INSERT INTO businesses(name,timezone,owner_id) VALUES('Synthetic bad row','UTC','apify-b') RETURNING id")).rows[0].id);
      const badRows = await importApifyItems(badRowBusiness, [{ reviews: [
        { reviewId: "bad-row", stars: 5, text: "A synthetic review holding a NUL \u0000 byte", publishedAtDate: "2026-10-01T00:00:00.000Z", name: "Jane Doe" },
        { reviewId: "good-row", stars: 5, text: "A synthetic review that stores cleanly", publishedAtDate: "2026-10-02T00:00:00.000Z", name: "Sam Roe" }
      ] }]);
      assert.deepEqual([badRows.imported, badRows.failedRows], [1, 1]);
      assert.equal((await c.query("SELECT count(*) FROM reviews WHERE business_id=$1", [badRowBusiness])).rows[0].count, "1");

      // The other owner's business has its own run but no imported reviews.
      assert.equal((await c.query("SELECT count(*) FROM reviews WHERE business_id=$1", [b])).rows[0].count, "0");
    });
  } finally {
    if (savedDailyLimit === undefined) delete process.env.OWNER_GENERATION_DAILY_LIMIT;
    else process.env.OWNER_GENERATION_DAILY_LIMIT = savedDailyLimit;
  }

  // Keep the type visible: the fake implements the same interface as the live client.
  const contract: ApifyReviewsClient = new FakeApifyReviewsClient();
  assert.equal(typeof contract.startRun, "function");

  console.log("Apify review provider, limits, import, timeout and token tests passed (fake adapter, no live calls)");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
