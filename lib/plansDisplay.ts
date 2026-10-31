import type { EntitlementLimits, Plan } from "./services/entitlements";

// Copy and formatting for the public plans page (#134). The values are read
// from PLAN_LIMITS by the caller, so the page and the server cannot disagree;
// this module only words them. Type-only imports keep the database layer out
// of bundles that render the comparison.

export const PLAN_ORDER: Plan[] = ["free", "pro"];

export const publicPlanName: Record<Plan, string> = { free: "Free", pro: "Pro" };

export type PlanComparisonRow = {
  /** The limit this row explains; a test checks every plan limit has a row. */
  key: keyof EntitlementLimits;
  label: string;
  /** Shown once under the comparison when the limit alone would overpromise. */
  note?: string;
  value: (limits: EntitlementLimits) => string;
};

const count = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;

const notAvailable = "Planned — not available yet";

export const PLAN_ROWS: PlanComparisonRow[] = [
  { key: "postsPerWeek", label: "Posts each week, per business", value: l => count(l.postsPerWeek, "post", "posts") },
  {
    key: "templates",
    label: "Templates",
    note: "Only one template design exists today. The Pro allowance covers designs added later.",
    value: l => l.templates === 1 ? "1 template" : `Up to ${l.templates} templates`
  },
  { key: "watermark", label: "Watermark on images", value: l => l.watermark ? "Small PraiseLoop watermark" : "No watermark" },
  {
    key: "reviewSync",
    label: "Automatic review sync",
    note: "Automatic review sync (Google reviews) is planned for Pro but is not available yet, so both plans start with a spreadsheet import.",
    value: l => l.reviewSync ? notAvailable : "Not included"
  },
  {
    key: "aiReplies",
    label: "AI review replies",
    note: "AI review replies are planned for Pro but are not available yet.",
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

// Prices are deliberately absent until the owner records the Free/Pro prices in
// docs/decisions.md (issue #134). Fill PLAN_PRICING in the same change as that
// decision; scripts/test-plans.ts fails when the decision and the page disagree.
export const PLAN_PRICING: Record<Plan, string> | null = null;
