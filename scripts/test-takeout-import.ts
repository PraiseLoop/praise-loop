import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { databaseFixture } from "./db-fixture";
import { mapTakeoutRating, parseTakeoutReviews } from "../lib/takeout";
import { MAX_REVIEW_IMPORT_BYTES } from "../lib/services/reviewImport";

// The route reads the owner from ownerRoute; replace it with fixed synthetic context.
const boundary = require("../lib/authorization");
boundary.ownerRoute = (handler: unknown) => handler;
boundary.currentOwner = () => "synthetic-owner";
const { POST } = require("../app/api/reviews/import-takeout/route");

const FIXTURE_TEXT = readFileSync("sample-data/takeout/reviews.json", "utf8");

function upload(json: string, businessId: number) {
  const form = new FormData();
  form.set("businessId", String(businessId));
  form.set("file", new File([json], "reviews.json", { type: "application/json" }));
  return POST(new NextRequest("http://localhost/api/reviews/import-takeout", { method: "POST", body: form }));
}

async function main() {
  // Rating mapping: documented enum, numeric strings, numbers, and values left for validation.
  assert.deepEqual(
    ["ONE", "two", "THREE", "four", "FIVE", "5", 5, 4.5, "SIX", "", null].map(mapTakeoutRating),
    ["1", "2", "3", "4", "5", "5", "5", "4.5", "SIX", "", ""]
  );

  // The assumed Takeout shape: reviewer.displayName, enum starRating, comment,
  // createTime, reviewId or the review resource name, plus unknown fields.
  const parsed = parseTakeoutReviews(FIXTURE_TEXT);
  assert.equal(parsed.length, 4);
  assert.deepEqual(parsed.map(review => review.rating), ["5", "4", "5", "3"]);
  assert.deepEqual(parsed.map(review => review.authorName), [
    "Avery Example",
    "Blake Example",
    "Casey Example",
    "Drew Example"
  ]);
  assert.equal(parsed[0].sourceReviewId, "takeout-review-001");
  assert.equal(parsed[2].sourceReviewId, "accounts/1000000001/locations/2000000001/reviews/takeout-review-003");
  assert.match(parsed[3].sourceReviewId ?? "", /^takeout:[a-f0-9]{64}$/, "a review with no id gets a deterministic reviewer/date/text hash");
  assert.equal(parseTakeoutReviews(FIXTURE_TEXT)[3].sourceReviewId, parsed[3].sourceReviewId, "the no-id hash is stable across parses");
  assert.equal(parsed[0].reviewedAt, "2026-10-01T12:00:00.000Z");
  assert.equal(parsed[0].sourceUrl, null);

  // A top-level array is accepted too, along with alternate field names from an
  // unverified export, and only http(s) review URLs survive.
  const array = parseTakeoutReviews(JSON.stringify([{
    reviewId: "array-1",
    reviewer: { displayName: "Array Example" },
    starRating: "FOUR",
    comment: "A synthetic review in a top-level array.",
    createTime: "2026-10-05T10:00:00Z",
    reviewUrl: "https://example.invalid/review/array-1"
  }]));
  assert.deepEqual(
    [array[0].rating, array[0].authorName, array[0].sourceReviewId, array[0].sourceUrl],
    ["4", "Array Example", "array-1", "https://example.invalid/review/array-1"]
  );
  const alternate = parseTakeoutReviews(JSON.stringify({
    reviewData: [{
      review_id: "alternate-1",
      author_name: "Alternate Example",
      star_rating: "FIVE",
      review_text: "A synthetic review using forgiving alternate field names.",
      reviewed_at: "2026-10-06",
      url: "mailto:not-a-review-url@example.invalid"
    }]
  }));
  assert.deepEqual(
    [alternate[0].rating, alternate[0].authorName, alternate[0].sourceReviewId, alternate[0].sourceUrl],
    ["5", "Alternate Example", "alternate-1", null]
  );

  assert.throws(() => parseTakeoutReviews("{not json"), /Invalid JSON/);
  assert.throws(() => parseTakeoutReviews(JSON.stringify({ data: [] })), /reviews array/);
  assert.throws(
    () => parseTakeoutReviews(JSON.stringify({ reviews: Array.from({ length: 1001 }, () => ({})) })),
    /1000/
  );

  await databaseFixture(async client => {
    const business = (await client.query(
      "INSERT INTO businesses(name,timezone) VALUES('Synthetic Takeout','UTC') RETURNING id"
    )).rows[0].id as number;

    const first = await (await upload(FIXTURE_TEXT, business)).json();
    assert.deepEqual(
      [first.imported, first.duplicates, first.rejectedInvalid, first.skippedEmpty, first.failedRows],
      [4, 0, 0, 0, 0]
    );

    const stored = (await client.query(
      `SELECT source, source_review_id, rating, author_name, text, reviewed_at, source_url
       FROM reviews WHERE business_id=$1 ORDER BY id`,
      [business]
    )).rows;
    assert.equal(stored.length, 4);
    assert.ok(stored.every(review => review.source === "google_takeout"));
    assert.deepEqual(stored.map(review => review.rating), [5, 4, 5, 3]);
    assert.equal(stored[0].author_name, "Avery Example");
    assert.equal(new Date(stored[0].reviewed_at).toISOString(), "2026-10-01T12:00:00.000Z");
    assert.equal(stored[0].source_url, null);
    const storedJson = JSON.stringify(stored);
    for (const discarded of [
      "avery@example.invalid",
      "example.invalid/profile",
      "Thank you from the invented owner",
      "unknownExtraField"
    ]) assert.equal(storedJson.includes(discarded), false, discarded);

    // Re-importing the same file is safe: explicit IDs and the no-ID fingerprint both dedupe.
    const repeated = await (await upload(FIXTURE_TEXT, business)).json();
    assert.deepEqual([repeated.imported, repeated.duplicates], [0, 4]);

    // A stable source ID wins over changed text, matching the CSV import rules.
    const changed = await (await upload(JSON.stringify({
      reviews: [{
        reviewId: "takeout-review-001",
        reviewer: { displayName: "Avery Example" },
        starRating: "FIVE",
        comment: "Changed synthetic text for the same stable review id.",
        createTime: "2026-10-01T12:00:00Z"
      }]
    }), business)).json();
    assert.deepEqual([changed.imported, changed.duplicates], [0, 1]);

    // A missing ID uses rating + reviewer + text + date, so the same review is still a duplicate.
    const fingerprint = JSON.stringify({
      reviews: [{
        reviewer: { displayName: "Fingerprint Example" },
        starRating: "FOUR",
        comment: "A synthetic review with no id that must dedupe by fingerprint.",
        createTime: "2026-10-07T10:00:00Z"
      }]
    });
    const fingerprintFirst = await (await upload(fingerprint, business)).json();
    const fingerprintAgain = await (await upload(fingerprint, business)).json();
    assert.deepEqual([fingerprintFirst.imported, fingerprintAgain.duplicates], [1, 1]);
    // The derived ID covers reviewer + date + text, so an edited rating is still the same review.
    const ratingChanged = await (await upload(JSON.stringify({
      reviews: [{
        reviewer: { displayName: "Fingerprint Example" },
        starRating: "FIVE",
        comment: "A synthetic review with no id that must dedupe by fingerprint.",
        createTime: "2026-10-07T10:00:00Z"
      }]
    }), business)).json();
    assert.deepEqual([ratingChanged.imported, ratingChanged.duplicates], [0, 1]);

    // Invalid rows are counted and reported with their array position; an all-empty row is skipped.
    const mixed = await (await upload(JSON.stringify({
      reviews: [
        {
          reviewId: "valid-mixed",
          reviewer: { displayName: "Valid Example" },
          starRating: "FIVE",
          comment: "A valid synthetic review that should be imported.",
          createTime: "2026-10-08T10:00:00Z"
        },
        {
          reviewId: "bad-rating",
          reviewer: { displayName: "Bad Rating" },
          starRating: "SIX",
          comment: "A synthetic review with an invalid rating.",
          createTime: "2026-10-08T11:00:00Z"
        },
        {
          reviewId: "bad-date",
          reviewer: { displayName: "Bad Date" },
          starRating: "FOUR",
          comment: "A synthetic review with an invalid date.",
          createTime: "2026-02-30T10:00:00Z"
        },
        {
          reviewId: "no-text",
          reviewer: { displayName: "No Text" },
          starRating: "FOUR",
          comment: "   ",
          createTime: "2026-10-08T12:00:00Z"
        },
        {}
      ]
    }), business)).json();
    assert.deepEqual(
      [mixed.imported, mixed.duplicates, mixed.rejectedInvalid, mixed.skippedEmpty, mixed.failedRows],
      [1, 0, 3, 1, 0]
    );
    assert.deepEqual(mixed.errors.map((error: { row: number }) => error.row), [2, 3, 4]);

    // A top-level array reaches the database through the same route.
    const arrayBusiness = (await client.query(
      "INSERT INTO businesses(name,timezone) VALUES('Synthetic Takeout Array','UTC') RETURNING id"
    )).rows[0].id as number;
    const arrayImport = await (await upload(JSON.stringify([{
      reviewId: "array-stored",
      reviewer: { displayName: "Array Stored" },
      starRating: "ONE",
      comment: "A synthetic review imported from a top-level JSON array.",
      createTime: "2026-10-09T10:00:00Z"
    }]), arrayBusiness)).json();
    assert.equal(arrayImport.imported, 1);
    assert.equal(
      (await client.query("SELECT rating, source FROM reviews WHERE business_id=$1", [arrayBusiness])).rows[0].rating,
      1
    );

    // Malformed JSON and an unexpected shape are refused before any row is written.
    const malformed = await upload("{not json", arrayBusiness);
    assert.equal(malformed.status, 400);
    assert.match((await malformed.json()).error, /Invalid JSON/);
    const wrongShape = await upload(JSON.stringify({ data: [] }), arrayBusiness);
    assert.equal(wrongShape.status, 400);
    assert.match((await wrongShape.json()).error, /reviews array/);

    // The same 1 MB limit as the CSV import is enforced before parsing.
    assert.equal((await upload("x".repeat(MAX_REVIEW_IMPORT_BYTES + 1), arrayBusiness)).status, 413);
    assert.equal((await upload(FIXTURE_TEXT, 999999)).status, 404);

    const missing = new FormData();
    missing.set("businessId", String(arrayBusiness));
    const noFile = POST(new NextRequest("http://localhost/api/reviews/import-takeout", { method: "POST", body: missing }));
    assert.equal((await noFile).status, 400);
  });

  console.log("Google Takeout review parser/import/duplicate/invalid-row/limit tests passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
