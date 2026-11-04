import type { EntitlementLimits, Plan } from "./services/entitlements";

// Copy and formatting for the public plans page (#134). The values are read
// from PLAN_LIMITS by the caller, so the page and the server cannot disagree;
// this module only words them. Type-only imports keep the database layer out
// of bundles that render the comparison.

export const PLAN_ORDER: Plan[] = ["free", "pro", "business"];

export const publicPlanName: Record<Plan, string> = { free: "Free", pro: "Pro", business: "Business" };

export type PlanComparisonRow = {
  /** The limit this row explains; a test checks every shipped or planned limit has a row. */
  key: keyof EntitlementLimits;
  label: string;
  /** Shown once under the comparison when the limit alone would overpromise. */
  note?: string;
  value: (limits: EntitlementLimits) => string;
};

const count = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;

const notAvailable = "Planned — not available yet";

// Limits with a feature that exists and is enforced on the server. A row may
// only show a plan's value for one of these; scripts/test-plans.ts fails when a
// limit without a feature behind it is advertised as available.
export const SHIPPED_LIMITS = ["postsPerWeek", "watermark", "automaticPosting", "brandVoice", "businesses"] as const;
// Limits with no feature behind them yet: they read as planned, never included.
export const PLANNED_LIMITS = ["reviewSync", "aiReplies"] as const;
// Kept off the comparison until the feature ships. Extra template designs do
// not exist (and the allowance is not enforced), so #218 leaves templates out.
export const UNLISTED_LIMITS = ["templates"] as const;

export const PLAN_ROWS: PlanComparisonRow[] = [
  { key: "postsPerWeek", label: "Posts each week, per business", value: l => count(l.postsPerWeek, "post", "posts") },
  { key: "watermark", label: "Watermark on images", value: l => l.watermark ? "Small PraiseLoop watermark" : "No watermark" },
  {
    key: "automaticPosting",
    label: "Automatic posting",
    note: "Automatic posting sends an approved post to your connected Buffer account at the time you choose. You still approve every post, and nothing posts without that.",
    value: l => l.automaticPosting ? "Through Buffer, with your approval" : "Not included"
  },
  {
    key: "reviewSync",
    label: "Automatic review sync",
    note: "Automatic review sync (Google reviews) is planned for Pro and Business but is not available yet, so every plan starts with a spreadsheet import.",
    value: l => l.reviewSync ? notAvailable : "Not included"
  },
  {
    key: "aiReplies",
    label: "AI review replies",
    note: "AI review replies are planned for Pro and Business but are not available yet.",
    value: l => l.aiReplies ? notAvailable : "Not included"
  },
  {
    key: "brandVoice",
    label: "Brand voice",
    note: "Brand voice learns a short, editable profile from your own public website; nothing is scraped from social accounts.",
    value: l => l.brandVoice ? "Learn from your website" : "Not included"
  },
  { key: "businesses", label: "Businesses", value: l => count(l.businesses, "business", "businesses") }
];

export type ComparedRow = { key: keyof EntitlementLimits; label: string; note?: string; values: Record<Plan, string> };

/** The comparison for each plan, worded from the limits the server enforces. */
export function planComparison(limits: Record<Plan, EntitlementLimits>): ComparedRow[] {
  return PLAN_ROWS.map(row => ({
    key: row.key,
    label: row.label,
    note: row.note,
    values: Object.fromEntries(PLAN_ORDER.map(plan => [plan, row.value(limits[plan])])) as Record<Plan, string>
  }));
}

/** Each note once, in row order, for the "Good to know" list under the plans. */
export function planNotes(rows: ComparedRow[]): string[] {
  return [...new Set(rows.flatMap(row => row.note ? [row.note] : []))];
}

// Prices are deliberately absent until the owner records the Free/Pro/Business
// prices in docs/decisions.md (issue #134). Fill PLAN_PRICING in the same change as that
// decision; scripts/test-plans.ts fails when the decision and the page disagree.
export const PLAN_PRICING: Record<Plan, string> | null = null;
