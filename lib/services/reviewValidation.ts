// The row rules shared by CSV import and the Apify stopgap (#232), so both paths
// accept exactly the same shape. Kept separate from storage so a caller can count
// empty, invalid and valid rows without writing anything.

export type ReviewCandidate = {
  rating: string;
  text: string;
  reviewedAt: string;
  authorName: string | null;
  sourceReviewId: string | null;
  sourceUrl: string | null;
};

export type ValidReviewRow = {
  rating: number;
  text: string;
  reviewedAt: Date;
  authorName: string | null;
  sourceReviewId: string | null;
  sourceUrl: string | null;
};

export type ReviewRowResult =
  | { status: "empty" }
  | { status: "invalid" }
  | { status: "valid"; review: ValidReviewRow };

export function validateReviewRow(row: ReviewCandidate): ReviewRowResult {
  const ratingText = row.rating.trim();
  const text = row.text;
  const reviewedAt = row.reviewedAt.trim();
  const authorName = row.authorName?.trim() || null;

  if (!ratingText && !text.trim() && !reviewedAt && !authorName && !row.sourceReviewId && !row.sourceUrl) {
    return { status: "empty" };
  }

  if (!ratingText || !text.trim()) return { status: "invalid" };

  const rating = Number(ratingText);
  const date = new Date(reviewedAt);
  const dateValid = /^\d{4}-\d{2}-\d{2}(?:T.*Z)?$/.test(reviewedAt) &&
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === reviewedAt.slice(0, 10);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5 || !dateValid ||
      text.length > 10000 || (row.sourceReviewId?.length ?? 0) > 256 ||
      row.sourceUrl && (!/^https?:\/\//i.test(row.sourceUrl) || row.sourceUrl.length > 2000)) {
    return { status: "invalid" };
  }

  return {
    status: "valid",
    review: {
      rating,
      text,
      reviewedAt: date,
      authorName,
      sourceReviewId: row.sourceReviewId || null,
      sourceUrl: row.sourceUrl || null
    }
  };
}
