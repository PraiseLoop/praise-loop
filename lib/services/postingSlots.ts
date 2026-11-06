import { validTimezone } from "../timezone";
export { validTimezone } from "../timezone";
import { transaction } from "../db";
import { availableImage } from "./draftLifecycle";
import { META_CREATE_TASKS, metaCaptionProblem } from "../integrations/metaPublishing";
import { postingMode, selectPostingProvider, type PostingMode, type PostingProvider } from "./postingGate";
import { entitlementsFor } from "./entitlements";
export type PostingSlot={weekday:number;time:string};
export const defaultPostingSlots:PostingSlot[]=[2,4,6].map(weekday=>({weekday,time:"10:00"}));
export function validateSlots(value:unknown):PostingSlot[]{
  if(!Array.isArray(value)||!value.length||value.length>7||value.some(s=>!s||!Number.isInteger(s.weekday)||s.weekday<0||s.weekday>6||!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time))||new Set(value.map(s=>s.weekday)).size!==value.length)throw new Error("Choose 1–7 unique weekdays and valid HH:mm times");
  return value.map(s=>({weekday:s.weekday,time:s.time}));
}
function formatter(zone:string){return new Intl.DateTimeFormat("en-CA",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"});}
function localEpoch(date:Date,fmt:Intl.DateTimeFormat){const p=fmt.formatToParts(date);const v=(k:string)=>Number(p.find(x=>x.type===k)!.value);return Date.UTC(v("year"),v("month")-1,v("day"),v("hour"),v("minute"));}
export function localSlotInstant(day:string,time:string,zone:string){
  const fmt=formatter(zone),target=Date.parse(`${day}T${time}:00Z`);
  const offsets=new Set([-36,-24,-12,0,12,24,36].map(h=>{const t=target+h*3600000;return localEpoch(new Date(t),fmt)-t;}));
  // Nonexistent local minutes move to the next valid minute; repeated minutes use earliest UTC.
  for(let forward=0;forward<=1440;forward++){
    const wanted=target+forward*60000;
    const matches=[...offsets].map(offset=>wanted-offset).filter(t=>localEpoch(new Date(t),fmt)===wanted);
    if(matches.length)return new Date(Math.min(...matches)).toISOString();
  }
  throw new Error("No supported local slot in this timezone");
}
export function proposeSlots(zone:string,settings:PostingSlot[],now=new Date(),count=5,occupied:string[]=[]){
  validateSlots(settings);if(!validTimezone(zone)||!Number.isInteger(count)||count<1||count>15)throw new Error("Invalid timezone or slot count");
  const local=new Date(localEpoch(now,formatter(zone)));local.setUTCHours(0,0,0,0);const results:string[]=[];
  for(let day=0;day<35&&results.length<count;day++){
    const date=new Date(local.getTime()+day*86400000),slot=settings.find(s=>s.weekday===date.getUTCDay());if(!slot)continue;
    const instant=localSlotInstant(date.toISOString().slice(0,10),slot.time,zone);
    if(Date.parse(instant)>now.getTime()&&!occupied.includes(instant)&&!results.includes(instant))results.push(instant);
  }
  return results;
}
/**
 * Reserve a slot for an approved draft. This only records the owner's decision in PraiseLoop
 * (the claim is `queued` and the draft becomes `scheduled`); nothing is sent to a provider here.
 * The worker submits the post when the time comes (lib/services/bufferPosting.ts), using the
 * provider chosen here: Meta when the business has a Meta target, otherwise Buffer.
 */
export async function assignSlots(owner:string,businessId:number,items:{draftPostId:number;version:number;instant:string}[],mode:PostingMode=postingMode()):Promise<{draftPostId:number;status:number;error?:string;instant?:string}[]>{
  const results:{draftPostId:number;status:number;error?:string;instant?:string}[]=[];
  for(const item of items){
    results.push(await transaction(async c=>{
      const fail=(error:string,status=409)=>({draftPostId:item.draftPostId,status,error});
      if(mode==="off")return fail("Automatic posting is not switched on yet",503);
      if(!(await entitlementsFor(owner)).limits.automaticPosting)return fail("Automatic posting is included in Pro and Business plans",403);
      const b=(await c.query("SELECT * FROM businesses WHERE id=$1 AND owner_id=$2 FOR UPDATE",[businessId,owner])).rows[0];if(!b)return fail("Business not found",404);
      const d=(await c.query("SELECT * FROM draft_posts WHERE id=$1 AND business_id=$2 FOR UPDATE",[item.draftPostId,businessId])).rows[0];if(!d)return fail("Draft not found",404);
      if(d.version!==item.version||d.status!=="approved"||!d.caption_text.trim()||!await availableImage(d.image_path))return fail("Only current complete approved drafts can be assigned");
      const meta=(await c.query("SELECT t.target,p.status AS page_status,p.instagram_business_account_id,p.tasks,c.status AS connection_status FROM business_meta_targets t JOIN meta_pages p ON p.id=t.meta_page_id JOIN meta_connections c ON c.id=p.connection_id WHERE t.business_id=$1",[businessId])).rows[0];
      const channel=(await c.query("SELECT ch.service,ch.channel_type,bc.status FROM business_buffer_channels ch JOIN buffer_connections bc ON bc.id=ch.connection_id WHERE ch.business_id=$1 AND bc.owner_id=$2",[businessId,owner])).rows[0];
      const provider:PostingProvider|null=selectPostingProvider({metaTarget:!!meta,bufferChannel:!!channel});
      if(!provider)return fail("Choose Instagram, Facebook or Buffer for this business first");
      let target:"instagram"|"facebook"|null=null;
      if(provider==="meta"){
        if(!meta)return fail("Connect Instagram or Facebook for this business first");
        target=meta.target;
        if(!target)return fail("Connect Instagram or Facebook for this business first");
        if(meta.page_status!=="active"||meta.connection_status!=="active")return fail("Reconnect Instagram or Facebook before scheduling");
        if(!(meta.tasks??[]).some((task:string)=>META_CREATE_TASKS.has(task)))return fail("The Facebook Page does not allow this app to publish");
        if(target==="instagram"&&!meta.instagram_business_account_id)return fail("The Facebook Page has no linked Instagram account");
        const captionProblem=metaCaptionProblem(target,d.caption_text);
        if(captionProblem)return fail(captionProblem==="too_many_hashtags"?"Instagram accepts at most 30 hashtags in a caption":"The caption is too long for this provider");
      }else{
        if(!channel)return fail("Connect Buffer and choose a channel for this business first");
        if(channel.status!=="active")return fail("Reconnect Buffer before scheduling");
        if(channel.service==="instagram"&&channel.channel_type!=="business")return fail("Buffer can only post automatically to an Instagram account it reports as a Business account");
      }
      const instant=new Date(item.instant);if(!Number.isFinite(instant.getTime())||instant.getTime()<=Date.now())return fail("Choose a future UTC slot",400);
      const occupied=(await c.query("SELECT instant::text FROM posting_slot_claims WHERE business_id=$1 AND draft_id<>$2 UNION SELECT scheduled_for::text FROM draft_posts WHERE business_id=$1 AND scheduled_for IS NOT NULL AND status IN ('scheduled','published') AND id<>$2",[businessId,item.draftPostId])).rows.map(r=>new Date(r.instant).toISOString());
      if(!proposeSlots(b.timezone,b.posting_slots,new Date(),15,occupied).includes(instant.toISOString()))return fail("Slot is occupied or no longer in the proposed schedule");
      // A failed, missed or drafted earlier attempt stays as history until the owner schedules the post again.
      await c.query("DELETE FROM posting_slot_claims WHERE draft_id=$1 AND state IN ('error','missed','drafted')",[item.draftPostId]);
      // The provider is fixed now, so adding or removing a target later cannot
      // silently reroute a post the owner already confirmed.
      const claim=await c.query("INSERT INTO posting_slot_claims(business_id,instant,draft_id,state,provider,provider_target) VALUES($1,$2,$3,'queued',$4,$5) ON CONFLICT DO NOTHING RETURNING draft_id",[businessId,instant,item.draftPostId,provider,target]);
      if(!claim.rowCount)return fail("Slot or draft already claimed");
      await c.query("SELECT set_config('app.actor_id',$1,true),set_config('app.action','assign_slot',true),set_config('app.reason','owner_scheduled',true)",[owner]);
      const updated=await c.query("UPDATE draft_posts SET status='scheduled',scheduled_for=$2,updated_at=now() WHERE id=$1 AND version=$3 AND status='approved'",[item.draftPostId,instant,item.version]);
      if(!updated.rowCount)throw new Error("Draft changed");
      return {draftPostId:item.draftPostId,status:200,instant:instant.toISOString()};
    }));
  }
  return results;
}
/**
 * Take a post back before it is sent. Only a still-queued post can be cancelled here: once it has
 * been handed to Buffer it must be dealt with in Buffer, because we cannot prove it is not live.
 */
export async function cancelScheduled(owner:string,draftPostId:number){
  return transaction(async c=>{
    const d=(await c.query("SELECT d.id,d.status FROM draft_posts d JOIN businesses b ON b.id=d.business_id WHERE d.id=$1 AND b.owner_id=$2 FOR UPDATE OF d",[draftPostId,owner])).rows[0];
    if(!d)return {status:404,error:"Draft not found"};
    const claim=(await c.query("SELECT state FROM posting_slot_claims WHERE draft_id=$1 FOR UPDATE",[draftPostId])).rows[0];
    if(!claim||d.status!=="scheduled")return {status:409,error:"This post is not scheduled"};
    if(claim.state!=="queued")return {status:409,error:"This post has already been handed to the posting provider; manage it there"};
    await c.query("SELECT set_config('app.actor_id',$1,true),set_config('app.action','cancel_slot',true),set_config('app.reason','owner_cancelled',true)",[owner]);
    await c.query("DELETE FROM posting_slot_claims WHERE draft_id=$1",[draftPostId]);
    await c.query("UPDATE draft_posts SET status='approved',scheduled_for=NULL,updated_at=now() WHERE id=$1",[draftPostId]);
    return {status:200};
  });
}
/**
 * The owner's way out of an `unknown` post (we could not prove whether Buffer published it). They check
 * Buffer or Instagram and tell us. Either answer ends the claim and revokes the image link; neither
 * answer is a verified publication, so "posted" is recorded like a share-sheet share: owner-reported.
 */
export async function resolveUnknown(owner:string,draftPostId:number,outcome:"posted"|"not_posted"){
  return transaction(async c=>{
    const d=(await c.query("SELECT d.id,d.status FROM draft_posts d JOIN businesses b ON b.id=d.business_id WHERE d.id=$1 AND b.owner_id=$2 FOR UPDATE OF d",[draftPostId,owner])).rows[0];
    if(!d)return {status:404,error:"Draft not found"};
    const claim=(await c.query("SELECT state FROM posting_slot_claims WHERE draft_id=$1 FOR UPDATE",[draftPostId])).rows[0];
    if(!claim||claim.state!=="unknown"||d.status!=="scheduled")return {status:409,error:"This post does not need checking"};
    await c.query("SELECT set_config('app.actor_id',$1,true),set_config('app.action','resolve_unknown',true),set_config('app.reason',$2,true)",[owner,outcome==="posted"?"owner_reported_posted":"owner_reported_not_posted"]);
    // Revoke the link either way: the owner has looked, so Buffer no longer needs the image.
    await c.query("UPDATE posting_slot_claims SET state=$2,error_code=$3,image_token_hash=NULL,updated_at=now() WHERE draft_id=$1",[draftPostId,outcome==="posted"?"sent":"error",outcome==="posted"?"owner_reported":"owner_reported_not_posted"]);
    if(outcome==="posted")await c.query("UPDATE draft_posts SET status='shared',shared_at=now(),updated_at=now() WHERE id=$1",[draftPostId]);
    else await c.query("UPDATE draft_posts SET status='failed',updated_at=now() WHERE id=$1",[draftPostId]);
    return {status:200};
  });
}
