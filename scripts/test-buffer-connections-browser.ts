import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright-core";
import { databaseFixture } from "./db-fixture";
import { webFixture } from "./web-fixture";
import { sessionHash } from "../lib/auth-adapter";

// Walks the web Buffer connections screen (#29 part 2) against a production
// build: the not-connected state, a 503 connect attempt, the callback outcome
// banner and the profile menu link. Synthetic owner and session only, and no
// Buffer call is possible: the client id is blank for this server.
async function main() {
  if (process.env.TEST_BROWSER !== "1") { console.log("Buffer connections browser skipped: build and set TEST_BROWSER/TEST_DATABASE_URL"); return; }
  await databaseFixture(async c => {
    await c.query("INSERT INTO auth_users(id,name,email) VALUES('buffer-browser','Synthetic Buffer Owner','buffer-browser@example.invalid')");
    await c.query("INSERT INTO owner_plans(owner_id,plan,source) VALUES('buffer-browser','pro','manual')");
    await c.query("INSERT INTO auth_sessions VALUES($1,'buffer-browser',now()+interval '1 hour')", [sessionHash("buffer-browser-session")]);

    // Never call the real Buffer API. An empty client id makes connect answer 503.
    process.env.BUFFER_CLIENT_ID = "";
    process.env.BUFFER_CLIENT_SECRET = "";
    // Keep the Meta section in its honest "not available" state for this walkthrough.
    process.env.META_APP_ID = "";
    process.env.META_APP_SECRET = "";

    await webFixture(async base => {
      const browser: Browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH === "playwright" ? undefined : process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
      try {
        const context = await browser.newContext();
        await context.addCookies([{ name: "next-auth.session-token", value: "buffer-browser-session", url: base }]);
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", error => pageErrors.push(error.message));

        // Not connected: explanation and a Connect button, no Buffer request yet.
        await page.goto(`${base}/connections`);
        await page.getByRole("heading", { name: "Connections" }).waitFor();
        await page.getByText(/Buffer can publish your approved posts/).waitFor();
        const connectButton = page.getByRole("button", { name: "Connect Buffer" });
        await connectButton.waitFor();

        // Buffer is not configured on this server, so connect answers 503 and the
        // page says so instead of sending the owner anywhere.
        const connectResponse = page.waitForResponse(response => response.url().endsWith("/api/buffer/connect") && response.request().method() === "POST");
        await connectButton.click();
        assert.equal((await connectResponse).status(), 503, "connect fails closed without Buffer config");
        await page.getByText(/Buffer isn.t set up on this server yet/).waitFor();

        // The callback outcome is shown once and the code leaves the address bar.
        await page.goto(`${base}/connections?buffer=denied`);
        await page.getByText(/You didn.t approve the connection in Buffer/).waitFor();
        assert.equal(new URL(page.url()).search, "", "the outcome query string is removed");

        // An unknown outcome shows nothing.
        await page.goto(`${base}/connections?buffer=not-a-real-outcome`);
        await page.getByRole("heading", { name: "Connections" }).waitFor();
        await page.getByRole("button", { name: "Connect Buffer" }).waitFor();
        assert.equal(await page.locator(".pl-banner").count(), 0, "an unknown outcome shows no banner");
        assert.equal(new URL(page.url()).search, "", "the unknown outcome is also removed");

        // The profile menu links to the page.
        await page.goto(`${base}/approval`);
        await page.getByRole("button", { name: /^Profile:/ }).click();
        await page.getByRole("link", { name: "Connections", exact: true }).click();
        await page.waitForURL(`${base}/connections`);
        await page.getByRole("heading", { name: "Connections" }).waitFor();

        assert.deepEqual(pageErrors, []);
        console.log(JSON.stringify({ event: "synthetic_buffer_connections_walkthrough", sessionMode: "synthetic", bufferCalls: 0, outcomes: ["denied", "unknown"] }));
      } finally { await browser.close(); }
    });
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
