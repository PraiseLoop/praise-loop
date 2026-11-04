import assert from "node:assert/strict";
import { mkdtempSync,rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { databaseFixture } from "./db-fixture";
import { webFixture } from "./web-fixture";
import { sessionHash } from "../lib/auth-adapter";
import { processGeneration,type GenerationDeps } from "../lib/services/generation";
import { renderDraftImage } from "../lib/services/imageRenderer";
async function main(){
  if(process.env.TEST_BROWSER!=="1"){console.log("Onboarding browser skipped: build and set TEST_BROWSER/TEST_DATABASE_URL");return;}
  const root=mkdtempSync(join(tmpdir(),"onboarding-browser-"));process.env.MEDIA_ROOT=root;
  try{await databaseFixture(async c=>{
    await c.query("INSERT INTO auth_users(id,email) VALUES('onboarding-browser','onboarding-browser@example.invalid')");
    await c.query("INSERT INTO owner_plans(owner_id,plan,source) VALUES('onboarding-browser','business','manual')");
    await c.query("INSERT INTO auth_sessions VALUES($1,'onboarding-browser',now()+interval '1 hour')",[sessionHash("onboarding-browser-session")]);
    let clock=new Date(),calls=0,fail=true;
    const deps:GenerationDeps={clock:()=>clock,render:renderDraftImage,captions:async()=>{calls++;if(fail){fail=false;throw new Error("synthetic-provider-outage");}return {friendly:"Synthetic welcoming service, ready for your review.",premium:"Synthetic premium service.",playful:"Synthetic cheerful service."};}};
    await webFixture(async base=>{
      const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH==="playwright"?undefined:process.env.CHROMIUM_PATH??"/usr/bin/chromium",args:["--no-sandbox"]});
      try{
        const context=await browser.newContext();await context.addCookies([{name:"next-auth.session-token",value:"onboarding-browser-session",url:base}]);
        const page=await context.newPage(),started=Date.now();const pageErrors:string[]=[];page.on("pageerror",e=>pageErrors.push(e.message));
        await page.goto(`${base}/onboarding`);await page.getByLabel("Business name",{exact:true}).fill("Synthetic onboarding café");await page.getByLabel("Time zone").selectOption("Pacific/Auckland");
        const creation=page.waitForResponse(r=>r.url().endsWith("/api/businesses")&&r.request().method()==="POST");await page.getByRole("button",{name:"Continue",exact:true}).click();
        const response=await creation;assert.equal(response.status(),201);const created=await response.json(),bid=created.business.id,body=response.request().postDataJSON();
        const repeated=await Promise.all([context.request.post(`${base}/api/businesses`,{data:body,headers:{origin:base}}),context.request.post(`${base}/api/businesses`,{data:body,headers:{origin:base}})]);
        for(const r of repeated)assert.equal((await r.json()).business.id,bid);
        const upload=async(csv:string)=>{await page.getByLabel("Review CSV").setInputFiles({name:"synthetic.csv",mimeType:"text/csv",buffer:Buffer.from(csv)});const r=page.waitForResponse(r=>r.url().endsWith("/api/reviews/import"));await page.getByRole("button",{name:"Import reviews",exact:true}).click();return (await r).json();};
        assert.equal((await upload("rating,text,reviewed_at\n9,Invalid synthetic,2026-02-30")).rejectedInvalid,1);await page.getByText(/1 invalid/).waitFor();
        assert.equal((await upload("rating,text,reviewed_at\n5,A wonderful synthetic experience with welcoming friendly staff,2026-10-01")).imported,1);
        const queue=page.waitForResponse(r=>r.url().endsWith("/api/quotes/select"));await page.getByRole("button",{name:"Make my first 3 posts"}).click();assert.equal((await queue).status(),202);
        await page.reload();await page.getByRole("heading",{name:"Making your first posts"}).waitFor();
        const first=(await c.query("SELECT id FROM generation_jobs ORDER BY id LIMIT 1")).rows[0].id;
        clock=new Date();await processGeneration(Number(first),deps);await page.getByText(/Needs attention/).first().waitFor();
        clock=new Date(clock.getTime()+31000);assert.equal(await processGeneration(Number(first),deps),true);
        await page.getByText(/We need a few more reviews/).waitFor();await page.getByRole("button",{name:"Add more reviews"}).click();
        assert.equal((await upload("rating,text,reviewed_at\n5,A second synthetic review praises the thoughtful welcoming staff,2026-10-02\n4,A third synthetic review praises friendly service and delicious food,2026-10-03")).imported,2);
        const more=page.waitForResponse(r=>r.url().endsWith("/api/quotes/select"));await page.getByRole("button",{name:"Make my first 3 posts"}).click();assert.equal((await more).status(),202);
        const pending=(await c.query("SELECT id FROM generation_jobs WHERE state='pending' ORDER BY id")).rows;for(const job of pending)assert.equal(await processGeneration(Number(job.id),deps),true);
        await page.getByRole("heading",{name:"Your first 3 posts are ready"}).waitFor();
        const images=page.getByRole("img",{name:/Onboarding draft/});assert.equal(await images.count(),3);for(const image of await images.all())assert.equal(await image.evaluate(e=>(e as HTMLImageElement).naturalWidth),1080);
        const seconds=Number(((Date.now()-started)/1000).toFixed(2));
        await page.getByRole("link",{name:"Review & approve"}).click();await page.getByRole("heading",{name:/need your OK/}).waitFor();await page.getByLabel(/^Caption for draft /).first().waitFor();
        assert.deepEqual(pageErrors,[]);assert.equal(calls,4,"one fixture failure plus three successful caption stages");
        assert.equal((await c.query("SELECT count(*) FROM businesses")).rows[0].count,"1");assert.equal((await c.query("SELECT count(*) FROM draft_posts")).rows[0].count,"3");
        assert.equal((await c.query("SELECT allocated FROM generation_periods WHERE business_id=$1",[bid])).rows[0].allocated,3);
        await page.setViewportSize({width:390,height:844});await page.goto(`${base}/approval`);
        await page.getByRole("combobox",{name:"Business"}).selectOption({label:"+ Add a business"});await page.waitForURL(/\/onboarding\?new=1$/);await page.getByLabel("Business name",{exact:true}).fill("Second synthetic café");
        const second=page.waitForResponse(r=>r.url().endsWith("/api/businesses")&&r.request().method()==="POST");await page.getByRole("button",{name:"Continue",exact:true}).click();
        const secondBody=await (await second).json();assert.notEqual(secondBody.business.id,bid,"Add a business starts a new setup instead of resuming");
        await page.getByRole("heading",{name:"Bring in your reviews"}).waitFor();assert.equal((await c.query("SELECT count(*) FROM businesses")).rows[0].count,"2");
        console.log(JSON.stringify({event:"synthetic_onboarding_walkthrough",elapsedSeconds:seconds,captionMode:"injected fixture",sessionMode:"synthetic",previews:3,liveTimingVerified:false}));
        await context.close();
      }finally{await browser.close();}
    });
  });}finally{rmSync(root,{recursive:true,force:true});}
}
main().catch(err=>{console.error(err);process.exitCode=1;});
