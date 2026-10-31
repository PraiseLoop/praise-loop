import { validTimezone } from "../timezone";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { query, transaction } from "../db";
import { chargeGeneration } from "../authorization";
import { selectQuoteCandidates } from "./quoteSelector";
import { generateCaptionVariants } from "./captions";
import { renderDraftImage } from "./imageRenderer";
import { entitlementsFor } from "./entitlements";
import type { BrandTone } from "../branding";
export function generationWeek(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find(p=>p.type===type)!.value;
  const day = new Date(`${get("year")}-${get("month")}-${get("day")}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  return day.toISOString().slice(0,10);
}
export async function requestGeneration(businessId: number, limit = 5, now = new Date()) {
  return transaction(async c => {
    // Same business lock serializes both quota reservation and review selection.
    const business = (await c.query("SELECT * FROM businesses WHERE id=$1 AND owner_id IS NOT NULL FOR UPDATE",[businessId])).rows[0];
    if (!business) throw new Error("Owned business required");
    if (!validTimezone(business.timezone)) return { inserted:0, reason:"invalid_timezone", periodStart:null, target:business.weekly_target };
    // The plan caps the owner's configured weekly target; enforce it inside the
    // same business lock so a downgrade cannot be raced by a queued request.
    const entitlements = await entitlementsFor(business.owner_id, (sql,values)=>c.query(sql,values), now);
    const target = Math.min(business.weekly_target, entitlements.limits.postsPerWeek);
    const week = generationWeek(now,business.timezone);
    await c.query(`INSERT INTO generation_periods(business_id,period_start,timezone,target,allocated,completed)
      SELECT $1,$2,$3,$4,count(*),count(*) FILTER(WHERE caption_text<>'' AND image_path IS NOT NULL)
      FROM draft_posts WHERE business_id=$1 AND duplicate_of IS NULL AND
      (created_at AT TIME ZONE $3)::date >= $2::date AND (created_at AT TIME ZONE $3)::date < $2::date+7
      ON CONFLICT DO NOTHING`,[businessId,week,business.timezone,target]);
    const period = (await c.query("SELECT * FROM generation_periods WHERE business_id=$1 AND period_start=$2 FOR UPDATE",[businessId,week])).rows[0];
    // The cap follows the current plan both ways: a downgrade lowers an existing period and an
    // upgrade raises it, so a new Pro owner is not stuck at the Free allowance until next week.
    const effectiveTarget = target;
    // Adopt existing incomplete drafts from this period; never create replacement records.
    await c.query(`INSERT INTO generation_jobs(business_id,period_start,draft_id,next_at)
      SELECT business_id,$2,id,$3 FROM draft_posts WHERE business_id=$1 AND duplicate_of IS NULL
      AND status IN ('draft','failed') AND (caption_text='' OR image_path IS NULL)
      AND (created_at AT TIME ZONE $4)::date >= $2::date AND (created_at AT TIME ZONE $4)::date < $2::date+7
      ORDER BY id LIMIT greatest(0,5-(SELECT count(*)::integer FROM generation_jobs WHERE business_id=$1 AND state IN ('pending','retry','running'))) ON CONFLICT(draft_id) DO NOTHING`,[businessId,week,now,business.timezone]);
    const backlog = Number((await c.query("SELECT count(*) n FROM generation_jobs WHERE business_id=$1 AND state IN ('pending','retry','running')",[businessId])).rows[0].n);
    const count = Math.max(0,Math.min(limit,effectiveTarget-period.allocated,5-backlog));
    const candidates = count ? await selectQuoteCandidates(businessId,count,(sql,values)=>c.query(sql,values)) : [];
    for (const candidate of candidates) await c.query("INSERT INTO generation_jobs(business_id,period_start,draft_id,next_at) VALUES($1,$2,$3,$4) ON CONFLICT(draft_id) DO NOTHING",[businessId,week,candidate.draftPostId,now]);
    const reason = backlog >= 5 ? "backlog_full" : period.allocated >= effectiveTarget ? "quota_met" : !candidates.length ? "reviews_exhausted" : "queued";
    await c.query("UPDATE generation_periods SET allocated=allocated+$3,reason=$4,target=$5 WHERE business_id=$1 AND period_start=$2",[businessId,week,candidates.length,reason,effectiveTarget]);
    return { inserted:candidates.length, reason, periodStart:week, target:effectiveTarget };
  });
}
// Removes a freshly rendered file when its draft no longer exists, so a render that was in flight when
// the account was deleted does not leave the owner's content on disk. A file whose draft still exists
// is kept.
export async function discardOrphanRender(draftId:number,file:string,publicPath?:string){
  if ((await query("SELECT 1 FROM draft_posts WHERE id=$1",[draftId])).rowCount) return false;
  // Identical content renders to the same name, so another owner's draft or logo may point at this file.
  if (publicPath && (await query("SELECT 1 FROM draft_posts WHERE image_path=$1 UNION SELECT 1 FROM businesses WHERE logo_url=$1",[publicPath])).rowCount) return false;
  await rm(file,{force:true}).catch(()=>undefined);
  return true;
}
export type GenerationDeps = { captions: typeof generateCaptionVariants; render: typeof renderDraftImage; clock: () => Date };
const defaults: GenerationDeps = { captions:generateCaptionVariants, render:renderDraftImage, clock:()=>new Date() };
export async function processGeneration(id: number, deps: GenerationDeps = defaults) {
  const lease = randomUUID(), now = deps.clock();
  const claimed = (await query(`UPDATE generation_jobs SET state='running',attempts=attempts+1,lease=$2,lease_until=$3::timestamptz+interval '90 seconds'
    WHERE id=$1 AND attempts<3 AND ((state IN ('pending','retry') AND next_at<=$3) OR (state='running' AND lease_until<$3)) RETURNING *`,[id,lease,now])).rows[0];
  if (!claimed) return false;
  const heartbeat = setInterval(()=> { void query("UPDATE generation_jobs SET lease_until=$3::timestamptz+interval '90 seconds' WHERE id=$1 AND lease=$2",[id,lease,deps.clock()]).catch(()=>{}); },10000);
  try {
    const row = (await query(`SELECT d.*,b.name,b.owner_id,b.brand_colors,b.logo_url,b.brand_tone,b.brand_voice,r.rating,r.author_name FROM draft_posts d JOIN businesses b ON b.id=d.business_id LEFT JOIN reviews r ON r.id=d.review_id AND r.business_id=d.business_id WHERE d.id=$1`,[claimed.draft_id])).rows[0];
    if (!row || !["draft","failed"].includes(row.status)) throw new Error("draft_not_editable");
    if (!row.caption_text.trim()) {
      if (!await chargeGeneration(row.owner_id)) throw new Error("daily_limit");
      const captions = await deps.captions({businessName:row.name,quoteText:row.quote_text,brandTone:row.brand_tone as BrandTone,brandVoice:row.brand_voice as string | null});
      const caption = captions[row.brand_tone as BrandTone];
      if (!caption?.trim()) throw new Error("caption_empty");
      const saved = await query("UPDATE draft_posts SET caption_text=$2,updated_at=now() WHERE id=$1 AND status IN ('draft','failed') AND EXISTS(SELECT 1 FROM generation_jobs WHERE id=$3 AND lease=$4 AND state='running') RETURNING id",[row.id,caption,id,lease]);
      if (!saved.rowCount) return false;
    }
    if (!row.image_path) {
      const entitlements = await entitlementsFor(row.owner_id);
      const image = await deps.render({draftPostId:row.id,businessName:row.name,quoteText:row.quote_text,rating:row.rating,authorName:row.author_name,
        brandHex:row.brand_colors.primary,secondaryBrandHex:row.brand_colors.secondary,logoUrl:row.logo_url,
        brandTone:row.brand_tone,templateConfig:row.brand_colors,watermark:entitlements.limits.watermark});
      const saved = await query("UPDATE draft_posts SET image_path=$2,updated_at=now() WHERE id=$1 AND status IN ('draft','failed') AND EXISTS(SELECT 1 FROM generation_jobs WHERE id=$3 AND lease=$4 AND state='running') RETURNING id",[row.id,image.publicPath,id,lease]);
      if (!saved.rowCount) {
        // The draft was deleted while this render was in flight (account deletion): nothing will ever
        // point at the file, and it holds the owner's business name and review text, so remove it.
        if (typeof image.fileSystemPath === "string") await discardOrphanRender(row.id,image.fileSystemPath,image.publicPath);
        return false;
      }
    }
    await transaction(async c=>{
      const done = await c.query("UPDATE generation_jobs SET state='complete',error_code=NULL,lease=NULL,lease_until=NULL WHERE id=$1 AND lease=$2 AND state='running' RETURNING business_id,period_start,draft_id",[id,lease]);
      if (!done.rowCount) return;
      await c.query("UPDATE generation_periods SET completed=completed+1 WHERE business_id=$1 AND period_start=$2",[claimed.business_id,claimed.period_start]);
      await c.query("UPDATE draft_posts SET status='draft',audit_note=NULL,updated_at=now() WHERE id=$1 AND status IN ('draft','failed')",[claimed.draft_id]);
    });
    return true;
  } catch (e) {
    const code = e instanceof Error && ["daily_limit","caption_empty","draft_not_editable"].includes(e.message) ? e.message : "generation_failed";
    await transaction(async c=>{
      const result = await c.query("UPDATE generation_jobs SET state=CASE WHEN attempts>=3 OR $4='draft_not_editable' THEN 'failed' ELSE 'retry' END,next_at=$3::timestamptz+(30*power(2,attempts-1))*interval '1 second',error_code=$4,lease=NULL,lease_until=NULL WHERE id=$1 AND lease=$2 RETURNING draft_id",[id,lease,deps.clock(),code]);
      if (result.rowCount) await c.query("UPDATE draft_posts SET status='failed',audit_note=$2,updated_at=now() WHERE id=$1 AND status IN ('draft','failed')",[claimed.draft_id,code]);
    });
    return false;
  } finally { clearInterval(heartbeat); }
}
export async function retryGeneration(draftId: number) {
  return transaction(async c=>{
    const draft = (await c.query("SELECT status FROM draft_posts WHERE id=$1 FOR UPDATE",[draftId])).rows[0];
    if (!draft || draft.status !== "failed") return false;
    const result = await c.query("UPDATE generation_jobs SET state='pending',attempts=0,manual_retries=manual_retries+1,next_at=now(),error_code=NULL WHERE draft_id=$1 AND state='failed' AND manual_retries<2 RETURNING id",[draftId]);
    if (result.rowCount) await c.query("UPDATE draft_posts SET status='draft',updated_at=now() WHERE id=$1",[draftId]);
    return !!result.rowCount;
  });
}
