import { query, transaction } from "../db";
import { PLAN_ORDER } from "../plansDisplay";
import { sourceForProvider, subscriptionIsActive } from "./subscriptions";

export type Plan = "free" | "pro" | "business";
export type PlanSource = "default" | "manual" | "store" | "stripe";

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

export type BusinessAllowance = {
  /** Owned businesses that may generate, oldest first. */
  active: number[];
  /** The businesses over the plan's limit: stored and visible, but generation is paused. */
  paused: number[];
};

// The rule after a downgrade: nothing is deleted. The oldest businesses within the
// plan's limit stay active (created_at, then id) and the rest are paused. The same
// check runs inside the generation lock, so a paused business creates no drafts and
// reserves no quota; upgrading raises the limit and resumes them with no data change.
export async function businessAllowance(ownerId: string, limit: number, exec: Executor = query): Promise<BusinessAllowance> {
  const rows = (await exec("SELECT id FROM businesses WHERE owner_id=$1 ORDER BY created_at, id", [ownerId])).rows;
  const ids = rows.map(row => Number(row.id));
  const active = ids.slice(0, Math.max(0, Math.floor(limit)));
  const allowed = new Set(active);
  return { active, paused: ids.filter(id => !allowed.has(id)) };
}

type Grant = { plan: Plan; source: PlanSource; expiresAt: Date | null; active: boolean };

const planRank = (plan: Plan) => PLAN_ORDER.indexOf(plan);

function highest(grants: Grant[]): Grant | undefined {
  // PLAN_ORDER is the single ranking, so adding a tier cannot leave a hardcoded
  // list behind. Manual grants are added first, so they win a same-tier tie.
  return grants.slice().sort((a, b) => planRank(b.plan) - planRank(a.plan))[0];
}

// The effective plan is the highest active grant across the manual row and every
// provider subscription. Expired or lapsed grants fall back to free without
// deleting the stored row, so restoring expiry (or a renewal) brings the plan
// back with no data changes. `exec` may be a transaction client: generation
// calls this inside its owner lock.
export async function entitlementsFor(ownerId: string, exec: Executor = query, now = new Date()): Promise<Entitlements> {
  const manual = (await exec("SELECT plan,source,expires_at FROM owner_plans WHERE owner_id=$1", [ownerId])).rows[0];
  const subscriptions = (await exec(
    "SELECT provider,plan,status,current_period_end FROM owner_subscriptions WHERE owner_id=$1",
    [ownerId]
  )).rows;

  const grants: Grant[] = [];
  if (manual && Object.hasOwn(PLAN_LIMITS, manual.plan)) {
    grants.push({
      plan: manual.plan,
      source: manual.source,
      expiresAt: manual.expires_at ? new Date(manual.expires_at) : null,
      active: planIsActive(manual.plan, manual.expires_at, now)
    });
  }
  for (const row of subscriptions) {
    if (!Object.hasOwn(PLAN_LIMITS, row.plan)) continue;
    grants.push({
      plan: row.plan,
      source: sourceForProvider(row.provider),
      expiresAt: row.current_period_end ? new Date(row.current_period_end) : null,
      active: subscriptionIsActive(row.status, row.current_period_end, now)
    });
  }

  const active = highest(grants.filter(grant => grant.active));
  if (active) {
    // Do not re-check the expiry here: a past_due subscription inside its grace
    // period is active even though its paid-through date has passed.
    return {
      plan: active.plan,
      source: active.source,
      expiresAt: active.expiresAt ? active.expiresAt.toISOString() : null,
      expired: false,
      expiredPlan: null,
      limits: PLAN_LIMITS[active.plan]
    };
  }

  // No grant is active, so this owner is on Free whatever the dates say: a failed first
  // payment or an immediate cancellation still has a future period end. Only a grant whose
  // period has really ended is reported as expired, so the app can say when it lapsed.
  const lapsed = highest(grants.filter(grant => grant.plan !== "free" && grant.expiresAt && grant.expiresAt.getTime() <= now.getTime()));
  return {
    plan: "free",
    source: lapsed?.source ?? "default",
    expiresAt: lapsed?.expiresAt ? lapsed.expiresAt.toISOString() : null,
    expired: Boolean(lapsed),
    expiredPlan: lapsed?.plan ?? null,
    limits: PLAN_LIMITS.free
  };
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
