import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import sharp from "sharp";
import { databaseFixture } from "./db-fixture";
import { webFixture } from "./web-fixture";
import { sessionHash } from "../lib/auth-adapter";

// Every owner-facing screen at phone width (#276): no horizontal page overflow,
// controls a thumb can hit, and no fixed bar sitting on top of the content.
const widths: [number, number][] = [[360, 800], [390, 844]];
const longToken = "https://www.example.invalid/reviews/a-very-long-unbroken-synthetic-identifier-for-layout-testing";

async function assertPhoneLayout(page: Page, label: string, width: number) {
  const result = await page.evaluate(() => {
    const tabbar = document.querySelector<HTMLElement>(".pl-tabbar");
    const main = document.querySelector<HTMLElement>(".pl-main");
    const controls = Array.from(document.querySelectorAll<HTMLElement>("button.pl-btn, a.pl-btn, .pl-tabbar a, .pl-select, input.pl-input, textarea.pl-input, summary"))
      .filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    const small = controls
      .map(el => ({ el, rect: el.getBoundingClientRect() }))
      .filter(({ rect }) => rect.height < 44)
      .map(({ el, rect }) => `${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30)}" ${Math.round(rect.height)}px`);
    // Text-entry controls need 16px text or iOS zooms the page when they focus.
    const zooming = Array.from(document.querySelectorAll<HTMLElement>("input.pl-input, select.pl-select, textarea.pl-input"))
      .filter(el => {
        const type = (el as HTMLInputElement).type;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !["checkbox", "radio", "file"].includes(type);
      })
      .filter(el => parseFloat(getComputedStyle(el).fontSize) < 16)
      .map(el => `${el.tagName.toLowerCase()} ${getComputedStyle(el).fontSize}`);
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      small,
      zooming,
      tabbarHeight: tabbar ? tabbar.getBoundingClientRect().height : 0,
      mainPaddingBottom: main ? parseFloat(getComputedStyle(main).paddingBottom) : 0
    };
  });
  assert.ok(result.scrollWidth <= result.innerWidth, `${label} overflows at ${width}px: ${result.scrollWidth} > ${result.innerWidth}`);
  assert.deepEqual(result.small, [], `${label} has tap targets under 44px at ${width}px`);
  assert.deepEqual(result.zooming, [], `${label} has text controls below 16px at ${width}px`);
  if (result.tabbarHeight) assert.ok(result.mainPaddingBottom >= result.tabbarHeight, `${label} content can hide behind the tab bar at ${width}px`);
}

async function main() {
  if (process.env.TEST_BROWSER !== "1") { console.log("Phone width browser test skipped: build and set TEST_BROWSER/TEST_DATABASE_URL"); return; }
  const root = mkdtempSync(join(tmpdir(), "phone-width-browser-"));
  process.env.MEDIA_ROOT = root;
  try {
    await databaseFixture(async c => {
      await c.query("INSERT INTO auth_users(id,name,email) VALUES('phone-owner','Synthetic Phone Owner','phone-owner@example.invalid')");
      await c.query("INSERT INTO owner_plans(owner_id,plan,source) VALUES('phone-owner','pro','manual')");
      await c.query("INSERT INTO auth_sessions VALUES($1,'phone-owner',now()+interval '1 hour')", [sessionHash("phone-owner-session")]);
      await c.query("INSERT INTO businesses(name,timezone,owner_id) VALUES('Synthetic phone layout café and bakery','UTC','phone-owner')");
      const business = (await c.query("SELECT id FROM businesses WHERE owner_id='phone-owner' ORDER BY id LIMIT 1")).rows[0].id;
      const onboardingBusiness = (await c.query("INSERT INTO businesses(name,timezone,owner_id) VALUES('Synthetic onboarding bakery','UTC','phone-owner') RETURNING id")).rows[0].id;

      writeFileSync(join(root, "preview.png"), await sharp({ create: { width: 1080, height: 1080, channels: 3, background: "#1f2937" } }).png().toBuffer());
      writeFileSync(join(root, "onboarding.png"), await sharp({ create: { width: 1080, height: 1080, channels: 3, background: "#123456" } }).png().toBuffer());

      let reviewNumber = 0;
      const review = async (text: string) => (await c.query("INSERT INTO reviews(business_id,source,source_review_id,rating,text,reviewed_at,author_name) VALUES($1,'manual',$2,5,$3,now(),'Example reviewer') RETURNING id", [business, String(reviewNumber++), text])).rows[0].id;
      const usedReview = await review("Synthetic warm and friendly service worth quoting in a post.");
      const longReview = await review(`Synthetic review with an unbroken link ${longToken} and a long explanation.`);

      // Every card stage the approval queue can show, including a long unbroken caption and quote.
      const draft = async (status: string, caption: string, image: string | null, reviewId: number | null) =>
        (await c.query("INSERT INTO draft_posts(business_id,review_id,quote_text,caption_text,image_path,status) VALUES($1,$2,$3,$4,$5,$6) RETURNING id", [business, reviewId, `Synthetic quote with a long unbroken token ${longToken}`, caption, image, status])).rows[0].id;
      const ready = await draft("draft", `Synthetic caption with an unbroken token ${longToken}`, "/api/media/preview.png", longReview);
      const approved = await draft("approved", "Synthetic approved caption", "/api/media/preview.png", usedReview);
      const failed = await draft("failed", "", null, await review("Synthetic failed review."));
      const making = await draft("draft", "", null, await review("Synthetic making review."));
      await draft("shared", "Synthetic shared caption", "/api/media/preview.png", await review("Synthetic shared review."));
      const archived = await draft("archived", "Synthetic skipped caption", "/api/media/preview.png", await review("Synthetic skipped review."));
      await c.query("INSERT INTO generation_jobs(business_id,period_start,draft_id,state,attempts,error_code) VALUES($1,'2026-10-12',$2,'failed',3,'generation_failed')", [business, failed]);
      await c.query("INSERT INTO generation_jobs(business_id,period_start,draft_id,state,attempts) VALUES($1,'2026-10-12',$2,'pending',0)", [business, making]);

      // Onboarding's final step: three finished posts in the horizontal carousel.
      for (let n = 0; n < 3; n++) {
        await c.query("INSERT INTO draft_posts(business_id,quote_text,caption_text,image_path,status) VALUES($1,$2,$3,'/api/media/onboarding.png','draft')", [onboardingBusiness, `Synthetic onboarding quote ${n}`, `Synthetic onboarding caption ${n}`]);
      }

      await webFixture(async base => {
        const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH === "playwright" ? undefined : process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
        const open = async (signedIn: boolean, width: number, height: number): Promise<BrowserContext> => {
          const context = await browser.newContext({ viewport: { width, height } });
          if (signedIn) await context.addCookies([{ name: "next-auth.session-token", value: "phone-owner-session", url: base }]);
          return context;
        };
        try {
          for (const [width, height] of widths) {
            // Signed in: every owner screen.
            const context = await open(true, width, height);
            const page = await context.newPage();
            const errors: string[] = [];
            page.on("pageerror", error => errors.push(error.message));
            const visit = async (path: string, waitFor: () => Promise<unknown>, label: string) => {
              await page.goto(`${base}${path}`);
              await waitFor();
              await assertPhoneLayout(page, label, width);
            };

            await visit("/approval", () => page.getByRole("article", { name: new RegExp(`^Post #${ready} `) }).waitFor(), "Approval");
            // Draft editing is part of the approval queue; the textarea and its actions must fit too.
            await page.getByRole("article", { name: new RegExp(`^Post #${approved} `) }).getByRole("button", { name: "Edit caption", exact: true }).click();
            await page.getByLabel(`Caption for draft ${approved}`).waitFor();
            await assertPhoneLayout(page, "Approval (caption editing)", width);
            await page.getByText(/Skipped posts \(/).click();
            await page.getByRole("button", { name: "Bring it back" }).waitFor();
            await assertPhoneLayout(page, "Approval (skipped posts)", width);

            await visit("/schedule", () => page.getByRole("heading", { name: "When to post" }).waitFor(), "Schedule");
            await visit("/reviews", () => page.getByRole("table").waitFor(), "Reviews");
            await visit("/quotes", () => page.getByRole("heading", { name: "Quote selector + caption generation" }).waitFor(), "Quotes tool");
            await visit("/brand", async () => { await page.getByRole("heading", { name: "Brand", exact: true }).waitFor(); await page.getByRole("button", { name: "Save changes" }).waitFor(); }, "Brand");
            await visit("/account", () => page.getByRole("heading", { name: "Sign-in methods" }).waitFor(), "Account");
            await visit("/connections", async () => { await page.getByRole("heading", { name: "Instagram and Facebook" }).waitFor(); await page.getByRole("heading", { name: "Buffer", exact: true }).waitFor(); }, "Connections");
            await visit("/onboarding?new=1", () => page.getByRole("heading", { name: "Tell us about your business" }).waitFor(), "Onboarding (new business)");
            await visit(`/onboarding?businessId=${onboardingBusiness}`, () => page.getByRole("link", { name: "Review & approve" }).waitFor(), "Onboarding (finished posts)");
            await visit("/plans", () => page.getByRole("heading", { name: "Three plans. Your approval, always." }).waitFor(), "Plans");

            // Every page above settled without a script error.
            assert.deepEqual(errors, []);
            await context.close();

            // Signed out: the landing page (sign-in) with the email-code form open.
            const anonymous = await open(false, width, height);
            const signIn = await anonymous.newPage();
            await signIn.goto(`${base}/`);
            await signIn.getByRole("heading", { name: "Your happy customers are your best marketing." }).waitFor();
            await assertPhoneLayout(signIn, "Sign-in", width);
            await signIn.getByRole("button", { name: "Email me a sign-in code" }).click();
            await signIn.getByLabel("Email address").waitFor();
            await assertPhoneLayout(signIn, "Sign-in (email code)", width);
            await anonymous.close();
          }
          assert.equal((await c.query("SELECT status FROM draft_posts WHERE id=$1", [archived])).rows[0].status, "archived");
          console.log("Chromium phone-width layout passed for every owner page at 360x800 and 390x844");
        } finally { await browser.close(); }
      });
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
