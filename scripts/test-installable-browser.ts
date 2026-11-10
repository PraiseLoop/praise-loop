import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { databaseFixture } from "./db-fixture";
import { webFixture } from "./web-fixture";
import { sessionHash } from "../lib/auth-adapter";
import { INSTALL_HINT_DISMISSED_KEY } from "../lib/installHint";

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36";
const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";

// The installed-app surface (#273): a public manifest and icons, iOS meta tags,
// and the Add to Home Screen hint on real phone browsers.
async function main() {
  if (process.env.TEST_BROWSER !== "1") { console.log("Installable web app browser test skipped: build and set TEST_BROWSER/TEST_DATABASE_URL"); return; }
  await databaseFixture(async (c) => {
    await c.query("INSERT INTO auth_users(id,email) VALUES('install-owner','install-owner@example.invalid')");
    await c.query("INSERT INTO auth_sessions VALUES($1,'install-owner',now()+interval '1 hour')", [sessionHash("install-session")]);
    await c.query("INSERT INTO businesses(name,timezone,owner_id) VALUES('Synthetic install','UTC','install-owner')");

    const launch = () => chromium.launch({ executablePath: process.env.CHROMIUM_PATH === "playwright" ? undefined : process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
    const signedIn = async (base: string, userAgent: string, mobile: boolean) => {
      const browser = await launch();
      const context = await browser.newContext({ userAgent, viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 3 : 1 });
      await context.addCookies([{ name: "next-auth.session-token", value: "install-session", url: base }]);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", e => errors.push(String(e)));
      return { browser, context, page, errors };
    };

    await webFixture(async (base) => {
      // Public, anonymous assets: no session needed.
      const manifestResponse = await fetch(`${base}/manifest.webmanifest`);
      assert.equal(manifestResponse.status, 200);
      assert.match(manifestResponse.headers.get("content-type") ?? "", /^application\/manifest\+json/);
      const manifest = await manifestResponse.json();
      assert.equal(manifest.name, "PraiseLoop");
      assert.equal(manifest.start_url, "/approval");
      assert.equal(manifest.display, "standalone");
      assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 3);
      for (const icon of manifest.icons) assert.equal((await fetch(`${base}${icon.src}`)).status, 200, `${icon.src} is public`);
      assert.equal((await fetch(`${base}/apple-touch-icon.png`)).status, 200);
      const worker = await fetch(`${base}/sw.js`);
      assert.equal(worker.status, 200);
      assert.match(worker.headers.get("content-type") ?? "", /javascript/);

      // Next links the manifest and emits the iOS install tags.
      const html = await (await fetch(base)).text();
      assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/);
      assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png"/);
      assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes"/);
      assert.match(html, /<meta name="theme-color" content="#0E5A48"/);

      // iPhone Safari: instructions, then dismissal is remembered across reloads.
      const iphone = await signedIn(base, IPHONE_UA, true);
      try {
        await iphone.page.goto(`${base}/approval`);
        await iphone.page.getByText("Add PraiseLoop to your home screen").waitFor();
        await iphone.page.getByText(/Tap the Share button/).waitFor();
        await iphone.page.getByRole("button", { name: "Got it" }).click();
        assert.equal(await iphone.page.evaluate(key => localStorage.getItem(key), INSTALL_HINT_DISMISSED_KEY), "1");
        await iphone.page.reload();
        await iphone.page.getByRole("navigation").first().waitFor();
        assert.equal(await iphone.page.getByText("Add PraiseLoop to your home screen").count(), 0, "dismissal is not forgotten on reload");
        assert.deepEqual(iphone.errors, []);
      } finally { await iphone.browser.close(); }

      // Android: the hint waits for beforeinstallprompt and the button uses it.
      const android = await signedIn(base, ANDROID_UA, true);
      try {
        await android.page.goto(`${base}/approval`);
        await android.page.getByRole("navigation").first().waitFor();
        assert.equal(await android.page.getByText("Add PraiseLoop to your home screen").count(), 0, "no hint before the browser offers a prompt");
        await android.page.evaluate(() => {
          const event = new Event("beforeinstallprompt", { cancelable: true });
          Object.defineProperty(event, "prompt", { value: async () => { (window as unknown as { __prompted: boolean }).__prompted = true; } });
          Object.defineProperty(event, "userChoice", { value: Promise.resolve({ outcome: "accepted" }) });
          window.dispatchEvent(event);
        });
        await android.page.getByText("Add PraiseLoop to your home screen").waitFor();
        await android.page.getByRole("button", { name: "Install", exact: true }).click();
        assert.equal(await android.page.evaluate(() => Boolean((window as unknown as { __prompted?: boolean }).__prompted)), true);
        assert.equal(await android.page.evaluate(key => localStorage.getItem(key), INSTALL_HINT_DISMISSED_KEY), "1");
        assert.deepEqual(android.errors, []);
      } finally { await android.browser.close(); }

      // A desktop browser and a signed-out phone never see the hint.
      const desktop = await signedIn(base, DESKTOP_UA, false);
      try {
        await desktop.page.goto(`${base}/approval`);
        await desktop.page.getByRole("navigation").first().waitFor();
        assert.equal(await desktop.page.getByText("Add PraiseLoop to your home screen").count(), 0);
      } finally { await desktop.browser.close(); }

      const browser = await launch();
      try {
        const context = await browser.newContext({ userAgent: IPHONE_UA, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
        const page = await context.newPage();
        await page.goto(`${base}/approval`);
        // A signed-out /approval sends the visitor to the landing sign-in page.
        await page.getByRole("button", { name: /Continue with Google/ }).first().waitFor();
        assert.equal(await page.getByText("Add PraiseLoop to your home screen").count(), 0, "signed-out visitors are not asked to install");
      } finally { await browser.close(); }
    });
  });
  console.log("Chromium installable web app manifest, icons and Add to Home Screen hint passed");
}
void main();
