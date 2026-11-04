import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { databaseFixture } from "./db-fixture";
import { webFixture } from "./web-fixture";
import { sessionHash } from "../lib/auth-adapter";

// The posting banner on the Approval and Schedule pages follows the real connection (#205).
async function main() {
  if (process.env.TEST_BROWSER !== "1") { console.log("Posting banner browser test skipped: build and set TEST_BROWSER/TEST_DATABASE_URL"); return; }
  await databaseFixture(async (c) => {
    await c.query("INSERT INTO auth_users(id,email) VALUES('banner-owner','banner-owner@example.invalid')");
    await c.query("INSERT INTO owner_plans(owner_id,plan,source) VALUES('banner-owner','pro','manual')");
    await c.query("INSERT INTO auth_sessions VALUES($1,'banner-owner',now()+interval '1 hour')", [sessionHash("banner-session")]);
    const business = Number((await c.query("INSERT INTO businesses(name,timezone,owner_id) VALUES('Synthetic banner','UTC','banner-owner') RETURNING id")).rows[0].id);
    const launch = () => chromium.launch({ executablePath: process.env.CHROMIUM_PATH === "playwright" ? undefined : process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
    const open = async (base: string, path: string) => {
      const browser = await launch();
      const context = await browser.newContext(); await context.addCookies([{ name: "next-auth.session-token", value: "banner-session", url: base }]);
      const page = await context.newPage(); const errors: string[] = []; page.on("pageerror", e => errors.push(String(e)));
      await page.goto(`${base}${path}`);
      return { browser, page, errors };
    };

    // Gate off (the default): the banner says so and offers nothing to click.
    delete process.env.BUFFER_POSTING_MODE;
    await webFixture(async (base) => {
      const { browser, page, errors } = await open(base, "/approval");
      try {
        await page.getByText("Posting is switched off for now.").waitFor();
        assert.equal(await page.locator(".pl-banner a").count(), 0);
        await page.goto(`${base}/schedule`);
        await page.getByText("Posting is switched off for now.").waitFor();
        assert.equal(await page.getByText(/coming soon/i).count(), 0, "the old placeholder is gone");
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });

    // Draft mode follows the real state, from "not connected" to "ready".
    process.env.BUFFER_POSTING_MODE = "draft";
    try {
      await webFixture(async (base) => {
        const { browser, page, errors } = await open(base, "/schedule");
        try {
          await page.getByText("Posting isn’t connected yet.").waitFor();
          await page.getByRole("link", { name: "Connect Buffer" }).click();
          await page.waitForURL(`${base}/connections`);

          const conn = Number((await c.query("INSERT INTO buffer_connections(owner_id,organization_id,encrypted_access_token,encrypted_refresh_token,access_expires_at,scope,status) VALUES('banner-owner','org','a','r',now()+interval '1 hour','s','active') RETURNING id")).rows[0].id);
          await page.goto(`${base}/approval`);
          await page.getByText("Choose where this business posts.").waitFor();

          await c.query("INSERT INTO business_buffer_channels(business_id,connection_id,channel_id,channel_name,service,channel_type) VALUES($1,$2,'ch1','Synthetic Co','instagram','business')", [business, conn]);
          await page.reload();
          await page.getByText("Test mode: posts are saved as drafts.").waitFor();
          assert.match(await page.locator(".pl-banner").innerText(), /Synthetic Co/);
          assert.equal(await page.getByText("Posting isn’t connected yet.").count(), 0);

          await c.query("UPDATE buffer_connections SET status='needs_reconnect' WHERE id=$1", [conn]);
          await page.goto(`${base}/schedule`);
          await page.getByText("Buffer needs to be reconnected.").waitFor();
          assert.deepEqual(errors, []);
        } finally { await browser.close(); }
      });
    } finally { delete process.env.BUFFER_POSTING_MODE; }
  });
  console.log("Chromium posting banner flow passed");
}
void main();
