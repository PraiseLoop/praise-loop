import { validTimezone } from "../lib/timezone";
import { NextRequest } from "next/server";
import { sessionHash } from "../lib/auth-adapter";
import assert from "node:assert/strict";
import { databaseFixture } from "./db-fixture";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardOrphanRender, generationWeek, requestGeneration, processGeneration, retryGeneration, type GenerationDeps } from "../lib/services/generation";
async function main() {
  assert.equal(generationWeek(new Date("2026-10-19T03:59:00Z"),"America/New_York"),"2026-10-12");
  assert.equal(generationWeek(new Date("2026-10-19T04:00:00Z"),"America/New_York"),"2026-10-19");
  assert.equal(generationWeek(new Date("2026-10-18T12:00:00Z"),"Pacific/Auckland"),"2026-10-19");
  assert.equal(validTimezone("America/New_York"),true);
  assert.equal(validTimezone("Mars/Typo"),false);
  await databaseFixture(async client=>{
    await client.query("INSERT INTO auth_users(id,email) VALUES('generation-owner','generation@example.invalid')");
    // Business allows both fixture businesses to generate; this suite is not about the business limit.
    await client.query("INSERT INTO owner_plans(owner_id,plan,source) VALUES('generation-owner','business','manual')");
    const bid = (await client.query("INSERT INTO businesses(name,timezone,owner_id) VALUES('Synthetic generation','America/New_York','generation-owner') RETURNING id")).rows[0].id;
    await client.query("INSERT INTO reviews(business_id,source,source_review_id,rating,text,reviewed_at) SELECT $1,'manual',n::text,5,'A wonderful synthetic experience with friendly staff '||n, '2020-07-01' FROM generate_series(1,20) n",[bid]);
    // Simulated weeks stay in the past: draft_posts.created_at uses the real DB clock and periods count
    // drafts created in them against quota, so a simulated week matching the real one double-counts.
    let now = new Date("2020-07-12T12:00:00Z"), captions=0, renders=0, failCaption=true, failRender=true;
    const deps: GenerationDeps = {clock:()=>now,captions:async()=>{captions++;if(failCaption)throw new Error("private prompt must never persist");return {friendly:"Synthetic caption",premium:"Synthetic premium",playful:"Synthetic playful"};},render:async()=>{renders++;if(failRender)throw new Error("private render data");return {publicPath:"/api/media/synthetic.png",fileSystemPath:"/tmp/synthetic.png"};}};
    const requests = await Promise.all([requestGeneration(bid,5,now),requestGeneration(bid,5,now)]);
    assert.equal(requests.reduce((n,r)=>n+r.inserted,0),3);
    assert.equal((await requestGeneration(bid,5,now)).reason,"quota_met");
    const jobs = (await client.query("SELECT * FROM generation_jobs ORDER BY id")).rows;
    const first = Number(jobs[0].id);
    const claims = await Promise.all([processGeneration(first,deps),processGeneration(first,deps)]);
    assert.equal(claims.filter(Boolean).length,0); assert.equal(captions,1,"two workers only one paid call");
    assert.equal((await client.query("SELECT error_code FROM generation_jobs WHERE id=$1",[first])).rows[0].error_code,"generation_failed");
    now = new Date(now.getTime()+31000); failCaption=false;
    await processGeneration(first,deps); assert.equal(captions,2); assert.equal(renders,1);
    now = new Date(now.getTime()+61000); failRender=false;
    assert.equal(await processGeneration(first,deps),true); assert.equal(captions,2,"persisted caption is not generated again after restart");
    assert.equal(renders,2); assert.equal(await processGeneration(first,deps),false);
    assert.equal((await client.query("SELECT status FROM draft_posts WHERE id=$1",[jobs[0].draft_id])).rows[0].status,"draft","human approval still required");
    // A render finished after its draft was deleted (account deletion) is removed; one whose draft exists is kept.
    const renderDir = mkdtempSync(join(tmpdir(),"orphan-render-")), orphan = join(renderDir,"orphan.png"), kept = join(renderDir,"kept.png");
    writeFileSync(orphan,"x"); writeFileSync(kept,"x");
    assert.equal(await discardOrphanRender(2147483000,orphan),true); assert.equal(existsSync(orphan),false);
    assert.equal(await discardOrphanRender(Number(jobs[0].draft_id),kept),false); assert.equal(existsSync(kept),true);
    // A file another row still points at is kept even though this draft is gone.
    const shared = join(renderDir,"shared.png"); writeFileSync(shared,"x");
    await client.query("UPDATE draft_posts SET image_path=$2 WHERE id=$1",[jobs[0].draft_id,"/api/media/shared.png"]);
    assert.equal(await discardOrphanRender(2147483000,shared,"/api/media/shared.png"),false); assert.equal(existsSync(shared),true);
    rmSync(renderDir,{recursive:true,force:true});
    const second = Number(jobs[1].id);
    await client.query("UPDATE generation_jobs SET state='running',attempts=1,lease='dead-process',lease_until=$2 WHERE id=$1",[second,new Date(now.getTime()-1000)]);
    await client.query("UPDATE draft_posts SET caption_text='Persisted before crash' WHERE id=$1",[jobs[1].draft_id]);
    assert.equal(await processGeneration(second,deps),true); assert.equal(captions,2);
    const third = Number(jobs[2].id); failCaption=true;
    for (let i=0;i<3;i++){await processGeneration(third,deps);now=new Date(now.getTime()+121000);}
    assert.equal((await client.query("SELECT state FROM generation_jobs WHERE id=$1",[third])).rows[0].state,"failed");
    const before=captions;assert.equal(await processGeneration(third,deps),false);assert.equal(captions,before);
    assert.equal(await retryGeneration(Number(jobs[2].draft_id)),true);
    assert.equal(await retryGeneration(Number(jobs[2].draft_id)),false,"cannot reset active work");
    await client.query("UPDATE generation_jobs SET state='failed' WHERE id=$1",[third]);
    await client.query("UPDATE draft_posts SET status='failed' WHERE id=$1",[jobs[2].draft_id]);
    assert.equal(await retryGeneration(Number(jobs[2].draft_id)),true);
    await client.query("UPDATE generation_jobs SET state='failed' WHERE id=$1",[third]);
    await client.query("UPDATE draft_posts SET status='failed' WHERE id=$1",[jobs[2].draft_id]);
    assert.equal(await retryGeneration(Number(jobs[2].draft_id)),false,"manual retries are bounded");
    now=new Date("2020-07-13T04:00:00Z");
    assert.equal((await requestGeneration(bid,5,now)).inserted,3,"new business-local week rolls quota");
    assert.equal((await requestGeneration(bid,5,now)).inserted,0);
    assert.equal((await client.query("SELECT count(*) n FROM draft_posts WHERE business_id=$1",[bid])).rows[0].n,"6");
    const following = new Date("2020-07-20T04:00:00Z");
    assert.equal((await requestGeneration(bid,5,following)).inserted,2);
    assert.equal((await requestGeneration(bid,5,following)).reason,"backlog_full");
    await assert.rejects(client.query("UPDATE businesses SET weekly_target=6 WHERE id=$1",[bid]));
    const empty = (await client.query("INSERT INTO businesses(name,timezone,owner_id) VALUES('Empty synthetic','UTC','generation-owner') RETURNING id")).rows[0].id;
    assert.equal((await requestGeneration(empty,3,now)).reason,"reviews_exhausted");
    await client.query("UPDATE businesses SET timezone='Mars/Typo' WHERE id=$1",[empty]);
    assert.equal((await requestGeneration(empty,3,now)).reason,"invalid_timezone");
    process.env.NEXTAUTH_URL="http://localhost";
    await client.query("INSERT INTO auth_sessions VALUES($1,'generation-owner',now()+interval '1 hour')",[sessionHash("generation-zone")]);
    const req=(path:string,method:string,body:unknown)=>new NextRequest(`http://localhost/api/${path}`,{method,headers:{origin:"http://localhost",cookie:"next-auth.session-token=generation-zone","content-type":"application/json"},body:JSON.stringify(body)});
    assert.equal((await require("../app/api/businesses/route").POST(req("businesses","POST",{name:"Invalid zone",timezone:"Mars/Typo"}))).status,400);
    const patch=require("../app/api/businesses/[id]/route").PATCH;
    assert.equal((await patch(req(`businesses/${empty}`,"PATCH",{timezone:"Mars/Typo"}),{params:Promise.resolve({id:empty})})).status,400);
    assert.equal((await patch(req(`businesses/${empty}`,"PATCH",{timezone:"UTC"}),{params:Promise.resolve({id:empty})})).status,200);
    assert.equal((await requestGeneration(empty,3,now)).reason,"reviews_exhausted");
    assert.equal(captions,before,"empty and repeated ticks do not call a paid provider");
    assert.equal((await client.query("SELECT completed FROM generation_periods WHERE business_id=$1 ORDER BY period_start LIMIT 1",[bid])).rows[0].completed,2);
    const preserved = (await client.query("SELECT id,duplicate_of FROM draft_posts WHERE business_id<>$1 ORDER BY id",[bid])).rows;
    assert.equal(preserved.filter(r=>r.duplicate_of!==null).length,1);
  }, async (name, client)=>{
    if(name!=="008_generation_jobs.sql")return;
    const b=(await client.query("INSERT INTO businesses(name,timezone) VALUES('Historical synthetic duplicate','UTC') RETURNING id")).rows[0].id;
    const r=(await client.query("INSERT INTO reviews(business_id,source,rating,text,reviewed_at) VALUES($1,'manual',5,'Historical synthetic review',now()) RETURNING id",[b])).rows[0].id;
    await client.query("INSERT INTO draft_posts(business_id,review_id,quote_text,caption_text) VALUES($1,$2,'Synthetic',''),($1,$2,'Synthetic','')",[b,r]);
  });
  console.log("weekly quota/concurrent claim/stage recovery/restart/backoff/retry tests passed");
}
main().catch(err=>{console.error(err);process.exitCode=1;});
