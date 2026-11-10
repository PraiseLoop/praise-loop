import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { databaseFixture } from "./db-fixture";
import type { PoolClient } from "pg";
import { createMobileSession } from "../lib/mobileSessions";
import { generationWeek } from "../lib/services/generation";
import type { EmailEnvelope, EmailTransport } from "../lib/email";
import { approvalQueueUrl, emailTick, weeklyEmailSettingsUrl, weeklyReadyEmail } from "../lib/services/weeklyEmail";

const ORIGIN = "http://localhost:3000";

function recording(fail = false) {
  const sent: EmailEnvelope[] = [];
  const transport: EmailTransport = {
    name: "fake",
    from: "Praise Loop <no-reply@praiseloop.invalid>",
    async send(envelope) {
      if (fail) throw new Error("synthetic transport failure");
      sent.push(envelope);
      return { transport: "fake", accepted: true, id: `synthetic-${sent.length}` };
    }
  };
  return { sent, transport };
}

async function owner(client: PoolClient, id: string, email: string | null, verified: boolean) {
  await client.query(`INSERT INTO auth_users(id,email,"emailVerified") VALUES($1,$2,$3)`, [id, email, verified ? new Date() : null]);
}

async function business(client: PoolClient, ownerId: string, name: string) {
  return (await client.query("INSERT INTO businesses(name,timezone,owner_id) VALUES($1,'UTC',$2) RETURNING id", [name, ownerId])).rows[0].id as string;
}

// A finished weekly period with `complete` finished jobs and `running` jobs still in flight.
async function period(client: PoolClient, businessId: string, week: string, complete: number, running = 0) {
  await client.query(
    "INSERT INTO generation_periods(business_id,period_start,timezone,target,allocated,completed) VALUES($1,$2,'UTC',$3,$3,$3)",
    [businessId, week, complete + running]
  );
  for (const state of [...Array(complete).fill("complete"), ...Array(running).fill("running")]) {
    const draft = (await client.query(
      "INSERT INTO draft_posts(business_id,quote_text,caption_text,image_path,status) VALUES($1,'SECRET REVIEW QUOTE','SECRET CAPTION','/api/media/x.png','draft') RETURNING id",
      [businessId]
    )).rows[0].id;
    await client.query("INSERT INTO generation_jobs(business_id,period_start,draft_id,state) VALUES($1,$2,$3,$4)", [businessId, week, draft, state]);
  }
}

async function main() {
  process.env.NEXTAUTH_URL = ORIGIN;

  // Pure template rules, testable without Postgres.
  const three = weeklyReadyEmail({
    businessName: "Synthetic Café",
    count: 3,
    queueUrl: approvalQueueUrl(ORIGIN, 42),
    settingsUrl: weeklyEmailSettingsUrl(ORIGIN)
  });
  assert.equal(three.subject, "3 posts are ready to review for Synthetic Café");
  assert.match(three.text, /3 posts are ready to review for Synthetic Café\./);
  assert.match(three.text, /http:\/\/localhost:3000\/approval\?businessId=42/);
  assert.match(three.text, /http:\/\/localhost:3000\/account#weekly-email/);
  assert.doesNotMatch(three.text, /SECRET/);
  const one = weeklyReadyEmail({ businessName: "One\nPost", count: 1, queueUrl: "http://localhost/q", settingsUrl: "http://localhost/a" });
  assert.equal(one.subject, "1 post is ready to review for One Post");
  assert.doesNotMatch(one.subject, /[\r\n]/);
  assert.match(one.text, /1 post is ready/);
  assert.equal(weeklyReadyEmail({ businessName: "", count: 0, queueUrl: "q", settingsUrl: "s" }).subject, "1 post is ready to review for your business");

  await databaseFixture(async client => {
    // A minute ahead keeps the test independent of the database clock and of the
    // day it runs, the same way scripts/test-push.ts does.
    const now = new Date(Date.now() + 60_000);
    const week = generationWeek(now, "UTC");

    // One email per business per period, to the verified owner address, with the queue link.
    await owner(client, "weekly-a", "a@example.invalid", true);
    const ba = await business(client, "weekly-a", "Synthetic A");
    await period(client, ba, week, 3);
    const first = recording();
    const lines: string[] = [];
    const original = { log: console.log, error: console.error };
    const savedLogLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "debug";
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); original.log(...args); };
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); original.error(...args); };
    try {
      assert.deepEqual(await emailTick({ transport: first.transport, now }), { sent: 1 });
      assert.equal(first.sent.length, 1);
      assert.equal(first.sent[0].to, "a@example.invalid");
      assert.equal(first.sent[0].subject, "3 posts are ready to review for Synthetic A");
      assert.match(first.sent[0].text, new RegExp(`/approval\\?businessId=${ba}`));
      assert.equal((await client.query("SELECT count(*)::int n FROM weekly_email_deliveries WHERE business_id=$1", [ba])).rows[0].n, 1);
      // A restart or a second worker sees the claim and sends nothing.
      assert.deepEqual(await emailTick({ transport: recording().transport, now }), { sent: 0 });
      assert.deepEqual(await emailTick({ transport: recording().transport, now: new Date(now.getTime() + 3600000) }), { sent: 0 });
      // Only counts and the business name reach the log, never the address.
      assert.ok(lines.some(line => line.includes("weekly_email_sent")));
      assert.ok(lines.filter(line => line.includes("weekly_email")).every(line => !line.includes("a@example.invalid")));
    } finally {
      console.log = original.log;
      console.error = original.error;
      if (savedLogLevel === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = savedLogLevel;
    }

    // A batch still generating sends nothing; the same period sends once it finishes.
    await owner(client, "weekly-b", "b@example.invalid", true);
    const bb = await business(client, "weekly-b", "Synthetic B");
    await period(client, bb, week, 1, 1);
    const generating = recording();
    assert.deepEqual(await emailTick({ transport: generating.transport, now }), { sent: 0 });
    assert.equal(generating.sent.length, 0);
    await client.query("UPDATE generation_jobs SET state='complete' WHERE business_id=$1 AND state='running'", [bb]);
    assert.deepEqual(await emailTick({ transport: generating.transport, now }), { sent: 1 });
    assert.equal(generating.sent[0].subject, "2 posts are ready to review for Synthetic B");

    // The owner switch is respected: off sends nothing and records no claim.
    await owner(client, "weekly-off", "off@example.invalid", true);
    await client.query("UPDATE auth_users SET weekly_email_enabled=false WHERE id='weekly-off'");
    const boff = await business(client, "weekly-off", "Synthetic Off");
    await period(client, boff, week, 2);
    const off = recording();
    assert.deepEqual(await emailTick({ transport: off.transport, now }), { sent: 0 });
    assert.equal(off.sent.length, 0);
    assert.equal((await client.query("SELECT count(*)::int n FROM weekly_email_deliveries WHERE business_id=$1", [boff])).rows[0].n, 0);

    // No verified address means no send and no claim; adding one lets the next tick send.
    await owner(client, "weekly-unverified", "unverified@example.invalid", false);
    const bun = await business(client, "weekly-unverified", "Synthetic Unverified");
    await period(client, bun, week, 1);
    const unverified = recording();
    assert.deepEqual(await emailTick({ transport: unverified.transport, now }), { sent: 0 });
    assert.equal((await client.query("SELECT count(*)::int n FROM weekly_email_deliveries WHERE business_id=$1", [bun])).rows[0].n, 0);
    await client.query(
      "INSERT INTO auth_accounts(provider,provider_account_id,owner_id,email) VALUES('google','weekly-unverified-sub','weekly-unverified','linked@example.invalid')"
    );
    assert.deepEqual(await emailTick({ transport: unverified.transport, now }), { sent: 1 });
    assert.equal(unverified.sent[0].to, "linked@example.invalid");

    // A transport failure never throws; the attempt is recorded and never retried,
    // and the completed generation itself is untouched.
    await owner(client, "weekly-fail", "fail@example.invalid", true);
    const bfail = await business(client, "weekly-fail", "Synthetic Fail");
    await period(client, bfail, week, 2);
    const failing = recording(true);
    const before = (await client.query("SELECT count(*)::int n FROM generation_jobs WHERE business_id=$1 AND state='complete'", [bfail])).rows[0].n;
    assert.deepEqual(await emailTick({ transport: failing.transport, now }), { sent: 0 });
    assert.deepEqual((await client.query("SELECT state FROM weekly_email_deliveries WHERE business_id=$1", [bfail])).rows[0], { state: "failed" });
    assert.equal((await client.query("SELECT count(*)::int n FROM generation_jobs WHERE business_id=$1 AND state='complete'", [bfail])).rows[0].n, before);
    const retry = recording();
    assert.deepEqual(await emailTick({ transport: retry.transport, now }), { sent: 0 });
    assert.equal(retry.sent.length, 0, "a failed attempt is not repeated for the same period");

    // Two businesses for one owner each get their own email, once.
    await owner(client, "weekly-two", "two@example.invalid", true);
    const btwo1 = await business(client, "weekly-two", "Synthetic Two One");
    const btwo2 = await business(client, "weekly-two", "Synthetic Two Two");
    await period(client, btwo1, week, 1);
    await period(client, btwo2, week, 4);
    const two = recording();
    assert.deepEqual(await emailTick({ transport: two.transport, now }), { sent: 2 });
    assert.deepEqual(two.sent.map(message => message.subject).sort(), [
      "1 post is ready to review for Synthetic Two One",
      "4 posts are ready to review for Synthetic Two Two"
    ]);
    assert.equal((await client.query("SELECT count(*)::int n FROM weekly_email_deliveries WHERE business_id=ANY($1)", [[btwo1, btwo2]])).rows[0].n, 2);

    // Without NEXTAUTH_URL there is no link to send, so nothing is claimed or emailed.
    await owner(client, "weekly-nourl", "nourl@example.invalid", true);
    const bnourl = await business(client, "weekly-nourl", "Synthetic No URL");
    await period(client, bnourl, week, 1);
    const saved = process.env.NEXTAUTH_URL;
    delete process.env.NEXTAUTH_URL;
    try {
      const noUrl = recording();
      assert.deepEqual(await emailTick({ transport: noUrl.transport, now }), { sent: 0 });
      assert.equal(noUrl.sent.length, 0);
      assert.equal((await client.query("SELECT count(*)::int n FROM weekly_email_deliveries WHERE business_id=$1", [bnourl])).rows[0].n, 0);
    } finally {
      process.env.NEXTAUTH_URL = saved;
    }
    // With the base URL back, the skipped period is still unclaimed and sends once.
    const restored = recording();
    assert.deepEqual(await emailTick({ transport: restored.transport, now }), { sent: 1 });
    assert.equal(restored.sent[0].to, "nourl@example.invalid");

    // The account switch reads and writes through the owner-wide API (mobile bearer here).
    const route = require("../app/api/account/preferences/route");
    const session = await createMobileSession("weekly-a");
    const request = (method: string, body?: unknown) => new NextRequest(`${ORIGIN}/api/account/preferences`, {
      method,
      headers: { authorization: `Bearer ${session.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    assert.deepEqual(await (await route.GET(request("GET"))).json(), { weeklyEmailEnabled: true });
    const disabled = await route.PATCH(request("PATCH", { weeklyEmailEnabled: false }));
    assert.equal(disabled.status, 200);
    assert.deepEqual(await disabled.json(), { weeklyEmailEnabled: false });
    assert.equal((await client.query("SELECT weekly_email_enabled FROM auth_users WHERE id='weekly-a'")).rows[0].weekly_email_enabled, false);
    assert.deepEqual(await (await route.GET(request("GET"))).json(), { weeklyEmailEnabled: false });
    assert.equal((await route.PATCH(request("PATCH", { weeklyEmailEnabled: "yes" }))).status, 400);
    assert.equal((await route.PATCH(request("PATCH", {}))).status, 400);
    assert.deepEqual(await (await route.PATCH(request("PATCH", { weeklyEmailEnabled: true }))).json(), { weeklyEmailEnabled: true });
    // Turning the owner's switch back on does not resend an already-claimed period.
    assert.deepEqual(await emailTick({ transport: recording().transport, now }), { sent: 0 });

    // Delivery rows follow the generation period they belong to.
    await client.query("DELETE FROM generation_periods WHERE business_id=$1", [ba]);
    assert.equal((await client.query("SELECT count(*)::int n FROM weekly_email_deliveries WHERE business_id=$1", [ba])).rows[0].n, 0);
  });

  console.log("weekly ready email template, per-period idempotency, opt-out, recipient, failure and switch tests passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
