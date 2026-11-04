import type { Entitlements, WeeklyUsage } from "../api/entitlements";

// Wording mirrors lib/planDisplay.ts on the web so the two apps never disagree.
// An unknown plan keeps the server's own name instead of being called Free.
const planNames: Record<string, string> = { free: "Free", pro: "Pro" };
const planName = (plan: string) => planNames[plan] ?? `${plan.charAt(0).toUpperCase()}${plan.slice(1)}`;
const posts = (count: number) => `${count} post${count === 1 ? "" : "s"}`;
// Review sync (#46) and AI replies (#96) have no feature behind them yet, so a
// plan that allows them still reads as planned, never as available.
const featureState = (value: boolean) => value ? "planned, not available yet" : "not included";

export function usageFor(plan: Entitlements | null, businessId: number | null): WeeklyUsage | null {
  return plan?.usage.find(item => item.businessId === businessId) ?? null;
}

export function expiryNote(plan: Entitlements): string | null {
  if (!plan.expiresAt) return null;
  const date = plan.expiresAt.slice(0, 10);
  if (plan.expired) return `Your Pro plan expired on ${date}, so you are on the Free plan.`;
  if (plan.plan === "free") return null;
  return `Your ${planName(plan.plan)} plan runs until ${date}.`;
}

// Names the plan limit once this week's quota is used up; null while there is room.
export function quotaMetMessage(plan: Entitlements, usage: WeeklyUsage): string | null {
  if (!usage.quotaMet) return null;
  const cap = plan.limits.postsPerWeek;
  return usage.weeklyTarget > cap
    ? `You’ve reached this week’s limit: the ${planName(plan.plan)} plan includes ${posts(cap)} a week for each business.`
    : `You’ve made all ${posts(usage.target)} you asked for this week. The ${planName(plan.plan)} plan allows up to ${cap} a week.`;
}

export function planLines(plan: Entitlements, usage: WeeklyUsage | null): string[] {
  const { limits } = plan;
  const lines = [
    `${planName(plan.plan)} plan`,
    `${posts(limits.postsPerWeek)} a week per business, ${limits.businesses} ${limits.businesses === 1 ? "business" : "businesses"}`,
    `Watermark: ${limits.watermark ? "yes" : "no"}. Review sync: ${featureState(limits.reviewSync)}. AI replies: ${featureState(limits.aiReplies)}`
  ];
  const note = expiryNote(plan);
  if (note) lines.push(note);
  if (usage) lines.push(`${usage.allocated} of ${usage.target} ${usage.target === 1 ? "post" : "posts"} this week, resets ${usage.resetsOn} (${usage.timezone})`);
  return lines;
}

// This week's usage for every owned business, for the profile screen where there
// is no selected queue to scope it to. Each line names its business.
export function planUsageLines(plan: Entitlements | null): string[] {
  return (plan?.usage ?? []).map(usage =>
    `${usage.name}: ${usage.allocated} of ${usage.target} ${usage.target === 1 ? "post" : "posts"} this week, resets ${usage.resetsOn} (${usage.timezone})`
  );
}
