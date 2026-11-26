import assert from "node:assert/strict";
import {
  DEFAULT_EMAIL_THROTTLE,
  DEV_EMAIL_FROM,
  EmailError,
  EmailThrottle,
  clearEmailOutbox,
  emailOutbox,
  fakeEmailTransport,
  getEmailTransport,
  oneTimeCodeEmail,
  sendEmail,
} from "../lib/email";

const ENV_KEYS = ["NODE_ENV", "EMAIL_TRANSPORT", "EMAIL_FROM", "RESEND_API_KEY"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const realFetch = globalThis.fetch;
const realConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
const API_KEY = "re_synthetic_key_never_log_me";
const FROM = "Praise Loop <no-reply@praiseloop.invalid>";

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
  for (const key of ENV_KEYS) {
    if (!(key in values)) continue;
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else (process.env as Record<string, string | undefined>)[key] = value;
  }
}

function isEmailError(code: EmailError["code"]) {
  return (error: unknown) => error instanceof EmailError && error.code === code;
}

function freshThrottle(overrides: Partial<typeof DEFAULT_EMAIL_THROTTLE> = {}) {
  return new EmailThrottle({ perRecipient: 10, perSender: 100, windowMs: 60_000, ...overrides });
}

async function main() {
  const networkCalls: string[] = [];
  const noNetwork = () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      networkCalls.push(String(input));
      return Promise.reject(new Error("network disabled in tests"));
    }) as typeof fetch;
  };

  // --- Default is the fake transport outside production; nothing is sent. ---
  noNetwork();
  clearEmailOutbox();
  setEnv({ NODE_ENV: "development", EMAIL_TRANSPORT: undefined, EMAIL_FROM: undefined, RESEND_API_KEY: undefined });
  assert.equal(getEmailTransport().name, "fake");
  assert.equal(getEmailTransport().from, DEV_EMAIL_FROM);
  // Compose materializes unset variables as empty strings; blank is the default.
  setEnv({ EMAIL_TRANSPORT: "" });
  assert.equal(getEmailTransport().name, "fake");

  const outboxLogs: string[] = [];
  const fake = fakeEmailTransport({ logger: (line) => outboxLogs.push(line) });
  const delivery = await sendEmail(
    { to: "Owner@Example.invalid", ...oneTimeCodeEmail("123456") },
    { transport: fake, throttle: freshThrottle() },
  );
  assert.deepEqual([delivery.transport, delivery.accepted], ["fake", true]);
  assert.equal(networkCalls.length, 0, "the fake transport must not touch the network");
  const recorded = emailOutbox();
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].to, "Owner@Example.invalid");
  assert.equal(recorded[0].from, DEV_EMAIL_FROM);
  assert.match(recorded[0].text, /123456/);
  assert.match(outboxLogs[0], /email_outbox/);
  assert.match(outboxLogs[0], /123456/, "the dev outbox must show the code");
  assert.doesNotMatch(outboxLogs.join("\n"), /synthetic_key/, "no configuration is logged");

  // --- Template: plain text, short, code in the body only. ---
  const template = oneTimeCodeEmail("123456", { minutes: 10 });
  assert.equal(template.subject, "Your Praise Loop sign-in code");
  assert.doesNotMatch(template.subject, /123456/);
  assert.match(template.text, /123456/);
  assert.match(template.text, /10 minutes/);
  assert.doesNotMatch(template.text, /https?:|<img|<a\s/i);
  assert.ok(template.text.length < 300);
  assert.throws(() => oneTimeCodeEmail("12345"), isEmailError("email_invalid"));
  assert.throws(() => oneTimeCodeEmail("1234567"), isEmailError("email_invalid"));
  assert.throws(() => oneTimeCodeEmail("123456", { minutes: 0 }), isEmailError("email_invalid"));

  // --- Throttle per recipient, case-insensitive, with a sliding window. ---
  let clock = Date.parse("2026-10-30T12:00:00Z");
  const clockThrottle = new EmailThrottle({ perRecipient: 3, perSender: 10, windowMs: 60_000 }, () => clock);
  const quietFake = fakeEmailTransport({ logger: () => {} });
  const codeMessage = { to: "code@example.invalid", subject: "Code", text: "Synthetic body" };
  for (let attempt = 0; attempt < 3; attempt++) {
    await sendEmail(codeMessage, { transport: quietFake, throttle: clockThrottle, from: FROM });
  }
  const beforeThrottle = emailOutbox().length;
  await assert.rejects(
    sendEmail(codeMessage, { transport: quietFake, throttle: clockThrottle, from: FROM }),
    isEmailError("email_throttled"),
  );
  assert.equal(emailOutbox().length, beforeThrottle, "a throttled message is not recorded or sent");
  await assert.rejects(
    sendEmail({ ...codeMessage, to: "CODE@example.invalid" }, { transport: quietFake, throttle: clockThrottle, from: FROM }),
    isEmailError("email_throttled"),
    "recipient casing must not dodge the budget",
  );
  await sendEmail({ ...codeMessage, to: "someone-else@example.invalid" }, { transport: quietFake, throttle: clockThrottle, from: FROM });
  clock += 60_001;
  await sendEmail(codeMessage, { transport: quietFake, throttle: clockThrottle, from: FROM });
  await sendEmail({ ...codeMessage, to: "third@example.invalid" }, { transport: quietFake, throttle: clockThrottle, from: FROM });
  // The recipient budget above recovered after the window, so only the sender limit can trip.
  const senderThrottle = new EmailThrottle({ perRecipient: 10, perSender: 2, windowMs: 60_000 }, () => clock);
  for (let attempt = 0; attempt < 2; attempt++) {
    await sendEmail({ to: `sender-${attempt}@example.invalid`, subject: "Code", text: "Synthetic body" }, { transport: quietFake, throttle: senderThrottle, from: FROM });
  }
  await assert.rejects(
    sendEmail({ to: "sender-2@example.invalid", subject: "Code", text: "Synthetic body" }, { transport: quietFake, throttle: senderThrottle, from: FROM }),
    isEmailError("email_throttled"),
  );

  // --- A rejected new recipient is not retained; the map is capped and swept. ---
  const small = new EmailThrottle({ perRecipient: 10, perSender: 1, windowMs: 60_000, maxRecipientKeys: 5 }, () => clock);
  await sendEmail({ to: "kept@example.invalid", subject: "Code", text: "Synthetic body" }, { transport: quietFake, throttle: small, from: FROM });
  await assert.rejects(
    sendEmail({ to: "rejected@example.invalid", subject: "Code", text: "Synthetic body" }, { transport: quietFake, throttle: small, from: FROM }),
    isEmailError("email_throttled"),
  );
  const hitsOf = (throttle: EmailThrottle) => (throttle as unknown as { hits: Map<string, number[]> }).hits;
  assert.equal(hitsOf(small).size, 2, "a rejected recipient must not add a map entry");

  let sweepClock = Date.parse("2026-11-02T08:00:00Z");
  const bounded = new EmailThrottle({ perRecipient: 100, perSender: 1000, windowMs: 60_000, maxRecipientKeys: 3 }, () => sweepClock);
  for (let attempt = 0; attempt < 20; attempt++) {
    await sendEmail({ to: `bulk-${attempt}@example.invalid`, subject: "Code", text: "Synthetic body" }, { transport: quietFake, throttle: bounded, from: FROM });
  }
  assert.ok(hitsOf(bounded).size <= 4, `recipient map grew to ${hitsOf(bounded).size}`);
  sweepClock += 60_001;
  await sendEmail({ to: "after-window@example.invalid", subject: "Code", text: "Synthetic body" }, { transport: quietFake, throttle: bounded, from: FROM });
  assert.ok(hitsOf(bounded).size <= 2, `expired recipients were retained (${hitsOf(bounded).size} keys)`);

  // --- Invalid input never reaches a transport. ---
  for (const message of [
    { to: "a@example.invalid\r\nBcc: victim@example.invalid", subject: "Code", text: "Synthetic body" },
    { to: "a@example.invalid, b@example.invalid", subject: "Code", text: "Synthetic body" },
    { to: "not-an-address", subject: "Code", text: "Synthetic body" },
    { to: "a@example.invalid", subject: "Code\r\nBcc: victim@example.invalid", text: "Synthetic body" },
    { to: "a@example.invalid", subject: "", text: "Synthetic body" },
    { to: "a@example.invalid", subject: "Code", text: "   " },
  ]) {
    await assert.rejects(
      sendEmail(message, { transport: quietFake, throttle: freshThrottle(), from: FROM }),
      isEmailError("email_invalid"),
    );
  }

  // --- Missing configuration fails closed with a clear message. ---
  setEnv({ NODE_ENV: "production", EMAIL_TRANSPORT: undefined, EMAIL_FROM: undefined, RESEND_API_KEY: undefined });
  assert.throws(
    () => getEmailTransport(),
    (error: unknown) =>
      error instanceof EmailError &&
      error.code === "email_unavailable" &&
      /EMAIL_FROM/.test(error.message) &&
      /RESEND_API_KEY/.test(error.message),
  );
  await assert.rejects(
    sendEmail({ to: "a@example.invalid", subject: "Code", text: "Synthetic body" }),
    isEmailError("email_unavailable"),
  );
  // A blank setting from Compose must still mean "use the production default".
  setEnv({ EMAIL_TRANSPORT: "" });
  assert.throws(() => getEmailTransport(), /EMAIL_FROM/);
  setEnv({ EMAIL_TRANSPORT: "resend", EMAIL_FROM: FROM });
  assert.throws(() => getEmailTransport(), /RESEND_API_KEY/);
  setEnv({ EMAIL_TRANSPORT: "fake" });
  assert.throws(() => getEmailTransport(), /not allowed in production/);
  setEnv({ EMAIL_TRANSPORT: "mailgun", RESEND_API_KEY: API_KEY });
  assert.throws(() => getEmailTransport(), /EMAIL_TRANSPORT/);
  assert.equal(networkCalls.length, 0, "a missing or invalid configuration must not call the provider");

  // --- Resend adapter contract against a mocked fetch. ---
  setEnv({ NODE_ENV: "production", EMAIL_TRANSPORT: "resend", EMAIL_FROM: FROM, RESEND_API_KEY: API_KEY });
  const logs: string[] = [];
  console.log = console.info = console.warn = console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ id: "resend-message-1" }), { status: 200 });
    }) as typeof fetch;

    const sent = await sendEmail(
      { to: "owner@example.invalid", ...oneTimeCodeEmail("482913") },
      { throttle: freshThrottle(), idempotencyKey: "signin-482913" },
    );
    assert.deepEqual([sent.transport, sent.accepted, sent.id], ["resend", true, "resend-message-1"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.resend.com/emails");
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${API_KEY}`);
    assert.equal(headers["idempotency-key"], "signin-482913");
    const body = JSON.parse(String(calls[0].init.body));
    assert.deepEqual(body.to, ["owner@example.invalid"]);
    assert.equal(body.from, FROM);
    assert.equal(body.subject, "Your Praise Loop sign-in code");
    assert.match(body.text, /482913/);
    assert.equal(body.html, undefined, "plain text only, no HTML or tracking");
    assert.doesNotMatch(logs.join("\n"), /re_synthetic_key_never_log_me|owner@example\.invalid/);

    // The seeded demo owners' reserved domain never reaches Resend (#300).
    const demo = await sendEmail(
      { to: "demo-business@praiseloop.invalid", ...oneTimeCodeEmail("482913") },
      { throttle: freshThrottle() },
    );
    assert.deepEqual([demo.transport, demo.accepted], ["resend", false]);
    assert.equal(calls.length, 1, "no request for a demo owner address");

    const providerError = async (status: number, code: EmailError["code"], headers?: Record<string, string>, name?: string) => {
      globalThis.fetch = (async () => new Response(JSON.stringify({ name, message: "synthetic provider detail" }), { status, headers })) as typeof fetch;
      await assert.rejects(
        sendEmail({ to: "owner@example.invalid", subject: "Code", text: "Synthetic body" }, { throttle: freshThrottle() }),
        (error: unknown) =>
          error instanceof EmailError &&
          error.code === code &&
          !error.message.includes("owner@example.invalid") &&
          !error.message.includes("synthetic provider detail") &&
          !error.message.includes(API_KEY),
      );
    };
    globalThis.fetch = (async () => new Response("{}", { status: 429, headers: { "retry-after": "30" } })) as typeof fetch;
    await assert.rejects(
      sendEmail({ to: "owner@example.invalid", subject: "Code", text: "Synthetic body" }, { throttle: freshThrottle() }),
      (error: unknown) => error instanceof EmailError && error.code === "email_throttled" && error.retryAfterMs === 30_000,
    );
    await providerError(401, "email_auth");
    await providerError(403, "email_sender");
    await providerError(403, "email_sender", undefined, "validation_error");
    await providerError(403, "email_auth", undefined, "restricted_api_key");
    await providerError(403, "email_auth", undefined, "suspended_api_key");
    await providerError(422, "email_invalid");
    await providerError(500, "email_provider");
    await providerError(503, "email_provider");

    globalThis.fetch = (async () => {
      throw Object.assign(new Error("synthetic timeout"), { name: "TimeoutError" });
    }) as typeof fetch;
    await assert.rejects(
      sendEmail({ to: "owner@example.invalid", subject: "Code", text: "Synthetic body" }, { throttle: freshThrottle() }),
      isEmailError("email_timeout"),
    );
    assert.doesNotMatch(logs.join("\n"), /re_synthetic_key_never_log_me/);
  } finally {
    console.log = realConsole.log;
    console.info = realConsole.info;
    console.warn = realConsole.warn;
    console.error = realConsole.error;
  }

  // --- Restore the process for any suite that runs after this one. ---
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else (process.env as Record<string, string | undefined>)[key] = value;
  }
  globalThis.fetch = realFetch;
  clearEmailOutbox();

  console.log("email fake transport, templates, throttle, config and Resend contract tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
