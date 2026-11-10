import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  BREACH_CHECK_TIMEOUT_MS,
  BREACH_RANGE_URL,
  BREACHED_PASSWORD_MESSAGE,
  checkPasswordBreach,
  passwordBreachCheckEnabled,
  setPasswordBreachFetcherForTests
} from "../lib/passwordBreach";

// Breached-password check (#286). Every case injects a fake fetcher; no test
// calls the real Have I Been Pwned service.

const PASSWORD = "synthetic-breach-check-password-286";
// codeql[js/insufficient-password-hash]
const SHA1 = createHash("sha1").update(PASSWORD, "utf8").digest("hex").toUpperCase();
const PREFIX = SHA1.slice(0, 5);
const SUFFIX = SHA1.slice(5);

type Call = { url: string; init?: RequestInit };

function fakeFetch(calls: Call[], respond: (url: string) => Promise<Response> | Response): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond(String(url));
  }) as unknown as typeof fetch;
}

function rangeBody(suffix: string, count: number, extra = ""): string {
  return `${suffix}:${count}\r\n${extra}0000000000000000000000000000000000:0\r\n`;
}

function captureLogs() {
  const lines: string[] = [];
  const original = { log: console.log, error: console.error };
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  return {
    lines,
    restore() { console.log = original.log; console.error = original.error; }
  };
}

async function main() {
  process.env.LOG_LEVEL = "debug";
  const savedNodeEnv = process.env.NODE_ENV;
  const savedSwitch = process.env.PASSWORD_BREACH_CHECK;
  (process.env as Record<string, string | undefined>).NODE_ENV = "development";
  delete process.env.PASSWORD_BREACH_CHECK;

  try {
    // --- Switch ---------------------------------------------------------
    assert.equal(passwordBreachCheckEnabled({ NODE_ENV: "production" }), true, "on by default in production");
    assert.equal(passwordBreachCheckEnabled({ NODE_ENV: "development" }), false, "off by default in development");
    assert.equal(passwordBreachCheckEnabled({ NODE_ENV: "test" }), false, "off by default in tests");
    assert.equal(passwordBreachCheckEnabled({ NODE_ENV: "production", PASSWORD_BREACH_CHECK: "off" }), false);
    assert.equal(passwordBreachCheckEnabled({ NODE_ENV: "development", PASSWORD_BREACH_CHECK: "on" }), true);
    assert.equal(passwordBreachCheckEnabled({ PASSWORD_BREACH_CHECK: "TRUE" }), true);
    assert.equal(passwordBreachCheckEnabled({ PASSWORD_BREACH_CHECK: "0" }), false);
    assert.equal(passwordBreachCheckEnabled({ PASSWORD_BREACH_CHECK: "not-a-switch", NODE_ENV: "development" }), false);

    // --- Only the five-character prefix leaves the server ----------------
    const calls: Call[] = [];
    const clear = await checkPasswordBreach(PASSWORD, {
      env: { PASSWORD_BREACH_CHECK: "on" },
      fetcher: fakeFetch(calls, () => new Response(rangeBody("0000000000000000000000000000000000", 1)))
    });
    assert.equal(clear, "clear");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BREACH_RANGE_URL}${PREFIX}`, "the request carries exactly the five-hex prefix");
    const path = new URL(calls[0].url).pathname;
    assert.match(path.split("/").pop()!, /^[0-9A-F]{5}$/);
    assert.ok(!calls[0].url.includes(SUFFIX), "the remaining 35 characters never leave the server");
    assert.equal(calls[0].url, calls[0].url.split("?")[0], "no query string");
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers["Add-Padding"], "true");
    assert.equal(headers["User-Agent"], "PraiseLoop");
    assert.ok(!JSON.stringify(headers).includes("@"));

    // --- A matching suffix with a positive count is a breach ------------
    const breached = await checkPasswordBreach(PASSWORD, {
      env: { PASSWORD_BREACH_CHECK: "on" },
      fetcher: fakeFetch([], () => new Response(rangeBody(SUFFIX, 7)))
    });
    assert.equal(breached, "breached");
    assert.equal(BREACHED_PASSWORD_MESSAGE, "This password has appeared in a data breach. Choose a different one.");

    // --- Add-Padding entries with count 0 are ignored -------------------
    const padded = await checkPasswordBreach(PASSWORD, {
      env: { PASSWORD_BREACH_CHECK: "on" },
      fetcher: fakeFetch([], () => new Response(rangeBody(SUFFIX, 0)))
    });
    assert.equal(padded, "clear", "a zero-count padding entry is not a breach");
    const mixed = await checkPasswordBreach(PASSWORD, {
      env: { PASSWORD_BREACH_CHECK: "on" },
      fetcher: fakeFetch([], () => new Response(rangeBody(SUFFIX, 0, `${SUFFIX}:3\r\n`)))
    });
    assert.equal(mixed, "breached", "any positive entry for the suffix counts");

    // --- Timeout and HTTP errors fail open, without the password --------
    const captured = captureLogs();
    try {
      const timedOut = await checkPasswordBreach(PASSWORD, {
        env: { PASSWORD_BREACH_CHECK: "on" },
        timeoutMs: 20,
        fetcher: (async (_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        })) as unknown as typeof fetch
      });
      assert.equal(timedOut, "unavailable");
      assert.ok(BREACH_CHECK_TIMEOUT_MS >= 1000 && BREACH_CHECK_TIMEOUT_MS <= 3000, "the production timeout stays short");

      const httpError = await checkPasswordBreach(PASSWORD, {
        env: { PASSWORD_BREACH_CHECK: "on" },
        fetcher: fakeFetch([], () => new Response("unavailable", { status: 503 }))
      });
      assert.equal(httpError, "unavailable");

      const networkError = await checkPasswordBreach(PASSWORD, {
        env: { PASSWORD_BREACH_CHECK: "on" },
        fetcher: (async () => { throw new TypeError("synthetic network failure"); }) as unknown as typeof fetch
      });
      assert.equal(networkError, "unavailable");

      const joined = captured.lines.join("\n");
      assert.match(joined, /password_breach_check_unavailable/);
      assert.ok(!joined.includes(PASSWORD), "logs never contain the password");
      assert.ok(!joined.includes(SHA1), "logs never contain the full SHA-1");
      assert.ok(!joined.includes(PREFIX), "logs never contain the prefix");
    } finally {
      captured.restore();
    }

    // --- The switch off skips the lookup entirely -----------------------
    let called = false;
    const disabled = await checkPasswordBreach(PASSWORD, {
      env: { PASSWORD_BREACH_CHECK: "off" },
      fetcher: (async () => { called = true; throw new Error("must not be called"); }) as unknown as typeof fetch
    });
    assert.equal(disabled, "disabled");
    assert.equal(called, false, "no request is made when the switch is off");

    // --- The module-level injection used by route tests ----------------
    const injectedCalls: Call[] = [];
    setPasswordBreachFetcherForTests(fakeFetch(injectedCalls, () => new Response(rangeBody(SUFFIX, 2))));
    try {
      process.env.PASSWORD_BREACH_CHECK = "on";
      assert.equal(await checkPasswordBreach(PASSWORD), "breached");
      assert.equal(injectedCalls.length, 1);
    } finally {
      setPasswordBreachFetcherForTests(null);
      delete process.env.PASSWORD_BREACH_CHECK;
    }
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = savedNodeEnv;
    if (savedSwitch === undefined) delete process.env.PASSWORD_BREACH_CHECK;
    else process.env.PASSWORD_BREACH_CHECK = savedSwitch;
  }

  console.log("password breach-check tests passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
