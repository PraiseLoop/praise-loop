import { createHash } from "node:crypto";
import type { ReviewCandidate } from "./services/reviewValidation";

// Google Takeout Business Profile review parser (#233). The real export format is
// unverified: nobody has run one in this repo. These field names come from Google's
// documented Review resource and third-party descriptions of the Takeout file, so
// every lookup below is deliberately tolerant and ignores unknown fields. Verify
// against a real export before announcing the feature.
export const MAX_TAKEOUT_REVIEWS = 1000;

const STAR_RATINGS: Record<string, string> = {
  ONE: "1",
  TWO: "2",
  THREE: "3",
  FOUR: "4",
  FIVE: "5"
};

/** A number, a numeric string or the documented enum (ONE..FIVE); anything else is left for validation. */
export function mapTakeoutRating(value: unknown): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return STAR_RATINGS[trimmed.toUpperCase()] ?? trimmed;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const found = nonEmptyString(value);
    if (found) return found;
  }
  return null;
}

function firstValue(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function isoDate(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    const raw = String(value).trim();
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return raw;
    // Date silently rolls impossible dates (2026-02-30 -> 2026-03-02). Check the
    // calendar parts independently of the offset and keep the original so the shared
    // validation can count and report the row as invalid.
    const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
    if (parts) {
      const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
      const check = new Date(Date.UTC(year, month - 1, day));
      if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
        return raw;
      }
    }
    return date.toISOString();
  }
  return "";
}

function reviewerName(review: Record<string, unknown>): string | null {
  const reviewer = record(review.reviewer);
  return firstString(
    reviewer?.displayName,
    reviewer?.name,
    reviewer?.reviewerName,
    review.reviewerName,
    review.reviewer_name,
    review.authorName,
    review.author_name,
    review.displayName,
    typeof review.reviewer === "string" ? review.reviewer : null,
    typeof review.author === "string" ? review.author : null
  );
}

function reviewId(review: Record<string, unknown>): string | null {
  const explicit = firstString(review.reviewId, review.review_id, review.source_review_id, review.id);
  if (explicit) return explicit.length <= 256 ? explicit : null;
  // In the Business Profile shape `name` is the review resource path
  // (accounts/.../locations/.../reviews/...). Only accept it when it looks like one,
  // so a reviewer's display name in some other shape is never mistaken for an ID.
  const name = nonEmptyString(review.name);
  if (name && (name.includes("/reviews/") || name.startsWith("accounts/") || /^https?:\/\//i.test(name))) {
    return name.length <= 256 ? name : null;
  }
  return null;
}

function sourceUrl(review: Record<string, unknown>): string | null {
  const value = firstString(review.reviewUrl, review.review_url, review.url);
  return value && /^https?:\/\//i.test(value) && value.length <= 2000 ? value : null;
}

/**
 * A stable source ID for a review with no `reviewId` or resource name. The same
 * reviewer, date and text must always hash to the same value so a re-import is a
 * duplicate; rating is deliberately excluded so an edited star rating still matches.
 */
export function takeoutFingerprintId(review: { authorName: string | null; reviewedAt: string; text: string }): string {
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  return `takeout:${createHash("sha256")
    .update(JSON.stringify([normalize(review.authorName ?? ""), review.reviewedAt, normalize(review.text)]))
    .digest("hex")}`;
}

function reviewItems(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  const object = record(body);
  if (object) {
    for (const key of ["reviews", "reviewData", "review_data"]) {
      if (Array.isArray(object[key])) return object[key];
    }
  }
  throw new Error("JSON must be an array of reviews or an object with a reviews array");
}

/**
 * Parse a Takeout reviews file into the same candidate shape the CSV importer uses.
 * A top-level array and an object with a `reviews` (or `reviewData`) array are both
 * accepted. Malformed JSON, a missing array and too many rows throw; individual rows
 * are left to the shared validation so they can be counted and reported.
 */
export function parseTakeoutReviews(jsonText: string): ReviewCandidate[] {
  let body: unknown;
  try {
    body = JSON.parse(jsonText);
  } catch {
    throw new Error("Invalid JSON");
  }

  const items = reviewItems(body);
  if (items.length > MAX_TAKEOUT_REVIEWS) throw new Error("JSON exceeds 1000 reviews");

  return items.map(item => {
    const review = record(item) ?? {};
    const rating = mapTakeoutRating(firstValue(review.starRating, review.star_rating, review.rating, review.stars));
    const text = firstText(review.comment, review.text, review.reviewText, review.review_text);
    const reviewedAt = isoDate(firstValue(review.createTime, review.updateTime, review.reviewed_at, review.reviewedAt, review.publishedAtDate, review.date));
    const authorName = reviewerName(review);
    const explicitId = reviewId(review);
    // An all-empty entry stays empty rather than becoming an invalid row just because
    // it received a fingerprint. Anything with data but no ID gets the stable hash.
    const sourceReviewId = explicitId ??
      (rating || text.trim() || reviewedAt || authorName ? takeoutFingerprintId({ authorName, reviewedAt, text }) : null);
    return {
      rating,
      text,
      reviewedAt,
      authorName,
      sourceReviewId,
      sourceUrl: sourceUrl(review)
    };
  });
}
