import { basename, join, resolve } from "node:path";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { query, transaction } from "../../lib/db";
import { DEV_OWNERS, ensureDevOwner, type DevOwnerKey } from "../../lib/devAuth";
import { entitlementsFor, PLAN_LIMITS, setOwnerPlan, type Plan } from "../../lib/services/entitlements";
import { generationWeek } from "../../lib/services/generation";
import { renderDraftImage } from "../../lib/services/imageRenderer";
import { mediaRoot } from "../../lib/services/media";
import { importReviewsCsv } from "../../lib/services/reviewImport";
import { assertSeedable } from "./guard";
import { SEED_BUSINESSES, SEED_PUSH_TOKEN, type BusinessSeed, type DraftSeed, type DraftStatus } from "./fixtures";

const CSV_DIR = resolve(__dirname, "..", "..", "sample-data", "csv");
const OWNER_PLANS: Record<DevOwnerKey, Plan> = { pro: "pro", free: "free", email: "free" };
const OWNER_IDS = Object.values(DEV_OWNERS).map(owner => owner.id);

// Owner transitions per final status as [reason, from, to]; a failed draft has none.
const HISTORY: Record<DraftStatus, [string, string, string][]> = {
  draft: [],
  approved: [["status:approved", "draft", "approved"]],
  shared: [["status:approved", "draft", "approved"], ["owner_shared", "approved", "shared"]],
  archived: [["status:archived", "draft", "archived"]],
  failed: []
};

export type SeedSummary = {
  owners: Record<string, Plan>;
  businesses: { name: string; owner: string; reviews: number; drafts: Record<string, number> }[];
};

// The owner is on the plan the demo needs, with one audit row per change rather than
// one per run, so a second seed leaves owner_plan_events alone.
async function ensurePlan(ownerId: string, plan: Plan) {
  const current = await entitlementsFor(ownerId);
  const settled = current.plan === plan && (plan === "free" || (current.source === "manual" && !current.expiresAt));
  if (!settled) await setOwnerPlan(ownerId, plan, { actor: "dev-seed", reason: "demo data" });
}

async function seededImagePaths(): Promise<string[]> {
  const rows = await query<{ image_path: string | null }>(
    `SELECT d.image_path FROM draft_posts d JOIN businesses b ON b.id=d.business_id WHERE b.owner_id = ANY($1)`,
    [OWNER_IDS]
  );
  return rows.rows.flatMap(row => row.image_path ? [row.image_path] : []);
}

function removeMedia(paths: string[]) {
  for (const path of paths) {
    const file = join(mediaRoot(), basename(path));
    if (existsSync(file)) unlinkSync(file);
  }
}

// The weekly worker scans every owned business. Reserving this week's full target
// keeps the demo quiet: no OpenAI key is needed, and no extra drafts appear while
// the flow is being walked. Returns the period so draft jobs can point at it.
async function reserveWeek(businessId: number, seed: BusinessSeed, plan: Plan) {
  const target = Math.min(seed.weeklyTarget, PLAN_LIMITS[plan].postsPerWeek);
  const week = generationWeek(new Date(), seed.timezone);
  await query(
    `INSERT INTO generation_periods(business_id,period_start,timezone,target,allocated,completed,reason)
     VALUES($1,$2,$3,$4,$4,$4,'quota_met')`,
    [businessId, week, seed.timezone, target]
  );
  return week;
}

async function seedDraft(businessId: number, owner: string, seed: BusinessSeed, plan: Plan, week: string, draft: DraftSeed) {
  const review = (await query<{ id: number; rating: number; author_name: string | null }>(
    "SELECT id,rating,author_name FROM reviews WHERE business_id=$1 AND source_review_id=$2",
    [businessId, draft.review]
  )).rows[0];
  if (!review) throw new Error(`Seed draft refers to ${draft.review}, which is not in ${seed.csv}`);

  const failed = draft.status === "failed";
  const draftId = (await query<{ id: number }>(
    `INSERT INTO draft_posts(business_id,review_id,quote_text,caption_text,status,audit_note)
     VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
    [businessId, review.id, draft.quote, draft.caption, draft.status, failed ? "generation_failed" : null]
  )).rows[0].id;

  await query(
    `INSERT INTO generation_jobs(business_id,period_start,draft_id,state,attempts,error_code)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [businessId, week, draftId, failed ? "failed" : "complete", failed ? 3 : 1, failed ? "generation_failed" : null]
  );
  if (failed) return;

  const image = await renderDraftImage({
    draftPostId: draftId,
    businessName: seed.name,
    quoteText: draft.quote,
    rating: review.rating,
    authorName: review.author_name,
    brandHex: seed.colors.primary,
    secondaryBrandHex: seed.colors.secondary,
    brandTone: seed.tone,
    templateConfig: seed.colors,
    watermark: PLAN_LIMITS[plan].watermark
  });
  const shared = draft.status === "shared";
  await query(
    `UPDATE draft_posts SET image_path=$2, shared_at=CASE WHEN $3 THEN now() - interval '1 day' END, updated_at=now() WHERE id=$1`,
    [draftId, image.publicPath, shared]
  );

  // The owner's history, as the phone would have written it.
  const history = HISTORY[draft.status];
  let age = history.length + 1;
  for (const [reason, from, to] of history) {
    await query(
      `INSERT INTO draft_events(draft_id,actor_id,action,reason,from_status,to_status,at)
       VALUES($1,$2,'status',$3,$4,$5,now() - ($6 || ' days')::interval)`,
      [draftId, owner, reason, from, to, String(age--)]
    );
  }
  // The image_path update above is bookkeeping, not owner history.
  await query("DELETE FROM draft_events WHERE draft_id=$1 AND action='updated'", [draftId]);
}

async function seedBusiness(seed: BusinessSeed, owner: string, plan: Plan) {
  const businessId = (await query<{ id: number }>(
    `INSERT INTO businesses(name,timezone,brand_colors,brand_tone,weekly_target,owner_id,brand_voice,brand_voice_updated_at)
     VALUES($1,$2,$3::jsonb,$4,$5,$6,$7::text,CASE WHEN $7::text IS NULL THEN NULL ELSE now() - interval '2 days' END) RETURNING id`,
    [seed.name, seed.timezone, JSON.stringify(seed.colors), seed.tone, seed.weeklyTarget, owner, seed.brandVoice ?? null]
  )).rows[0].id;

  const summary = await importReviewsCsv(businessId, readFileSync(join(CSV_DIR, seed.csv), "utf8"));
  if (summary.imported === 0 || summary.rejectedInvalid || summary.failedRows) {
    throw new Error(`Seed CSV ${seed.csv} did not import cleanly: ${JSON.stringify(summary)}`);
  }

  const week = await reserveWeek(businessId, seed, plan);
  for (const draft of seed.drafts) await seedDraft(businessId, owner, seed, plan, week, draft);

  if (seed.googleLocation) {
    await query(
      `INSERT INTO google_connections(business_id,owner_id,location_name,status,last_sync_at,last_sync_count)
       VALUES($1,$2,$3,'active',now() - interval '1 day',$4)`,
      [businessId, owner, seed.googleLocation, summary.imported]
    );
  }
  return businessId;
}

// Replaces everything owned by the two seeded demo owners and nothing else. Safe to
// repeat: a second run rebuilds the same rows (new ids, same content).
export async function runSeed(env: Record<string, string | undefined> = process.env): Promise<SeedSummary> {
  assertSeedable(env);

  const owners = {} as Record<DevOwnerKey, string>;
  for (const key of Object.keys(DEV_OWNERS) as DevOwnerKey[]) owners[key] = await ensureDevOwner(key);
  // Keep the Free demo owner nameless on every run, so the profile empty state
  // (#149) stays visible even when a previous seed or demo edit filled it in.
  await query("UPDATE auth_users SET name=$2, name_source='provider' WHERE id=$1", [owners.free, DEV_OWNERS.free.name]);

  const oldImages = await seededImagePaths();
  const ids = await transaction(async () => {
    for (const key of Object.keys(owners) as DevOwnerKey[]) await ensurePlan(owners[key], OWNER_PLANS[key]);
    await query("DELETE FROM businesses WHERE owner_id = ANY($1)", [OWNER_IDS]);
    await query("DELETE FROM device_push_tokens WHERE owner_id = ANY($1) AND token LIKE 'ExponentPushToken[devseed-%'", [OWNER_IDS]);
    await query(
      `INSERT INTO device_push_tokens(owner_id,token,platform) VALUES($1,$2,'ios')
       ON CONFLICT(token) DO UPDATE SET owner_id=EXCLUDED.owner_id`,
      [owners.pro, SEED_PUSH_TOKEN]
    );

    const created: number[] = [];
    for (const seed of SEED_BUSINESSES) {
      created.push(await seedBusiness(seed, owners[seed.owner], OWNER_PLANS[seed.owner]));
    }
    return created;
  });
  removeMedia(oldImages);

  const businesses = [];
  for (const [index, seed] of SEED_BUSINESSES.entries()) {
    const reviews = await query<{ n: string }>("SELECT count(*) n FROM reviews WHERE business_id=$1", [ids[index]]);
    const statuses = await query<{ status: string; n: string }>(
      "SELECT status,count(*) n FROM draft_posts WHERE business_id=$1 GROUP BY status", [ids[index]]
    );
    businesses.push({
      name: seed.name,
      owner: owners[seed.owner],
      reviews: Number(reviews.rows[0].n),
      drafts: Object.fromEntries(statuses.rows.map(row => [row.status, Number(row.n)]))
    });
  }
  return {
    owners: Object.fromEntries(Object.keys(owners).map(key => [owners[key as DevOwnerKey], OWNER_PLANS[key as DevOwnerKey]])),
    businesses
  };
}
