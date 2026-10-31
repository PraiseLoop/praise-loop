import { query, transaction } from "../db";

export type Plan = "free" | "pro";
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
  /** True when a stored Pro plan has lapsed and is being treated as Free. */
  expired: boolean;
  limits: EntitlementLimits;
};

// Keep these limits in one place: the worker, renderer and routes all read them
// from here, and the app only displays what GET /api/entitlements returns.
export const PLAN_LIMITS: Record<Plan, EntitlementLimits> = {
  free: { postsPerWeek: 1, templates: 1, watermark: true, reviewSync: false, aiReplies: false, brandVoice: false, businesses: 1 },
  pro: { postsPerWeek: 5, templates: 5, watermark: false, reviewSync: true, aiReplies: true, brandVoice: true, businesses: 3 }
};

type Executor = (sql: string, values: unknown[]) => Promise<{ rows: any[] }>;

export function planIsActive(plan: string, expiresAt: Date | string | null, now = new Date()): plan is Plan {
  if (plan !== "free" && plan !== "pro") return false;
  return plan === "free" || !expiresAt || new Date(expiresAt).getTime() > now.getTime();
}

export function entitlementsForPlan(plan: string, source: PlanSource, expiresAt: Date | string | null, now = new Date()): Entitlements {
  const effective: Plan = planIsActive(plan, expiresAt, now) ? plan : "free";
  return {
    plan: effective,
    source,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    expired: plan === "pro" && effective === "free",
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
