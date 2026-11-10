import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import sharp from "sharp";
import { databaseFixture } from "./db-fixture";
import { webFixture } from "./web-fixture";
import { sessionHash } from "../lib/auth-adapter";
import { SHARED_HINT } from "../lib/posting/webShare";

// Posting an approved draft from the web approval queue (#274). This browser
// cannot share files, so the card must fall back to Download image + Copy
// caption + Mark as posted; no share sheet is ever called.
async function main() {
  if (process.env.TEST_BROWSER !== "1") { console.log("Web share browser test skipped: build and set TEST_BROWSER/TEST_DATABASE_URL"); return; }
  const root = mkdtempSync(join(tmpdir(), "web-share-")); process.env.MEDIA_ROOT = root;
  try {
    await databaseFixture(async (c) => {
      await c.query("INSERT INTO auth_users(id,email) VALUES('share-owner','share@example.invalid')");
      await c.query("INSERT INTO owner_plans(owner_id,plan,source) VALUES('share-owner','pro','manual')");
      await c.query("INSERT INTO auth_sessions VALUES($1,'share-owner',now()+interval '1 hour')", [sessionHash("share-session")]);
      const bid = (await c.query("INSERT INTO businesses(name,timezone,owner_id) VALUES('Synthetic share café','UTC','share-owner') RETURNING id")).rows[0].id;
      writeFileSync(join(root, "preview.png"), await sharp({ create: { width: 1080, height: 1080, channels: 3, background: "#0E5A48" } }).png().toBuffer());
      const draft = String((await c.query("INSERT INTO draft_posts(business_id,quote_text,caption_text,image_path,status) VALUES($1,'Synthetic share quote','Synthetic share caption','/api/media/preview.png','approved') RETURNING id", [bid])).rows[0].id);

      await webFixture(async (base) => {
        const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH === "playwright" ? undefined : process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
        try {
          const context = await browser.newContext({ acceptDownloads: true });
          await context.addCookies([{ name: "next-auth.session-token", value: "share-session", url: base }]);
          await context.grantPermissions(["clipboard-write"], { origin: base });
          // Force the fallback even if this Chromium build can share files.
          await context.addInitScript(() => {
            Object.defineProperty(navigator, "canShare", { configurable: true, value: () => false });
            Object.defineProperty(navigator, "share", { configurable: true, value: () => Promise.reject(new Error("share sheet must not open")) });
          });
          const page = await context.newPage(); const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
          await page.goto(`${base}/approval`);
          await page.bringToFront();
          await page.getByRole("combobox", { name: "Business" }).selectOption(String(bid));
          const card = page.getByRole("article", { name: new RegExp(`^Post #${draft} `) });
          await card.getByText("Approved", { exact: true }).waitFor();

          // The fallback, not a Post button.
          assert.equal(await card.getByRole("button", { name: "Post", exact: true }).count(), 0, "no share button when files can't be shared");
          assert.equal(await card.getByRole("button", { name: "Download image" }).count(), 1);
          assert.equal(await card.getByRole("button", { name: "Copy caption" }).count(), 1);
          assert.equal(await card.getByRole("button", { name: "Mark as posted" }).count(), 1);

          // Copy caption writes the real caption and says what to do with it.
          await card.getByRole("button", { name: "Copy caption" }).click();
          await card.getByText(SHARED_HINT).waitFor();

          // Download image saves the owner-protected PNG with a stable name.
          const downloading = page.waitForEvent("download");
          await card.getByRole("button", { name: "Download image" }).click();
          assert.equal((await downloading).suggestedFilename(), `praiseloop-${draft}.png`);

          // Mark as posted goes through the existing status route with the card's version.
          const status = page.waitForResponse(r => r.url().endsWith("/api/drafts/status") && r.request().method() === "POST");
          await card.getByRole("button", { name: "Mark as posted" }).click();
          assert.equal((await status).status(), 200);
          await page.getByRole("heading", { name: "Shared by you" }).waitFor();
          assert.deepEqual(errors, []);
          await context.close();
        } finally { await browser.close(); }
      });

      const row = (await c.query("SELECT status, shared_at FROM draft_posts WHERE id=$1", [draft])).rows[0];
      assert.equal(row.status, "shared");
      assert.ok(row.shared_at, "shared_at records when the owner reported it");
      const event = (await c.query("SELECT actor_id, action, reason, from_status, to_status FROM draft_events WHERE draft_id=$1 ORDER BY id DESC LIMIT 1", [draft])).rows[0];
      assert.deepEqual(event, { actor_id: "share-owner", action: "status", reason: "owner_shared", from_status: "approved", to_status: "shared" });
      console.log(JSON.stringify({ event: "synthetic_web_share_fallback_walkthrough", shareCalls: 0 }));
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
