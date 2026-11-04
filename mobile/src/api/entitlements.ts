import type { ApiClient } from "./client";

export type WeeklyUsage = {
  businessId: number;
  name: string;
  timezone: string;
  resetsOn: string;
  allocated: number;
  target: number;
  weeklyTarget: number;
  quotaMet: boolean;
  /** Optional so older builds keep working when the server adds this field. */
  paused?: boolean;
};

// Read-only mirror of GET /api/entitlements. The server owns every limit; the
// app only displays what comes back.
export type Entitlements = {
  // Any non-empty plan name: an installed app must keep working when the server
  // adds a plan this build has never heard of.
  plan: string;
  source: "default" | "manual" | "store" | "stripe";
  expiresAt: string | null;
  expired: boolean;
  /** The stored plan that lapsed when the owner now reads as Free (#215). */
  expiredPlan?: string | null;
  limits: { postsPerWeek: number; templates: number; watermark: boolean; reviewSync: boolean; aiReplies: boolean; brandVoice: boolean; businesses: number };
  usage: WeeklyUsage[];
};

export async function fetchEntitlements(client: ApiClient): Promise<Entitlements> {
  const data = await client.request<Partial<Entitlements>>("/api/entitlements");
  if (!data || typeof data.plan !== "string" || !data.plan.trim() || !data.limits || typeof data.limits !== "object" || !Array.isArray(data.usage)) {
    throw new Error("The server returned an invalid plan.");
  }
  return data as Entitlements;
}
