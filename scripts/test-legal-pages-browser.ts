import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { PRIVACY_URL, SUPPORT_URL, TERMS_URL } from "../lib/legalLinks";
import { webFixture } from "./web-fixture";

// The legal pages live on praiseloop.ca (#292). The app's old /privacy, /terms and
// /support paths must redirect there for a signed-out visitor, and the landing page
// must link to the website. No request leaves the test machine: redirects are read
// with redirect: "manual" and links by their href. Run after `npm run build` with
// TEST_BROWSER=1.
async function main() {
  if (process.env.TEST_BROWSER !== "1") { console.log("Legal pages browser test skipped: build and set TEST_BROWSER=1"); return; }

  await webFixture(async base => {
    for (const [route, target] of [["/privacy", PRIVACY_URL], ["/terms", TERMS_URL], ["/support", SUPPORT_URL]] as const) {
      const response = await fetch(`${base}${route}`, { redirect: "manual" });
      assert.equal(response.status, 307, `${route} redirects temporarily`);
      assert.equal(response.headers.get("location"), target, `${route} redirects to ${target}`);
    }

    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH === "playwright" ? undefined : process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"]
    });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      // Never load the real website from a test.
      await context.route(/^https:\/\/praiseloop\.ca\//, route => route.abort());
      const page = await context.newPage();
      await page.goto(`${base}/`);
      const footer = page.getByRole("navigation", { name: "Legal and help" });
      assert.equal(await footer.getByRole("link", { name: "Privacy" }).getAttribute("href"), PRIVACY_URL);
      assert.equal(await footer.getByRole("link", { name: "Terms" }).getAttribute("href"), TERMS_URL);
      assert.equal(await footer.getByRole("link", { name: "Support" }).getAttribute("href"), SUPPORT_URL);
      assert.equal(await page.getByRole("link", { name: "Terms of Service" }).getAttribute("href"), TERMS_URL);
      assert.equal(await page.getByRole("link", { name: "Privacy Policy" }).getAttribute("href"), PRIVACY_URL);
      await context.close();
      console.log("Legal pages browser test passed: old paths redirect to praiseloop.ca and the landing page links there");
    } finally {
      await browser.close();
    }
  });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
