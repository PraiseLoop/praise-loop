import type { Entitlements } from "./services/entitlements";

// Pure display helpers shared by the web app and tests. Type-only imports keep
// the database layer out of client bundles.

export type WeeklyUsage = {
  businessId: number;
  name: string;
  timezone: string;
  /** Monday (YYYY-MM-DD, business-local) that starts the current generation period. */
  weekStart: string;
  /** Next Monday as a business-local date, for display such as "resets Monday, Nov 2". */
  resetsOn: string;
  /** The instant that local midnight happens in the business's timezone. */
  resetsAt: string;
  /** Drafts allocated to this week's quota. */
  allocated: number;
  /** Effective weekly cap: the owner's configured target limited by the plan. */
  target: number;
  /** What the owner asked for, before the plan cap. */
  weeklyTarget: number;
  quotaMet: boolean;
  /** Over the plan's business limit after a downgrade: visible, but no new generation. */
  paused: boolean;
};

export type EntitlementsWithUsage = Entitlements & { usage: WeeklyUsage[] };

const planNames: Record<string, string> = { free: "Free", pro: "Pro", business: "Business" };
export const planName = (plan: string) => planNames[plan] ?? plan;

/** A stored paid plan whose expiry has passed reads as Free; this explains why. */
export function expiryNote(e: Pick<Entitlements, "plan" | "expiresAt" | "expired" | "expiredPlan">): string | null {
  if (!e.expiresAt) return null;
  const date = e.expiresAt.slice(0, 10);
  if (e.expired) return `Your ${planName(e.expiredPlan ?? e.plan)} plan expired on ${date}, so you are on the Free plan.`;
  if (e.plan === "free") return null;
  return `Your ${planName(e.plan)} plan runs until ${date}.`;
}

const posts = (count: number) => `${count} post${count === 1 ? "" : "s"}`;
const businesses = (count: number) => `${count} business${count === 1 ? "" : "es"}`;

/** Explains a business that is over the plan's limit after a downgrade. The phone has its own wording, with no upgrade prompt. */
export function pausedBusinessMessage(e: Pick<Entitlements, "plan" | "limits">): string {
  return `This business is paused because the ${planName(e.plan)} plan includes ${businesses(e.limits.businesses)}. Upgrade to resume new posts; your existing posts are still available.`;
}

/** Names the plan limit when the week's quota is used up; null while there is room. */
export function quotaMetMessage(e: Pick<Entitlements, "plan" | "limits">, usage: Pick<WeeklyUsage, "target" | "weeklyTarget" | "quotaMet">): string | null {
  if (!usage.quotaMet) return null;
  const plan = planName(e.plan);
  const cap = e.limits.postsPerWeek;
  return usage.weeklyTarget > cap
    ? `You’ve reached this week’s limit: the ${plan} plan includes ${posts(cap)} a week for each business.`
    : `You’ve made all ${posts(usage.target)} you asked for this week. The ${plan} plan allows up to ${cap} a week.`;
}

/** The full This Week notice for a used-up quota: the limit, when posts resume, and any expiry note. */
export function weekLimitNotice(e: Pick<Entitlements, "plan" | "limits" | "expiresAt" | "expired" | "expiredPlan">, usage: WeeklyUsage | undefined): string | null {
  const message = usage ? quotaMetMessage(e, usage) : null;
  if (!usage || !message) return null;
  const expiry = expiryNote(e);
  return `${message} New posts start ${formatLocalDate(usage.resetsOn)}.${expiry ? ` ${expiry}` : ""}`;
}

/** "Monday, Nov 2" for a business-local YYYY-MM-DD date, independent of the viewer's timezone. */
export function formatLocalDate(day: string) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
}
