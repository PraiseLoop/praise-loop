import { query, transaction } from "../db";

export type Plan = "free" | "pro" | "business";
export type PlanSource = "default" | "manual" | "store";

export type EntitlementLimits = {
  /** Drafts the weekly generator may create for one owned business. */
  postsPerWeek: number;
  /** Templates available to the business; only one exists today. */
  templates: number;
  watermark: boolean;
  reviewSync: boolean;
  aiReplies: boolean;
  /** Learn a voice profile from the owner's public website. */
  brandVoice: boolean;
  /** Owned businesses, enforced when a new business is created. */
  businesses: number;
};

export type Entitlements = {
  plan: Plan;
  source: PlanSource;
  expiresAt: string | null;
  /** True when a stored paid plan has lapsed and is being treated as Free. */
  expired: boolean;
  /** The stored plan that lapsed, so the copy can name it; null when nothing lapsed. */
  expiredPlan: Plan | null;
  limits: EntitlementLimits;
};

// Keep these limits in one place: the worker, renderer and routes all read them
// from here, and the app only displays what GET /api/entitlements returns.
export const PLAN_LIMITS: Record<Plan, EntitlementLimits> = {
  free: { postsPerWeek: 1, templates: 1, watermark: true, reviewSync: false, aiReplies: false, brandVoice: false, businesses: 1 },
  pro: { postsPerWeek: 5, templates: 5, watermark: false, reviewSync: true, aiReplies: true, brandVoice: true, businesses: 1 },
  business: { postsPerWeek: 5, templates: 5, watermark: false, reviewSync: true, aiReplies: true, brandVoice: true, businesses: 5 }
};

type Executor = (sql: string, values: unknown[]) => Promise<{ rows: any[] }>;

export function planIsActive(plan: string, expiresAt: Date | string | null, now = new Date()): plan is Plan {
  if (!Object.hasOwn(PLAN_LIMITS, plan)) return false;
  return plan === "free" || !expiresAt || new Date(expiresAt).getTime() > now.getTime();
}

export function entitlementsForPlan(plan: string, source: PlanSource, expiresAt: Date | string | null, now = new Date()): Entitlements {
  const active = planIsActive(plan, expiresAt, now);
  const effective: Plan = active ? plan : "free";
  const expiredPlan = !active && planIsActive(plan, null, now) && plan !== "free" ? plan : null;
  return {
    plan: effective,
    source,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    expired: expiredPlan !== null,
    expiredPlan,
    limits: PLAN_LIMITS[effective]
  };
}

// Expired plans fall back to free without deleting the row, so restoring expiry
// (or a renewal webhook) brings Pro back with no data changes.
export async function entitlementsFor(ownerId: string, exec: Executor = query, now = new Date()): Promise<Entitlements> {
  const row = (await exec("SELECT plan,source,expires_at FROM owner_plans WHERE owner_id=$1", [ownerId])).rows[0];
  if (!row) return entitlementsForPlan("free", "default", null, now);
  return entitlementsForPlan(row.plan, row.source, row.expires_at, now);
}

export async function setOwnerPlan(ownerId: string, plan: Plan, options: { source?: "manual" | "store"; expiresAt?: Date | string | null; actor?: string; reason?: string } = {}) {
  const source = options.source ?? "manual";
  const actor = options.actor ?? "operator";
  const reason = options.reason ?? `Set ${plan}`;
  const expiresAt = options.expiresAt ? new Date(options.expiresAt) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new Error("Use a valid expiry date");
  return transaction(async c => {
    await c.query(`INSERT INTO owner_plans(owner_id,plan,source,expires_at,updated_at) VALUES($1,$2,$3,$4,now())
      ON CONFLICT(owner_id) DO UPDATE SET plan=EXCLUDED.plan,source=EXCLUDED.source,expires_at=EXCLUDED.expires_at,updated_at=now()`, [ownerId, plan, source, expiresAt]);
    await c.query("INSERT INTO owner_plan_events(owner_id,plan,source,expires_at,actor,reason) VALUES($1,$2,$3,$4,$5,$6)", [ownerId, plan, source, expiresAt, actor, reason]);
    return entitlementsFor(ownerId, (sql, values) => c.query(sql, values));
  });
}
