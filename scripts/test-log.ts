import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { ownerRoute } from "../lib/authorization";
import { errorFields, isDevLogging, logAt, logLevel, logTick, safeFields, scrub } from "../lib/log";

// The logger (docs/development.md, "Logging"): two modes, and nothing sensitive in either.
async function main() {
  // Mode and level. Unset means production (quiet); only dev/development is verbose; LOG_LEVEL wins.
  assert.equal(logLevel({}), "info");
  assert.equal(logLevel({ APP_ENV: "prod" }), "info");
  assert.equal(logLevel({ APP_ENV: "production" }), "info");
  assert.equal(logLevel({ APP_ENV: "staging" }), "info", "an unknown mode is not verbose");
  assert.equal(logLevel({ APP_ENV: "dev" }), "debug");
  assert.equal(logLevel({ APP_ENV: " Development " }), "debug");
  assert.equal(logLevel({ APP_ENV: "dev", LOG_LEVEL: "warn" }), "warn", "LOG_LEVEL overrides the mode");
  assert.equal(logLevel({ APP_ENV: "prod", LOG_LEVEL: "DEBUG" }), "debug");
  assert.equal(logLevel({ LOG_LEVEL: "loud" }), "info", "an invalid level falls back to the mode");
  assert.equal(isDevLogging({ APP_ENV: "dev" }), true);
  assert.equal(isDevLogging({}), false);

  // What each mode prints.
  const run = (env: Record<string, string>) => {
    const out: { line: string; level: string }[] = [];
    const write = (line: string, level: string) => out.push({ line, level });
    for (const level of ["debug", "info", "warn", "error"] as const) logAt(level, `e_${level}`, { n: 1 }, env, write);
    return out.map((o) => `${JSON.parse(o.line).event}:${o.level}`);
  };
  assert.deepEqual(run({}), ["e_info:info", "e_warn:warn", "e_error:error"], "production is quiet");
  assert.deepEqual(run({ APP_ENV: "dev" }), ["e_debug:debug", "e_info:info", "e_warn:warn", "e_error:error"], "development shows everything");
  assert.deepEqual(run({ LOG_LEVEL: "error" }), ["e_error:error"]);
  const line = JSON.parse((() => { let l = ""; logAt("info", "x", { a: 1 }, {}, (s) => { l = s; }); return l; })());
  assert.deepEqual([line.event, line.level, line.a, typeof line.ts], ["x", "info", 1, "string"]);

  // Sensitive fields are redacted by name, whatever the value.
  const redacted = safeFields({
    token: "abc", access_token: "abc", refreshToken: "abc", client_secret: "abc", clientSecret: "abc", password: "abc",
    authorization: "Bearer abc", cookie: "a=b", verifier: "abc", code: "abc", state: "abc", caption: "Thanks!", captionText: "Thanks!",
    quote: "Great", quote_text: "Great", email: "a@example.invalid", body: "{}", credential: "abc", apiKey: "abc", sessionToken: "abc",
    draftId: 7, status: 200, mode: "draft", ok: true
  });
  for (const key of Object.keys(redacted)) {
    if (["draftId", "status", "mode", "ok"].includes(key)) continue;
    assert.equal(redacted[key], "[redacted]", `${key} is redacted`);
  }
  assert.deepEqual([redacted.draftId, redacted.status, redacted.mode, redacted.ok], [7, 200, "draft", true], "ordinary fields pass through");
  // A careless call site still cannot leak a token-like value, and long text is cut.
  const token = "A".repeat(43);
  assert.equal(safeFields({ note: `failed for ${token} twice` }).note, "failed for [redacted] twice");
  assert.equal(scrub("x".repeat(500)).length <= 200, true);
  assert.equal(safeFields({ n: "e".repeat(32) }).n, "[redacted]", "even a 32-character value");
  // Only primitives and short lists of primitives are kept; objects are not expanded.
  assert.deepEqual(safeFields({ nested: { a: 1 }, list: [1, "b", { c: 2 }], missing: undefined }), { nested: "[object]", list: [1, "b", "[object]"] });
  assert.equal((safeFields({ list: Array.from({ length: 50 }, (_, i) => i) }).list as unknown[]).length, 20);

  // Errors: name and code always; message only in development, and scrubbed.
  const failure = Object.assign(new Error(`connect failed for ${token}`), { code: "ECONNRESET" });
  assert.deepEqual(errorFields(failure, {}), { errorName: "Error", errorCode: "ECONNRESET" });
  assert.deepEqual(errorFields(failure, { APP_ENV: "dev" }), { errorName: "Error", errorCode: "ECONNRESET", errorMessage: "connect failed for [redacted]" });
  assert.deepEqual(errorFields("plain string", {}), { errorName: "string" }, "a thrown string is not logged");

  // Ticks: quiet when nothing happened, info when something did.
  const seen: string[] = [];
  const realLog = console.log;
  console.log = (l?: unknown) => { seen.push(String(l)); };
  try {
    const saved = process.env.APP_ENV;
    process.env.APP_ENV = "prod";
    logTick("idle_tick", { drafted: 0, mode: "off" });
    assert.deepEqual(seen, [], "an idle tick prints nothing in production");
    logTick("busy_tick", { drafted: 2, mode: "draft" });
    assert.equal(seen.length, 1);
    assert.equal(JSON.parse(seen[0]).event, "busy_tick");
    process.env.APP_ENV = "dev";
    logTick("idle_tick", { drafted: 0 });
    assert.equal(seen.length, 2, "an idle tick prints in development");
    if (saved === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = saved;
  } finally {
    console.log = realLog;
  }
  // Every API request is one development line: method, path, status, time. Never the query, headers or cookies.
  const lines: string[] = [];
  const realOut = console.log;
  console.log = (l?: unknown) => { lines.push(String(l)); };
  const savedEnv = process.env.APP_ENV;
  try {
    process.env.APP_ENV = "dev";
    const route = ownerRoute(async () => new Response("{}"));
    const response = await route(new NextRequest("http://localhost/api/drafts?businessId=1&token=QUERYSECRET1234567890", { headers: { authorization: "Bearer HEADERSECRET", cookie: "x=COOKIESECRET" } }));
    assert.equal(response.status, 401);
    process.env.APP_ENV = "prod";
    await route(new NextRequest("http://localhost/api/drafts"));
  } finally {
    console.log = realOut;
    if (savedEnv === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = savedEnv;
  }
  assert.equal(lines.length, 1, "one line in development, none in production");
  const request = JSON.parse(lines[0]);
  assert.deepEqual([request.event, request.method, request.path, request.status, request.refused], ["request", "GET", "/api/drafts", 401, "Sign in to access your business"]);
  assert.ok(!lines[0].includes("QUERYSECRET") && !lines[0].includes("HEADERSECRET") && !lines[0].includes("COOKIESECRET"), "no query, header or cookie value reaches the log");
  console.log("logger mode, level, redaction and error tests passed");
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
