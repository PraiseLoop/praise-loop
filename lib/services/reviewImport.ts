import { query } from "../db";
import { parseCsv } from "../csv";
import { parseTakeoutReviews } from "../takeout";
import { validateReviewRow, type ReviewCandidate } from "./reviewValidation";

export const MAX_REVIEW_IMPORT_BYTES = 1_000_000;

export type ReviewImportSummary = {
  imported: number;
  duplicates: number;
  failedRows: number;
  skippedEmpty: number;
  rejectedInvalid: number;
  errors: { row: number; error: string }[];
};

type ReviewImportRow = { row: number; candidate: ReviewCandidate };
export type ReviewImportSource = "manual" | "google_takeout";

// Shared by the import routes and the dev seeder, so seeded reviews take exactly the
// path an owner's upload does. The caller checks the business exists and the file size.
// Throws only when the file cannot be parsed; row problems are counted in the summary.
export async function importReviewRows(
  businessId: number,
  source: ReviewImportSource,
  rows: ReviewImportRow[]
): Promise<ReviewImportSummary> {
  let imported = 0, duplicates = 0, failedRows = 0;
  const errors: { row: number; error: string }[] = [];
  let skippedEmpty = 0;
  let rejectedInvalid = 0;

  for (const { row, candidate } of rows) {
    const checked = validateReviewRow(candidate);

    if (checked.status === "empty") {
      skippedEmpty += 1;
      continue;
    }

    if (checked.status === "invalid") {
      rejectedInvalid += 1;
      if (errors.length < 20) errors.push({ row, error: "Invalid rating, text, date or source URL" });
      continue;
    }

    const { rating, text, reviewedAt, authorName, sourceReviewId, sourceUrl } = checked.review;
    try {
      const result = await query<{ inserted: boolean }>(
        `INSERT INTO reviews
        (business_id, source, source_review_id, rating, author_name, text, reviewed_at, source_url)
        VALUES ($1, $8, $6, $2, $3, $4, $5, $7)
        ON CONFLICT (business_id, source, identity_key) DO UPDATE
        SET source_url = COALESCE(reviews.source_url, EXCLUDED.source_url)
        RETURNING (xmax = 0) AS inserted`,
        [businessId, rating, authorName, text, reviewedAt.toISOString(), sourceReviewId, sourceUrl, source]
      );
      if (result.rows[0].inserted) imported += 1; else duplicates += 1;
    } catch {
      failedRows++;
      if (errors.length < 20) errors.push({ row, error: "Storage failure; retry this file safely" });
    }
  }

  return { imported, duplicates, failedRows, skippedEmpty, rejectedInvalid, errors };
}

export async function importReviewsCsv(businessId: number, csvText: string): Promise<ReviewImportSummary> {
  const rows = parseCsv(csvText).map((row, index): ReviewImportRow => ({
    row: index + 2,
    candidate: {
      rating: row.rating,
      text: row.text,
      reviewedAt: row.reviewed_at,
      authorName: row.author_name ?? null,
      sourceReviewId: row.source_review_id ?? null,
      sourceUrl: row.source_url ?? null
    }
  }));
  return importReviewRows(businessId, "manual", rows);
}

// Google Takeout reviews (#233) take the same validation and storage path as CSV
// rows. The new source keeps the export identifiable without touching `google` rows.
export async function importReviewsTakeout(businessId: number, jsonText: string): Promise<ReviewImportSummary> {
  const rows = parseTakeoutReviews(jsonText).map((candidate, index): ReviewImportRow => ({
    row: index + 1,
    candidate
  }));
  return importReviewRows(businessId, "google_takeout", rows);
}
