import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { chromium, type Browser } from "playwright-core";
import { databaseFixture } from "./db-fixture";
import { webFixture } from "./web-fixture";
import { sessionHash } from "../lib/auth-adapter";

// Walks the web Meta (Instagram / Facebook) connections screen (#234) against a
// production build. Synthetic owner, session and Pages only. No Meta call is
// possible or made: every request is local, and the test asserts that nothing
// went to facebook.com.
async function main() {
  if (process.env.TEST_BROWSER !== "1") { console.log("Meta connections browser skipped: build and set TEST_BROWSER/TEST_DATABASE_URL"); return; }

  const KEY = Buffer.alloc(32, 7).toString("base64");
  const savedEnv = {
    META_APP_ID: process.env.META_APP_ID,
    META_APP_SECRET: process.env.META_APP_SECRET,
    META_REDIRECT_URI: process.env.META_REDIRECT_URI,
    CREDENTIAL_ENCRYPTION_KEY: process.env.CREDENTIAL_ENCRYPTION_KEY
  };
  const restore = () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  const launch = (): Promise<Browser> => chromium.launch({
    executablePath: process.env.CHROMIUM_PATH === "playwright" ? undefined : process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    args: ["--no-sandbox"]
  });

  try {
    await databaseFixture(async (c) => {
      await c.query("INSERT INTO auth_users(id,name,email) VALUES('meta-browser','Synthetic Meta Owner','meta-browser@example.invalid')");
      await c.query("INSERT INTO owner_plans(owner_id,plan,source) VALUES('meta-browser','pro','manual')");
      await c.query("INSERT INTO auth_sessions VALUES($1,'meta-browser',now()+interval '1 hour')", [sessionHash("meta-browser-session")]);
      const business = Number((await c.query("INSERT INTO businesses(name,timezone,owner_id) VALUES('Synthetic Meta café','UTC','meta-browser') RETURNING id")).rows[0].id);

      // 1. Missing app credentials: an honest "not available yet" state with no
      // connect button, and Buffer still works unchanged.
      process.env.META_APP_ID = "";
      process.env.META_APP_SECRET = "";
      await webFixture(async (base) => {
        const browser = await launch();
        try {
          const context = await browser.newContext();
          await context.addCookies([{ name: "next-auth.session-token", value: "meta-browser-session", url: base }]);
          const page = await context.newPage();
          const pageErrors: string[] = [];
          page.on("pageerror", error => pageErrors.push(error.message));
          const external: string[] = [];
          page.on("request", request => { if (/facebook\.com|graph\.facebook\.com/.test(request.url())) external.push(request.url()); });

          await page.goto(`${base}/connections`);
          await page.getByRole("heading", { name: "Connections" }).waitFor();
          await page.getByRole("heading", { name: "Instagram and Facebook" }).waitFor();
          await page.getByText("Not available yet").waitFor();
          assert.equal(await page.getByRole("button", { name: "Connect Instagram or Facebook" }).count(), 0, "no broken connect button without credentials");
          await page.getByText(/Direct posting to Instagram and Facebook isn.t set up on this server yet/).waitFor();
          await page.getByRole("button", { name: "Connect Buffer" }).waitFor();

          // The callback outcome is shown once and the code leaves the address bar.
          await page.goto(`${base}/connections?meta=denied`);
          await page.getByText(/You didn.t approve the connection to Facebook/).waitFor();
          assert.equal(new URL(page.url()).search, "", "the outcome query string is removed");
          await page.goto(`${base}/connections?meta=not-a-real-outcome`);
          await page.getByRole("heading", { name: "Connections" }).waitFor();
          assert.equal(await page.locator(".pl-banner").count(), 0, "an unknown outcome shows no banner");
          assert.equal(new URL(page.url()).search, "", "the unknown outcome is also removed");

          assert.deepEqual(pageErrors, []);
          assert.deepEqual(external, [], "no request went to Meta");
          await context.close();
        } finally { await browser.close(); }
      });

      // 2. Configured and connected: choose one target per business, then disconnect.
      process.env.META_APP_ID = "synthetic-app";
      process.env.META_APP_SECRET = "synthetic-secret";
      process.env.META_REDIRECT_URI = "https://app.example.invalid/api/meta/callback";
      process.env.CREDENTIAL_ENCRYPTION_KEY = KEY;
      const connection = Number((await c.query("INSERT INTO meta_connections(owner_id,status) VALUES('meta-browser','active') RETURNING id")).rows[0].id);
      const pageWithInstagram = Number((await c.query(
        `INSERT INTO meta_pages(connection_id,page_id,name,encrypted_page_token,instagram_business_account_id,tasks,status)
         VALUES($1,'page-one','Synthetic Page One','encrypted','ig-one',ARRAY['CREATE_CONTENT','MANAGE'],'active') RETURNING id`,
        [connection]
      )).rows[0].id);
      const pageWithInstagramAgain = Number((await c.query(
        `INSERT INTO meta_pages(connection_id,page_id,name,encrypted_page_token,instagram_business_account_id,tasks,status)
         VALUES($1,'page-two','Synthetic Page Two','encrypted',NULL,ARRAY['CREATE_CONTENT'],'active') RETURNING id`,
        [connection]
      )).rows[0].id);

      await webFixture(async (base) => {
        const browser = await launch();
        try {
          const context = await browser.newContext();
          await context.addCookies([{ name: "next-auth.session-token", value: "meta-browser-session", url: base }]);
          const page = await context.newPage();
          const pageErrors: string[] = [];
          page.on("pageerror", error => pageErrors.push(error.message));
          const external: string[] = [];
          page.on("request", request => { if (/facebook\.com|graph\.facebook\.com/.test(request.url())) external.push(request.url()); });

          await page.goto(`${base}/connections`);
          await page.getByRole("heading", { name: "Posting targets" }).waitFor();
          const select = page.getByLabel("Synthetic Meta café");
          await select.waitFor();
          await select.selectOption(`${pageWithInstagram}:instagram`);
          await page.getByText("Posting target saved.").waitFor();
          const saved = (await c.query("SELECT t.target,p.page_id FROM business_meta_targets t JOIN meta_pages p ON p.id=t.meta_page_id WHERE t.business_id=$1", [business])).rows[0];
          assert.deepEqual([saved.target, saved.page_id], ["instagram", "page-one"]);

          // A different Page replaces the one target, never adds a second.
          await select.selectOption(`${pageWithInstagramAgain}:facebook`);
          await page.getByText("Posting target saved.").waitFor();
          const replaced = (await c.query("SELECT t.target,p.page_id FROM business_meta_targets t JOIN meta_pages p ON p.id=t.meta_page_id WHERE t.business_id=$1", [business])).rows[0];
          assert.deepEqual([replaced.target, replaced.page_id], ["facebook", "page-two"]);
          assert.equal(Number((await c.query("SELECT count(*)::int n FROM business_meta_targets WHERE business_id=$1", [business])).rows[0].n), 1);

          // Clearing the target keeps the connection.
          await select.selectOption("");
          await page.getByText("Posting target removed.").waitFor();
          assert.equal(Number((await c.query("SELECT count(*)::int n FROM business_meta_targets WHERE business_id=$1", [business])).rows[0].n), 0);

          // One flagged Page shows a reconnect notice beside the target picker.
          await c.query("UPDATE meta_pages SET status='needs_reconnect' WHERE id=$1", [pageWithInstagramAgain]);
          await page.reload();
          await page.getByText("One or more Facebook Pages need reconnecting before they can publish.").waitFor();
          await page.getByRole("button", { name: "Reconnect Instagram or Facebook" }).waitFor();
          await c.query("UPDATE meta_pages SET status='active' WHERE id=$1", [pageWithInstagramAgain]);
          await page.reload();
          await page.getByRole("heading", { name: "Posting targets" }).waitFor();

          // A flagged connection offers reconnect, not a target picker.
          await c.query("UPDATE meta_connections SET status='needs_reconnect' WHERE id=$1", [connection]);
          await page.reload();
          await page.getByRole("button", { name: "Reconnect Instagram or Facebook" }).waitFor();
          assert.equal(await page.getByRole("heading", { name: "Posting targets" }).count(), 0);
          await c.query("UPDATE meta_connections SET status='active' WHERE id=$1", [connection]);
          await page.reload();
          await page.getByRole("heading", { name: "Posting targets" }).waitFor();

          // Disconnect confirms inline and removes the saved connection.
          await page.getByRole("button", { name: "Disconnect", exact: true }).click();
          const confirm = page.getByRole("button", { name: "Confirm", exact: true });
          await confirm.click();
          await page.getByRole("button", { name: "Connect Instagram or Facebook" }).waitFor();
          assert.equal(Number((await c.query("SELECT count(*)::int n FROM meta_connections WHERE owner_id='meta-browser'")).rows[0].n), 0);

          assert.deepEqual(pageErrors, []);
          assert.deepEqual(external, [], "no request went to Meta");
          await context.close();
        } finally { await browser.close(); }
      });

      console.log(JSON.stringify({ event: "synthetic_meta_connections_walkthrough", sessionMode: "synthetic", metaCalls: 0, states: ["not_available", "active", "needs_reconnect", "disconnected"] }));
    });
  } finally {
    restore();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
