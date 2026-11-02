import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { NextRequest, NextResponse } from "next/server";
import { currentOwner } from "../authorization";
import { query, transaction } from "../db";
import { generationWeek } from "./generation";
import { mediaRoot } from "./media";
export async function availableImage(path: string | null) {
  if (!path || !/^\/api\/media\/[A-Za-z0-9][A-Za-z0-9._-]*\.png$/.test(path)) return false;
  try {
    const data=await readFile(join(mediaRoot(),path.split("/").pop()!));
    if(data.length>5000000)return false;
    const metadata=await sharp(data,{limitInputPixels:2000000}).metadata();
    await sharp(data,{limitInputPixels:2000000}).stats();
    return metadata.format==="png" && metadata.width===1080 && metadata.height===1080;
  } catch { return false; }
}
export function draftMutation(action: string, work: (req: NextRequest, context: any)=>Promise<Response>) {
  return async (req: NextRequest, context?: any) => transaction(async c=>{
    const body=await req.clone().json(), owner=currentOwner();
    const row=(await c.query("SELECT d.* FROM draft_posts d JOIN businesses b ON b.id=d.business_id WHERE d.id=$1 AND b.owner_id=$2 FOR UPDATE OF d",[body.draftPostId,owner])).rows[0];
    const error=(message:string,status=409)=>NextResponse.json({error:message},{status});
    if(!row)return error("Draft not found",404);
    if(!Number.isInteger(body.version)||body.version!==row.version)return error("Draft changed; refresh and retry");
    if(["scheduled","published"].includes(row.status))return error("Use explicit provider cancel/reschedule before editing");
    if(row.status==="shared")return error("This post was shared from your phone and is read-only");
    if((await c.query("SELECT 1 FROM posting_slot_claims WHERE draft_id=$1 AND state IN ('queued','submitting','submitted','unknown')",[row.id])).rowCount)return error("Resolve provider scheduling/cancellation before editing");
    // A failed, missed or drafted earlier attempt is history; editing the post starts over.
    await c.query("DELETE FROM posting_slot_claims WHERE draft_id=$1 AND state IN ('error','missed','drafted')",[row.id]);
    if(action==="schedule")return error("Scheduling requires the verified scheduler integration");
    if(row.status==="archived" && !(action==="status" && body.status==="draft"))return error("Restore archived content before editing");
    if(action==="status" && !["draft","approved","archived","shared"].includes(body.status))return error("Invalid transition",400);
    if(action==="status" && body.status==="shared" && row.status!=="approved")return error("Only approved posts can be marked as shared",400);
    const archiving=action==="status" && body.status==="archived";
    const active=(await c.query("SELECT 1 FROM generation_jobs WHERE draft_id=$1 AND state IN ('pending','running','retry')",[row.id])).rowCount;
    if(active && !archiving)return error("Generation is still active; wait for completion or archive");
    if(action==="status" && body.status==="approved" && (!row.caption_text.trim()||!await availableImage(row.image_path)))return error("Approval needs a caption and available 1080px PNG");
    await c.query("SELECT set_config('app.actor_id',$1,true),set_config('app.action',$2,true),set_config('app.reason',$3,true)",[owner,action,action === "status" && body.status === "shared" ? "owner_shared" : action === "status" && typeof body.auditNote === "string" && body.auditNote.trim() ? body.auditNote.trim() : `${action}:${action==='status'?body.status:'explicit_owner_action'}`]);
    const response=await work(req,context);
    if(!response.ok)return response;
    if(archiving)await c.query("UPDATE generation_jobs SET state='failed',lease=NULL,error_code='archived' WHERE draft_id=$1 AND state IN ('pending','running','retry')",[row.id]);
    if(!["status","retry","captions"].includes(action))await c.query("UPDATE draft_posts SET status='draft',updated_at=now() WHERE id=$1",[row.id]);
    const draft=(await c.query("SELECT * FROM draft_posts WHERE id=$1",[row.id])).rows[0];
    return NextResponse.json({...await response.json(),draft},{status:response.status});
  });
}
export async function regenerateDraft(draftId: number) {
  // Legacy/manual complete drafts may not have a job yet. Attach one to the
  // current period without allocating another draft or resetting any quota.
  const row=(await query("SELECT d.business_id,b.timezone,b.weekly_target FROM draft_posts d JOIN businesses b ON b.id=d.business_id WHERE d.id=$1",[draftId])).rows[0];
  if(!row)return false;
  if(!(await query("SELECT 1 FROM generation_jobs WHERE draft_id=$1",[draftId])).rowCount){
    const week=generationWeek(new Date(),row.timezone);
    await query(`INSERT INTO generation_periods(business_id,period_start,timezone,target,allocated,completed)
      SELECT $1,$2,$3,$4,count(*),count(*) FILTER(WHERE caption_text<>'' AND image_path IS NOT NULL)
      FROM draft_posts WHERE business_id=$1 AND duplicate_of IS NULL
      AND (created_at AT TIME ZONE $3)::date >= $2::date AND (created_at AT TIME ZONE $3)::date < $2::date+7
      ON CONFLICT DO NOTHING`,[row.business_id,week,row.timezone,row.weekly_target]);
    await query("INSERT INTO generation_jobs(business_id,period_start,draft_id,state) VALUES($1,$2,$3,'complete') ON CONFLICT(draft_id) DO NOTHING",[row.business_id,week,draftId]);
  }
  const result=await query("UPDATE generation_jobs SET state='pending',attempts=0,manual_retries=manual_retries+1,next_at=now(),lease=NULL,error_code=NULL WHERE draft_id=$1 AND state IN ('complete','failed') AND manual_retries<2 RETURNING id",[draftId]);
  if(!result.rowCount)return false;
  await query("UPDATE draft_posts SET caption_text='',image_path=NULL,status='draft',updated_at=now() WHERE id=$1",[draftId]);
  return true;
}
