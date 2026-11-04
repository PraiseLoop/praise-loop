import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import sharp from "sharp";
import { databaseFixture } from "./db-fixture";
import { webFixture } from "./web-fixture";
import { sessionHash } from "../lib/auth-adapter";

// The posting status on the web approval cards (#29 part 4), in a real browser against the production
// build. Buffer is never contacted: claims are seeded straight into the database.
async function main() {
  if (process.env.TEST_BROWSER !== "1") { console.log("Browser smoke skipped: set TEST_BROWSER=1 and TEST_DATABASE_URL after build"); return; }
  const root = mkdtempSync(join(tmpdir(), "posting-cards-")); process.env.MEDIA_ROOT = root;
  try {
    await databaseFixture(async (c) => {
      await c.query("INSERT INTO auth_users(id,email) VALUES('cards-owner','cards@example.invalid')");
      await c.query("INSERT INTO owner_plans(owner_id,plan,source) VALUES('cards-owner','pro','manual')");
      await c.query("INSERT INTO auth_sessions VALUES($1,'cards-owner',now()+interval '1 hour')", [sessionHash("cards-session")]);
      const bid = (await c.query("INSERT INTO businesses(name,timezone,owner_id) VALUES('Synthetic cards café','UTC','cards-owner') RETURNING id")).rows[0].id;
      writeFileSync(join(root, "preview.png"), await sharp({ create: { width: 1080, height: 1080, channels: 3, background: "#1f2937" } }).png().toBuffer());
      let n = 0;
      async function seed(status: string, state: string | null, extra: { link?: string; code?: string } = {}) {
        n += 1;
        const id = String((await c.query("INSERT INTO draft_posts(business_id,quote_text,caption_text,image_path,status,scheduled_for) VALUES($1,'Synthetic quote',$2,'/api/media/preview.png',$3,now()+interval '2 days') RETURNING id", [bid, `Synthetic caption ${n}`, status])).rows[0].id);
        if (state) await c.query("INSERT INTO posting_slot_claims(business_id,instant,draft_id,state,external_link,error_code) VALUES($1,now()+($2||' days')::interval,$3,$4,$5,$6)", [bid, String(n), id, state, extra.link ?? null, extra.code ?? null]);
        return id;
      }
      const queued = await seed("scheduled", "queued"), sending = await seed("scheduled", "submitting"), waiting = await seed("scheduled", "submitted");
      const unknownPosted = await seed("scheduled", "unknown", { code: "ambiguous" }), unknownNot = await seed("scheduled", "unknown", { code: "ambiguous" });
      const badLink = await seed("published", "sent", { link: "javascript:alert(1)" }), goodLink = await seed("published", "sent", { link: "https://instagram.example/p/synthetic" });
      const late = await seed("failed", "missed", { code: "late" }), weird = await seed("failed", "error", { code: "SECRET_RAW_CODE" }), drafted = await seed("approved", "drafted");
      await webFixture(async (base) => {
        const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH === "playwright" ? undefined : process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
        try {
          const context = await browser.newContext(); await context.addCookies([{ name: "next-auth.session-token", value: "cards-session", url: base }]);
          const page = await context.newPage(); const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
          await page.goto(`${base}/approval`); await page.getByRole("combobox", { name: "Business" }).selectOption(String(bid));
          const card = (id: string) => page.getByRole("article", { name: new RegExp(`^Post #${id} `) });
          await card(queued).getByText("Waiting for its time").waitFor();
          await card(sending).getByText("Sending to Buffer…").waitFor();
          await card(waiting).getByText(/Sent to Buffer — waiting/).waitFor();
          await card(unknownPosted).getByText("We couldn’t confirm this post").waitFor();
          await card(late).getByText("Not posted").waitFor(); await card(late).getByText(/more than 2 hours past its time/).waitFor();
          await card(weird).getByText("Something went wrong sending it.").waitFor();
          assert.equal(await page.getByText("SECRET_RAW_CODE").count(), 0, "a raw error code is never shown");
          await card(drafted).getByText("Saved as a draft in Buffer").waitFor();
          // Links: only https is offered, and it opens safely.
          await card(goodLink).getByText("Posted").waitFor(); await card(badLink).getByText("Posted").waitFor();
          assert.equal(await card(badLink).getByRole("link", { name: "See the post" }).count(), 0, "a javascript: link is not shown");
          const link = card(goodLink).getByRole("link", { name: "See the post" });
          assert.equal(await link.getAttribute("href"), "https://instagram.example/p/synthetic"); assert.match(String(await link.getAttribute("rel")), /noreferrer/);
          // Only the right buttons per state.
          assert.equal(await card(sending).getByRole("button", { name: "Cancel scheduling" }).count(), 0, "a post being sent cannot be cancelled");
          assert.equal(await card(queued).getByRole("button", { name: "It was posted" }).count(), 0);
          // Cancel a queued post.
          const cancel = page.waitForResponse((r) => r.url().endsWith("/api/posting-slots/cancel"));
          await card(queued).getByRole("button", { name: "Cancel scheduling" }).click(); assert.equal((await cancel).status(), 200);
          await page.getByRole("status").getByText("Cancelled. It’s back in Approved.").waitFor();
          // Resolve an unknown post both ways.
          const posted = page.waitForResponse((r) => r.url().endsWith("/api/posting-slots/resolve"));
          await card(unknownPosted).getByRole("button", { name: "It was posted" }).click(); assert.equal((await posted).status(), 200);
          const notPosted = page.waitForResponse((r) => r.url().endsWith("/api/posting-slots/resolve"));
          await card(unknownNot).getByRole("button", { name: "It wasn’t posted" }).click(); assert.equal((await notPosted).status(), 200);
          await card(unknownNot).getByText("You told us it wasn’t posted.").waitFor();
          // A failed post can be approved again, which clears the failed attempt.
          const again = page.waitForResponse((r) => r.url().endsWith("/api/drafts/status"));
          await card(late).getByRole("button", { name: "Approve again" }).click(); assert.equal((await again).status(), 200);
          assert.deepEqual(errors, []); await context.close();
        } finally { await browser.close(); }
      });
      const status = async (id: string) => (await c.query("SELECT status FROM draft_posts WHERE id=$1", [id])).rows[0].status;
      const claims = async (id: string) => Number((await c.query("SELECT count(*) FROM posting_slot_claims WHERE draft_id=$1", [id])).rows[0].count);
      assert.deepEqual([await status(queued), await claims(queued)], ["approved", 0]);
      assert.deepEqual([await status(unknownPosted), (await c.query("SELECT state FROM posting_slot_claims WHERE draft_id=$1", [unknownPosted])).rows[0].state], ["shared", "sent"]);
      assert.deepEqual([await status(unknownNot), (await c.query("SELECT state FROM posting_slot_claims WHERE draft_id=$1", [unknownNot])).rows[0].state], ["failed", "error"]);
      assert.deepEqual([await status(late), await claims(late)], ["approved", 0]);
      console.log(JSON.stringify({ event: "synthetic_posting_cards_walkthrough", bufferCalls: 0 }));
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
