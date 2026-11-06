import assert from "node:assert/strict";
import { mkdtempSync,writeFileSync,rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { chromium } from "playwright-core";
import { databaseFixture } from "./db-fixture";
import { webFixture } from "./web-fixture";
import { sessionHash } from "../lib/auth-adapter";
async function main(){
  if(process.env.TEST_BROWSER!=="1"){console.log("Slots browser skipped: build and set TEST_BROWSER/TEST_DATABASE_URL");return;}
  const root=mkdtempSync(join(tmpdir(),"slots-browser-"));process.env.MEDIA_ROOT=root;
  try{await databaseFixture(async c=>{
    await c.query("INSERT INTO auth_users(id,email) VALUES('slots-browser','slots-browser@example.invalid')");
    await c.query("INSERT INTO owner_plans(owner_id,plan,source) VALUES('slots-browser','business','manual')");
    await c.query("INSERT INTO auth_sessions VALUES($1,'slots-browser',now()+interval '1 hour')",[sessionHash("slots-browser-session")]);
    const bid=(await c.query("INSERT INTO businesses(name,timezone,owner_id) VALUES('Synthetic slots browser','America/New_York','slots-browser') RETURNING id")).rows[0].id;
    const other=(await c.query("INSERT INTO businesses(name,timezone,owner_id) VALUES('Other synthetic slots','UTC','slots-browser') RETURNING id")).rows[0].id;
    writeFileSync(join(root,"fixture.png"),await sharp({create:{width:1080,height:1080,channels:3,background:"#123456"}}).png().toBuffer());
    const id=(await c.query("INSERT INTO draft_posts(business_id,quote_text,caption_text,image_path,status) VALUES($1,'Synthetic slot quote','Synthetic caption','/api/media/fixture.png','approved') RETURNING id",[bid])).rows[0].id;
    await webFixture(async base=>{
      const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH==="playwright"?undefined:process.env.CHROMIUM_PATH??"/usr/bin/chromium",args:["--no-sandbox"]});
      try{
        const context=await browser.newContext({timezoneId:"America/Los_Angeles"});await context.addCookies([{name:"next-auth.session-token",value:"slots-browser-session",url:base}]);
        const page=await context.newPage();await page.goto(`${base}/schedule`);await page.getByRole("combobox",{name:"Business"}).selectOption(String(bid));
        await page.getByLabel("Tue local time").fill("11:15");
        const save=page.waitForResponse(r=>r.url().endsWith("/api/posting-slots")&&r.request().method()==="PATCH");await page.getByRole("button",{name:"Save posting schedule"}).click();assert.equal((await save).status(),200);
        await page.getByText(/Posting times saved/).waitFor();
        const calendar=page.locator("ol");assert.match(await calendar.innerText(),/America\/New_York/);assert.match(await calendar.innerText(),/UTC/);
        await page.getByLabel(new RegExp(`Approved #${id}:`)).check();
        const assign=page.waitForResponse(r=>r.url().endsWith("/api/posting-slots/assign"));await page.getByRole("button",{name:"Confirm selected posting slots"}).click();
        const data=await (await assign).json();assert.equal(data.results[0].status,503);await page.getByText(/Automatic posting is not switched on yet/).waitFor();
        await page.reload();await page.getByRole("combobox",{name:"Business"}).selectOption(String(bid));await page.getByLabel("Tue local time").waitFor();assert.equal(await page.getByLabel("Tue local time").inputValue(),"11:15");
        // Hold a previous business response until a new business has loaded.
        let release!:()=>void,started!:()=>void;
        const held=new Promise<void>(resolve=>{release=resolve;}),seen=new Promise<void>(resolve=>{started=resolve;});
        await page.route(`**/api/posting-slots?businessId=${bid}`,async route=>{const response=await route.fetch();started();await held;await route.fulfill({response});});
        await page.getByRole("combobox",{name:"Business"}).selectOption(String(other));
        await page.getByLabel("Tue local time").waitFor();
        await page.getByRole("combobox",{name:"Business"}).selectOption(String(bid));await seen;
        await page.getByRole("combobox",{name:"Business"}).selectOption(String(other));
        await page.getByLabel("Tue local time").waitFor();
        const stale=page.waitForResponse(r=>r.url().endsWith(`/api/posting-slots?businessId=${bid}`));release();await stale;
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        assert.equal(await page.getByLabel("Tue local time").inputValue(),"10:00");
        const otherSave=page.waitForResponse(r=>r.url().endsWith("/api/posting-slots")&&r.request().method()==="PATCH");
        await page.getByRole("button",{name:"Save posting schedule"}).click();assert.equal((await otherSave).status(),200);
        assert.equal((await c.query("SELECT posting_slots FROM businesses WHERE id=$1",[other])).rows[0].posting_slots.find((s:{weekday:number})=>s.weekday===2).time,"10:00");
        await page.goto(`${base}/brand`);
        await page.getByRole("combobox",{name:"Business"}).selectOption(String(bid));
        await page.getByLabel("Logo upload").setInputFiles(join(root,"fixture.png"));
        await page.getByAltText("Selected business logo").waitFor();
        const branding=page.waitForResponse(r=>r.url().endsWith(`/api/businesses/${bid}`)&&r.request().method()==="PATCH");
        await page.getByRole("button",{name:"Save changes"}).click();
        assert.equal((await branding).status(),200);
        assert.match((await c.query("SELECT logo_url FROM businesses WHERE id=$1",[bid])).rows[0].logo_url,/^data:image\/png;base64,/);
        await page.reload();await page.getByRole("combobox",{name:"Business"}).selectOption(String(bid));
        await page.getByAltText("Selected business logo").waitFor();
        await page.getByRole("button",{name:"Remove logo"}).click();
        const removed=page.waitForResponse(r=>r.url().endsWith(`/api/businesses/${bid}`)&&r.request().method()==="PATCH");
        await page.getByRole("button",{name:"Save changes"}).click();
        assert.equal((await removed).status(),200);
        assert.equal((await c.query("SELECT logo_url FROM businesses WHERE id=$1",[bid])).rows[0].logo_url,null);
        await context.close();
      }finally{await browser.close();}
    });
    assert.equal((await c.query("SELECT status FROM draft_posts WHERE id=$1",[id])).rows[0].status,"approved");
    assert.equal((await c.query("SELECT count(*) FROM posting_slot_claims")).rows[0].count,"0");
    console.log("Chromium business/browser timezone/settings persistence/explicit confirmation/provider failure flow passed");
  });}finally{rmSync(root,{recursive:true,force:true});}
}
main().catch(err=>{console.error(err);process.exitCode=1;});
