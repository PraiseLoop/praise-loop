import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { NextRequest } from "next/server";
import { sessionHash } from "../lib/auth-adapter";
import { databaseFixture } from "./db-fixture";
import { proposeSlots,defaultPostingSlots,localSlotInstant,validateSlots,assignSlots,cancelScheduled,resolveUnknown } from "../lib/services/postingSlots";
async function main(){
  assert.equal(localSlotInstant("2026-03-08","02:30","America/New_York"),"2026-03-08T07:00:00.000Z");
  assert.equal(localSlotInstant("2026-11-01","01:30","America/New_York"),"2026-11-01T05:30:00.000Z");
  assert.equal(localSlotInstant("2026-10-04","02:15","Australia/Lord_Howe"),"2026-10-03T15:30:00.000Z");
  const fixed=new Date("2026-10-18T23:00:00Z");
  const slots=proposeSlots("Pacific/Auckland",defaultPostingSlots,fixed,3);
  assert.equal(slots[0],"2026-10-19T21:00:00.000Z");
  assert.ok(!proposeSlots("Pacific/Auckland",defaultPostingSlots,fixed,3,[slots[0]]).includes(slots[0]));
  assert.equal(proposeSlots("UTC",[{weekday:0,time:"10:00"}],new Date("2026-10-18T11:00:00Z"),15).length,4);
  assert.throws(()=>validateSlots([{weekday:2,time:"25:00"}]));assert.throws(()=>validateSlots([{weekday:2,time:"10:00"},{weekday:2,time:"11:00"}]));
  assert.throws(()=>proposeSlots("invalid-zone",defaultPostingSlots,fixed));
  const root=mkdtempSync(join(tmpdir(),"slots-"));process.env.MEDIA_ROOT=root;process.env.NEXTAUTH_URL="https://app.example.invalid";
  writeFileSync(join(root,"fixture.png"),await sharp({create:{width:1080,height:1080,channels:3,background:"#123456"}}).png().toBuffer());
  // Reserving a slot is a local decision. Nothing in this suite may reach the network.
  const realFetch=globalThis.fetch;let networkCalls=0;globalThis.fetch=(async()=>{networkCalls++;throw new Error("no network in the slot tests");}) as typeof fetch;
  try{await databaseFixture(async c=>{
    await c.query("INSERT INTO auth_users(id,email) VALUES('slot-owner','slots@example.invalid'),('foreign-owner','foreign@example.invalid')");
    await c.query("INSERT INTO owner_plans(owner_id,plan,source) VALUES('slot-owner','pro','manual'),('foreign-owner','pro','manual')");
    await c.query("INSERT INTO auth_sessions VALUES($1,'slot-owner',now()+interval '1 hour')",[sessionHash("slot-session")]);
    const bid=(await c.query("INSERT INTO businesses(name,timezone,owner_id) VALUES('Synthetic slots','UTC','slot-owner') RETURNING id")).rows[0].id;
    const connection=Number((await c.query("INSERT INTO buffer_connections(owner_id,organization_id,encrypted_access_token,encrypted_refresh_token,access_expires_at,scope) VALUES('slot-owner','org','a','r',now()+interval '1 hour','s') RETURNING id")).rows[0].id);
    const channel=(service:string,type:string)=>c.query("INSERT INTO business_buffer_channels(business_id,connection_id,channel_id,channel_name,service,channel_type) VALUES($1,$2,'ch1','Synthetic channel',$3,$4) ON CONFLICT(business_id) DO UPDATE SET service=EXCLUDED.service,channel_type=EXCLUDED.channel_type",[bid,connection,service,type]);
    const draft=async(status="approved")=>Number((await c.query("INSERT INTO draft_posts(business_id,quote_text,caption_text,image_path,status) VALUES($1,'Synthetic','Synthetic','/api/media/fixture.png',$2) RETURNING id",[bid,status])).rows[0].id);
    const a=await draft(),b=await draft(),bad=await draft("failed"),future=proposeSlots("UTC",defaultPostingSlots,new Date(),5);
    const claims=async()=>Number((await c.query("SELECT count(*) FROM posting_slot_claims")).rows[0].count);
    const assign=async(owner:string,id:number,instant:string,mode:"off"|"draft"|"live"="draft")=>assignSlots(owner,bid,[{draftPostId:id,version:Number((await c.query("SELECT version FROM draft_posts WHERE id=$1",[id])).rows[0].version),instant}],mode);
    // The gate defaults to off: no claim, no change, a clear 503.
    assert.equal((await assign("slot-owner",a,future[0],"off"))[0].status,503);
    assert.equal(await claims(),0);
    assert.equal((await c.query("SELECT status FROM draft_posts WHERE id=$1",[a])).rows[0].status,"approved");
    // Automatic posting is paid: Free and expired plans cannot confirm a slot, and nothing is written.
    await c.query("UPDATE owner_plans SET plan='free',expires_at=NULL WHERE owner_id='slot-owner'");
    const freeAttempt=await assign("slot-owner",a,future[0]);
    assert.equal(freeAttempt[0].status,403);
    assert.match(String(freeAttempt[0].error),/Pro and Business/);
    assert.equal(await claims(),0);
    await c.query("UPDATE owner_plans SET plan='pro',expires_at=now()-interval '1 day' WHERE owner_id='slot-owner'");
    assert.equal((await assign("slot-owner",a,future[0]))[0].status,403,"an expired plan is refused");
    assert.equal(await claims(),0);
    await c.query("UPDATE owner_plans SET plan='pro',expires_at=NULL WHERE owner_id='slot-owner'");
    // A channel is needed first, and it must be able to post by itself.
    assert.equal((await assign("slot-owner",a,future[0]))[0].status,409);
    await channel("instagram","personal");
    assert.match(String((await assign("slot-owner",a,future[0]))[0].error),/reports as a Business account/);
    await channel("instagram","");
    assert.equal((await assign("slot-owner",a,future[0]))[0].status,409,"a channel saved before types were recorded is refused until chosen again");
    await c.query("UPDATE buffer_connections SET status='needs_reconnect' WHERE id=$1",[connection]);
    await channel("instagram","business");
    assert.match(String((await assign("slot-owner",a,future[0]))[0].error),/Reconnect Buffer/);
    await c.query("UPDATE buffer_connections SET status='active' WHERE id=$1",[connection]);
    assert.equal(await claims(),0);
    // Ownership and state checks.
    assert.equal((await assign("foreign-owner",bad,future[1]))[0].status,404);
    assert.equal((await assign("slot-owner",bad,future[1]))[0].status,409);
    assert.equal((await assign("slot-owner",a,new Date(Date.now()-1000).toISOString()))[0].status,400);
    assert.equal((await assign("slot-owner",a,"2000-01-01T00:00:00.000Z"))[0].status,400);
    assert.equal((await assign("slot-owner",a,new Date(Date.parse(future[0])+60000).toISOString()))[0].status,409,"only proposed slots can be claimed");
    // Two owners' drafts racing for one slot: exactly one wins.
    const raced=await Promise.all([assign("slot-owner",a,future[0]),assign("slot-owner",b,future[0])]);
    assert.deepEqual(raced.map(r=>r[0].status).sort(),[200,409]);
    assert.equal(await claims(),1);
    const won=raced.find(r=>r[0].status===200)![0].draftPostId,lost=won===a?b:a;
    // Reserving only records the decision: queued, nothing sent, no image link, draft scheduled.
    const claim=(await c.query("SELECT state,external_id,image_token_hash,submitted_at FROM posting_slot_claims WHERE draft_id=$1",[won])).rows[0];
    assert.deepEqual([claim.state,claim.external_id,claim.image_token_hash,claim.submitted_at],["queued",null,null,null]);
    assert.equal((await c.query("SELECT status FROM draft_posts WHERE id=$1",[won])).rows[0].status,"scheduled");
    assert.equal((await c.query("SELECT status FROM draft_posts WHERE id=$1",[lost])).rows[0].status,"approved");
    assert.equal((await assign("slot-owner",won,future[1]))[0].status,409,"a scheduled draft cannot be assigned twice");
    // Cancel: another owner cannot, a queued post can, and it returns to approved with its slot free.
    assert.equal((await cancelScheduled("foreign-owner",won)).status,404);
    assert.equal((await cancelScheduled("slot-owner",lost)).status,409,"an unscheduled draft is not cancellable");
    assert.equal((await cancelScheduled("slot-owner",won)).status,200);
    assert.equal(await claims(),0);
    assert.deepEqual((await c.query("SELECT status,scheduled_for FROM draft_posts WHERE id=$1",[won])).rows[0],{status:"approved",scheduled_for:null});
    assert.equal((await assign("slot-owner",won,future[0]))[0].status,200,"the freed slot can be used again");
    // Once handed to Buffer a post cannot be cancelled here: we cannot prove it is not live.
    for(const state of ["submitting","submitted","unknown"]){
      await c.query("UPDATE posting_slot_claims SET state=$2 WHERE draft_id=$1",[won,state]);
      assert.equal((await cancelScheduled("slot-owner",won)).status,409,state);
      assert.equal(await claims(),1,`${state} stays`);
    }
    // A failed attempt is history that scheduling again replaces.
    await c.query("UPDATE posting_slot_claims SET state='error',error_code='rejected' WHERE draft_id=$1",[won]);
    await c.query("UPDATE draft_posts SET status='approved' WHERE id=$1",[won]);
    assert.equal((await assign("slot-owner",won,future[1]))[0].status,200);
    assert.deepEqual((await c.query("SELECT state,error_code FROM posting_slot_claims WHERE draft_id=$1",[won])).rows,[{state:"queued",error_code:null}]);
    assert.equal(networkCalls,0,"reserving and cancelling never touch the network");
    // An unknown post: only its owner can resolve it, only while it is unknown, and either answer revokes the link.
    for(const [outcome,slotIndex,draftStatus,claimState] of [["posted",2,"shared","sent"],["not_posted",3,"failed","error"]] as const){
      const u=await draft();
      assert.equal((await assign("slot-owner",u,future[slotIndex]))[0].status,200);
      assert.equal((await resolveUnknown("slot-owner",u,outcome)).status,409,"a queued post does not need checking");
      await c.query("UPDATE posting_slot_claims SET state='unknown',error_code='ambiguous',image_token_hash='abc',image_expires_at=now()+interval '1 day' WHERE draft_id=$1",[u]);
      assert.equal((await resolveUnknown("foreign-owner",u,outcome)).status,404);
      assert.equal((await resolveUnknown("slot-owner",u,outcome)).status,200);
      const after=(await c.query("SELECT c.state,c.image_token_hash,d.status FROM posting_slot_claims c JOIN draft_posts d ON d.id=c.draft_id WHERE c.draft_id=$1",[u])).rows[0];
      assert.deepEqual([after.state,after.image_token_hash,after.status],[claimState,null,draftStatus]);
      assert.equal((await resolveUnknown("slot-owner",u,outcome)).status,409,"resolving twice does nothing");
    }
    // Through the real route guard: a route the guard does not know answers 403 and would never work in the app.
    await c.query("INSERT INTO auth_sessions VALUES($1,'foreign-owner',now()+interval '1 hour')",[sessionHash("foreign-session")]);
    const viaRoute=(path:string,session:string,body:unknown)=>require(`../app/api/posting-slots/${path}/route`).POST(new NextRequest(`https://app.example.invalid/api/posting-slots/${path}`,{method:"POST",headers:{origin:"https://app.example.invalid",cookie:`next-auth.session-token=${session}`,"content-type":"application/json"},body:JSON.stringify(body)}));
    const routed=await draft();
    assert.equal((await assign("slot-owner",routed,future[4]))[0].status,200);
    assert.equal((await viaRoute("cancel","foreign-session",{draftPostId:routed})).status,404,"another owner's draft is not found");
    assert.equal((await viaRoute("cancel","slot-session",{draftPostId:"x"})).status,400);
    assert.equal((await viaRoute("cancel","slot-session",{draftPostId:routed})).status,200,"the owner can cancel through the real guard");
    assert.equal((await c.query("SELECT status FROM draft_posts WHERE id=$1",[routed])).rows[0].status,"approved");
    assert.equal((await viaRoute("resolve","slot-session",{draftPostId:routed,outcome:"posted"})).status,409,"a post that is not unknown does not need checking");
    assert.equal((await viaRoute("resolve","foreign-session",{draftPostId:routed,outcome:"posted"})).status,404);
    assert.equal((await viaRoute("resolve","slot-session",{draftPostId:routed,outcome:"maybe"})).status,400);
    const listed=await (await require("../app/api/drafts/route").GET(new NextRequest(`http://localhost/api/drafts?businessId=${bid}`,{headers:{cookie:"next-auth.session-token=slot-session"}}))).json();
    assert.ok(listed.drafts.every((x:Record<string,unknown>)=>"posting_mode" in x&&"posting_link" in x&&!("image_token_hash" in x)),"the list shows posting details and never the token hash");
    const confirmed=(await c.query("SELECT scheduled_for FROM draft_posts WHERE status='scheduled'")).rows[0].scheduled_for;
    await c.query("UPDATE businesses SET timezone='America/New_York' WHERE id=$1",[bid]);
    assert.equal((await c.query("SELECT scheduled_for FROM draft_posts WHERE status='scheduled'")).rows[0].scheduled_for.toISOString(),confirmed.toISOString());
  });}finally{globalThis.fetch=realFetch;rmSync(root,{recursive:true,force:true});}
  console.log("posting slots DST/rollover/ownership/concurrency/cancel/gate tests passed (no network)");
}
main().catch(err=>{console.error(err);process.exitCode=1;});
