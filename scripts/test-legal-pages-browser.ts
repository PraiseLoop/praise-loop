import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { webFixture } from "./web-fixture";

// The three legal pages must render for a signed-out visitor, not redirect to the
// sign-in landing page and not hide behind AppShell's sign-in wall (#262). Run
// after `npm run build` with TEST_BROWSER=1; no database or provider is called by
// the pages themselves.
async function main() {
  if (process.env.TEST_BROWSER !== "1") { console.log("Legal pages browser test skipped: build and set TEST_BROWSER=1"); return; }

  await webFixture(async base => {
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH === "playwright" ? undefined : process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"]
    });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      const routeHeadings = [
        ["/privacy", "Privacy Policy"],
        ["/terms", "Terms of Service"],
        ["/support", "Support"]
      ] as const;

      for (const [route, heading] of routeHeadings) {
        const response = await page.goto(`${base}${route}`);
        assert.equal(response?.status(), 200, `${route} answers 200 signed out`);
        assert.equal(new URL(page.url()).pathname, route, `${route} does not redirect to sign-in`);

        await page.getByRole("heading", { name: heading, level: 1 }).waitFor();
        await page.getByText("Last updated: 2026-11-10").waitFor();
        await page.getByText("PraiseLoop, Ontario, Canada").waitFor();
        assert.equal(await page.getByText("Sign in to see your posts").count(), 0, `${route} must not show the sign-in wall`);
        assert.ok((await page.getByRole("link", { name: "Privacy" }).first().getAttribute("href"))?.includes("/privacy"));
        assert.ok((await page.getByRole("link", { name: "Terms" }).first().getAttribute("href"))?.includes("/terms"));
        assert.ok((await page.getByRole("link", { name: "Support" }).first().getAttribute("href"))?.includes("/support"));
        assert.ok((await page.locator("main").innerText()).includes("admin@praiseloop.ca"), `${route} names the contact address`);

        const layout = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
        assert.ok(layout.scrollWidth <= layout.innerWidth, `${route} overflows at 390px: ${layout.scrollWidth} > ${layout.innerWidth}`);
      }

      // The privacy policy and terms are reachable from each other without a session.
      await page.goto(`${base}/privacy`);
      await page.getByRole("link", { name: "Terms", exact: true }).click();
      await page.getByRole("heading", { name: "Terms of Service", level: 1 }).waitFor();
      assert.equal(new URL(page.url()).pathname, "/terms");

      // A plain HTTP request (no browser) also gets the page, as the app stores and
      // Meta/Google review checks will see it.
      for (const route of ["/privacy", "/terms", "/support"]) {
        const response = await fetch(`${base}${route}`, { redirect: "manual" });
        assert.equal(response.status, 200, `${route} is public over HTTP`);
        assert.match(response.headers.get("content-type") ?? "", /text\/html/);
        const html = await response.text();
        assert.ok(html.includes("Last updated") && html.includes("2026-11-10"), `${route} serves the dated copy`);
        assert.ok(html.includes("admin@praiseloop.ca"), `${route} serves the contact address`);
      }

      await context.close();
      console.log("Public legal pages render signed out at phone width: /privacy, /terms and /support");
    } finally {
      await browser.close();
    }
  });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
