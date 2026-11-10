import { basename, join, resolve } from "node:path";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { query, transaction } from "../../lib/db";
import { DEV_OWNERS, DEV_OWNER_PASSWORD, ensureDevOwner, type DevOwnerKey } from "../../lib/devAuth";
import { hashPassword } from "../../lib/passwordAuth";
import { entitlementsFor, PLAN_LIMITS, setOwnerPlan, type Plan } from "../../lib/services/entitlements";
import { generationWeek } from "../../lib/services/generation";
import { renderDraftImage } from "../../lib/services/imageRenderer";
import { mediaRoot } from "../../lib/services/media";
import { importReviewsCsv } from "../../lib/services/reviewImport";
import { assertSeedable } from "./guard";
import { SEED_BUSINESSES, SEED_PUSH_TOKEN, type BusinessSeed, type DraftSeed, type DraftStatus } from "./fixtures";

const CSV_DIR = resolve(__dirname, "..", "..", "sample-data", "csv");
const OWNER_PLANS: Record<DevOwnerKey, Plan> = { pro: "pro", business: "business", free: "free", email: "free", password: "free" };
// The Business demo owner walks a provider subscription rather than a manual grant,
// so the account screen can show a web subscription (#219). The fake adapter never
// reaches a provider; this is just the same row a checkout would have written.
const OWNER_SUBSCRIPTIONS: Partial<Record<DevOwnerKey, { provider: string; externalId: string; plan: Plan }>> = {
  business: { provider: "fake", externalId: "dev-seed-business", plan: "business" }
};
const OWNER_IDS = Object.values(DEV_OWNERS).map(owner => owner.id);

// No Buffer connection is seeded (#29): a fake connection would need real
// encrypted tokens and would make the demo claim an account it does not have.
// Connecting is an owner action against their own Buffer account.

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

// Keeps one synthetic subscription row and its initial audit event. A second seed
// renews the row, so the demo owner doesn't lapse to Free, but adds no history.
async function ensureSubscription(ownerId: string, subscription: { provider: string; externalId: string; plan: Plan }) {
  const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const existing = await query<{ owner_id: string }>(
    "SELECT owner_id FROM owner_subscriptions WHERE provider=$1 AND external_id=$2",
    [subscription.provider, subscription.externalId]
  );
  if (existing.rowCount) {
    if (existing.rows[0].owner_id !== ownerId) throw new Error("A seed subscription belongs to another owner");
    await query(
      "UPDATE owner_subscriptions SET status='active', plan=$3, current_period_end=$4, last_event_at=now(), updated_at=now() WHERE provider=$1 AND external_id=$2",
      [subscription.provider, subscription.externalId, subscription.plan, periodEnd]
    );
    return;
  }
  await query(
    `INSERT INTO owner_subscriptions(owner_id,provider,external_id,plan,status,current_period_end,last_event_at)
     VALUES($1,$2,$3,$4,'active',$5,now())`,
    [ownerId, subscription.provider, subscription.externalId, subscription.plan, periodEnd]
  );
  await query(
    `INSERT INTO owner_plan_events(owner_id,plan,source,expires_at,actor,reason)
     VALUES($1,$2,'stripe',$3,'dev-seed','demo subscription')`,
    [ownerId, subscription.plan, periodEnd]
  );
}

// Keeps one synthetic password credential for the password demo owner (#159). It
// uses the production hashing path, resets any lock/counter left by earlier
// manual testing, and never writes the plaintext anywhere.
async function ensureDemoPassword(ownerId: string, email: string) {
  const stored = await hashPassword(DEV_OWNER_PASSWORD);
  await query(
    `INSERT INTO password_credentials(owner_id,email,password_hash,scrypt_n,scrypt_r,scrypt_p,salt,key_length,verified_at,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,now(),now(),now())
     ON CONFLICT(owner_id) DO UPDATE SET
       email=EXCLUDED.email, password_hash=EXCLUDED.password_hash,
       scrypt_n=EXCLUDED.scrypt_n, scrypt_r=EXCLUDED.scrypt_r, scrypt_p=EXCLUDED.scrypt_p,
       salt=EXCLUDED.salt, key_length=EXCLUDED.key_length, verified_at=now(),
       failed_attempts=0, failure_window_started_at=NULL, lock_count=0, locked_until=NULL, updated_at=now()`,
    [ownerId, email, stored.hash, stored.n, stored.r, stored.p, stored.salt, stored.keyLength]
  );
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
    watermark: PLAN_LIMITS[plan].watermark,
    templatesAllowed: PLAN_LIMITS[plan].templates
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

// Replaces everything owned by the four seeded demo owners and nothing else. Safe to
// repeat: a second run rebuilds the same rows (new ids, same content).
export async function runSeed(env: Record<string, string | undefined> = process.env): Promise<SeedSummary> {
  assertSeedable(env);

  const owners = {} as Record<DevOwnerKey, string>;
  for (const key of Object.keys(DEV_OWNERS) as DevOwnerKey[]) owners[key] = await ensureDevOwner(key);
  await ensureDemoPassword(owners.password, DEV_OWNERS.password.email);
  // Keep the Free demo owner nameless on every run, so the profile empty state
  // (#149) stays visible even when a previous seed or demo edit filled it in.
  await query("UPDATE auth_users SET name=$2, name_source='provider' WHERE id=$1", [owners.free, DEV_OWNERS.free.name]);

  const oldImages = await seededImagePaths();
  const ids = await transaction(async () => {
    for (const key of Object.keys(owners) as DevOwnerKey[]) {
      const subscription = OWNER_SUBSCRIPTIONS[key];
      if (subscription) {
        // An older seed may have left a manual Business grant; remove it so the
        // sample shows the subscription source instead of a same-plan tie.
        await query("DELETE FROM owner_plans WHERE owner_id=$1", [owners[key]]);
        await ensureSubscription(owners[key], subscription);
      } else {
        await ensurePlan(owners[key], OWNER_PLANS[key]);
      }
    }
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
