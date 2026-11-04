import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { chromium } from "playwright-core";
import { databaseFixture } from "./db-fixture";
import { webFixture } from "./web-fixture";
import { sessionHash } from "../lib/auth-adapter";

// Lining a post up on the Schedule page keeps it visible on its slot, with its real status (#206).
async function main() {
  if (process.env.TEST_BROWSER !== "1") { console.log("Lineup browser test skipped: build and set TEST_BROWSER/TEST_DATABASE_URL"); return; }
  const root = mkdtempSync(join(tmpdir(), "lineup-browser-")); process.env.MEDIA_ROOT = root;
  writeFileSync(join(root, "fixture.png"), await sharp({ create: { width: 1080, height: 1080, channels: 3, background: "#123456" } }).png().toBuffer());
  process.env.BUFFER_POSTING_MODE = "draft";
  try {
    await databaseFixture(async (c) => {
      await c.query("INSERT INTO auth_users(id,email) VALUES('lineup-owner','lineup-owner@example.invalid')");
      await c.query("INSERT INTO owner_plans(owner_id,plan,source) VALUES('lineup-owner','pro','manual')");
      await c.query("INSERT INTO auth_sessions VALUES($1,'lineup-owner',now()+interval '1 hour')", [sessionHash("lineup-session")]);
      const days = [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, time: "10:00" }));
      const business = Number((await c.query("INSERT INTO businesses(name,timezone,owner_id,posting_slots) VALUES('Synthetic lineup','UTC','lineup-owner',$1::jsonb) RETURNING id", [JSON.stringify(days)])).rows[0].id);
      const conn = Number((await c.query("INSERT INTO buffer_connections(owner_id,organization_id,encrypted_access_token,encrypted_refresh_token,access_expires_at,scope,status) VALUES('lineup-owner','org','a','r',now()+interval '1 hour','s','active') RETURNING id")).rows[0].id);
      await c.query("INSERT INTO business_buffer_channels(business_id,connection_id,channel_id,channel_name,service,channel_type) VALUES($1,$2,'ch1','Synthetic Co','instagram','business')", [business, conn]);
      const draft = Number((await c.query("INSERT INTO draft_posts(business_id,quote_text,caption_text,image_path,status) VALUES($1,'Synthetic lineup quote','Synthetic caption','/api/media/fixture.png','approved') RETURNING id", [business])).rows[0].id);

      await webFixture(async (base) => {
        const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH === "playwright" ? undefined : process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
        try {
          const context = await browser.newContext(); await context.addCookies([{ name: "next-auth.session-token", value: "lineup-session", url: base }]);
          const page = await context.newPage(); const errors: string[] = []; page.on("pageerror", e => errors.push(String(e)));
          await page.goto(`${base}/schedule`);
          await page.getByLabel(new RegExp(`Approved #${draft}:`)).check();
          const openBefore = await page.locator('li[data-taken="no"]').count();
          assert.ok(openBefore >= 4, "open slots are listed before lining up");
          await page.getByRole("button", { name: "Confirm selected posting slots" }).click();

          // The post stays visible: on its slot, with its status, and the message says when.
          const taken = page.locator('li[data-taken="yes"]');
          await taken.waitFor();
          assert.equal(await taken.count(), 1);
          assert.match(await taken.innerText(), /Synthetic lineup quote/);
          assert.match(await taken.innerText(), /Waiting for its time/);
          await page.getByText(/Post #\d+: lined up for /).waitFor();
          assert.equal(await page.getByLabel(new RegExp(`Approved #${draft}:`)).count(), 0, "it is no longer in the approved list");
          assert.equal((await c.query("SELECT state FROM posting_slot_claims WHERE draft_id=$1", [draft])).rows[0].state, "queued");

          // Cancelling gives the slot back and the post returns to Approved.
          await taken.getByRole("button", { name: "Cancel" }).click();
          await page.getByText("Cancelled. It’s back in Approved.").waitFor();
          await page.getByLabel(new RegExp(`Approved #${draft}:`)).waitFor();
          assert.equal(await page.locator('li[data-taken="yes"]').count(), 0);
          assert.equal((await c.query("SELECT count(*)::int AS n FROM posting_slot_claims WHERE draft_id=$1", [draft])).rows[0].n, 0);

          // A result from the worker shows under "Recently sent".
          await c.query("INSERT INTO posting_slot_claims(business_id,instant,draft_id,state,mode) VALUES($1,now() - interval '1 minute',$2,'drafted','draft')", [business, draft]);
          await page.reload();
          await page.getByText("Saved as a draft in Buffer").waitFor();
          assert.deepEqual(errors, []);
        } finally { await browser.close(); }
      });
    });
  } finally { delete process.env.BUFFER_POSTING_MODE; }
  console.log("Chromium schedule lineup flow passed");
}
void main();
