import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { BufferSchedulerAdapter, SchedulerAmbiguous, SchedulerAuthError, SchedulerRateLimited, SchedulerRejected } from "../lib/integrations/buffer";
import { decryptCredential, encryptCredential } from "../lib/integrations/credentials";
const payload = { draftPostId: 1, businessId: 1, captionText: "Thanks!", mediaUrl: "https://media.example/api/public-media/abc.png" };
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
function make(responses: (Response | Error)[], mode: "draft" | "live" = "live") {
  const calls: { body: string; auth: string }[] = [];
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    calls.push({ body: String(init.body), auth: String((init.headers as Record<string, string>).authorization) });
    const r = responses.shift()!; if (r instanceof Error) throw r; return r;
  }) as unknown as typeof fetch;
  return { calls, a: new BufferSchedulerAdapter({ accessToken: "TOKEN", channelId: "ch1", mode, fetchImpl, sleep: async () => {} }) };
}
async function main() {
  const good = { data: { createPost: { __typename: "PostActionSuccess", post: { id: "p1", status: "sending" } } } };
  let t = make([ok(good)]);
  const r = await t.a.submitPost(payload);
  assert.deepEqual([r.provider, r.externalId, r.status], ["buffer", "p1", "sending"]);
  const sent = JSON.parse(t.calls[0].body).variables.input;
  assert.deepEqual(sent.assets, [{ image: { url: payload.mediaUrl } }], "documented AssetInput shape");
  // Posting is decided in PraiseLoop: the post is shared now, never placed in Buffer's own queue or schedule.
  assert.deepEqual([sent.mode, sent.schedulingType, sent.needsApproval, sent.saveToDraft, sent.channelId], ["shareNow", "automatic", false, false, "ch1"], "live mode publishes");
  assert.equal(sent.dueAt, undefined); assert.doesNotMatch(t.calls[0].body, /customScheduled|addToQueue/); assert.equal(t.calls[0].auth, "Bearer TOKEN");
  // draft mode asks Buffer to keep it as a draft, so nothing is published
  t = make([ok(good)], "draft"); await t.a.submitPost(payload);
  assert.equal(JSON.parse(t.calls[0].body).variables.input.saveToDraft, true);
  // incomplete drafts never reach the network
  t = make([]);
  await assert.rejects(t.a.submitPost({ ...payload, mediaUrl: "" }), SchedulerRejected);
  await assert.rejects(t.a.submitPost({ ...payload, captionText: " " }), SchedulerRejected);
  assert.equal(t.calls.length, 0);
  await assert.rejects(make([new Response("", { status: 401 })]).a.submitPost(payload), SchedulerAuthError);
  // 429 retried then succeeds; persistent 429 is bounded
  t = make([new Response("", { status: 429, headers: { "retry-after": "2" } }), ok(good)]);
  assert.equal((await t.a.submitPost(payload)).externalId, "p1"); assert.equal(t.calls.length, 2);
  t = make([429, 429, 429, 429].map(s => new Response("", { status: s })));
  await assert.rejects(t.a.submitPost(payload), SchedulerRateLimited); assert.equal(t.calls.length, 3);
  // a Retry-After beyond the 60s cap is reported, not shortened and retried
  t = make([new Response("", { status: 429, headers: { "retry-after": "753" } }), ok(good)]);
  await assert.rejects(t.a.submitPost(payload), (e: unknown) => e instanceof SchedulerRateLimited && e.retryAfterMs === 753000); assert.equal(t.calls.length, 1);
  // timeout after send / 5xx: ambiguous, never resubmitted
  t = make([new Error("timeout"), ok(good)]);
  await assert.rejects(t.a.submitPost(payload), SchedulerAmbiguous); assert.equal(t.calls.length, 1);
  t = make([new Response("", { status: 502 }), ok(good)]);
  await assert.rejects(t.a.submitPost(payload), SchedulerAmbiguous); assert.equal(t.calls.length, 1);
  // Buffer's typed errors: only a refusal that proves nothing was created is a rejection
  const typed = (__typename: string, message = "x") => ok({ data: { createPost: { __typename, message } } });
  await assert.rejects(make([typed("InvalidInputError", "Could not fetch image")]).a.submitPost(payload), /Could not fetch image/);
  for (const name of ["PostInvalidInputError", "NotFoundError", "PostChannelNotFoundError", "LimitReachedError", "PostLimitReachedError", "DuplicateError"]) await assert.rejects(make([typed(name)]).a.submitPost(payload), SchedulerRejected, name);
  for (const name of ["UnauthorizedError", "ChannelRefreshRequired"]) await assert.rejects(make([typed(name)]).a.submitPost(payload), SchedulerAuthError, name);
  for (const name of ["UnexpectedError", "RestProxyError", "SomethingNew"]) { t = make([typed(name), ok(good)]); await assert.rejects(t.a.submitPost(payload), SchedulerAmbiguous, name); assert.equal(t.calls.length, 1); }
  await assert.rejects(make([ok({ data: { createPost: {} } })]).a.submitPost(payload), SchedulerAmbiguous);
  // GraphQL-level errors are classified by code
  const gql = (code: string) => ok({ errors: [{ message: "x", extensions: { code } }] });
  await assert.rejects(make([gql("UNAUTHORIZED")]).a.submitPost(payload), SchedulerAuthError);
  await assert.rejects(make([gql("FORBIDDEN")]).a.submitPost(payload), SchedulerAuthError);
  await assert.rejects(make([gql("BAD_USER_INPUT")]).a.submitPost(payload), SchedulerRejected);
  t = make([gql("UNEXPECTED"), ok(good)]);
  await assert.rejects(t.a.submitPost(payload), SchedulerAmbiguous); assert.equal(t.calls.length, 1);
  // status reads are read-only and keep Buffer's own words
  t = make([ok({ data: { post: { id: "p1", status: "sent", externalLink: "https://instagram.example/p/1", sentAt: "2026-11-03T15:00:00Z", error: null } } })]);
  assert.deepEqual(await t.a.getPostStatus("p1"), { status: "sent", externalLink: "https://instagram.example/p/1", sentAt: "2026-11-03T15:00:00Z", errorMessage: null });
  assert.equal(JSON.parse(t.calls[0].body).variables.input.id, "p1"); assert.doesNotMatch(t.calls[0].body, /mutation/);
  assert.equal((await make([ok({ data: { post: { id: "p1", status: "error", error: { message: "Image rejected", rawError: "SECRET" } } } })]).a.getPostStatus("p1")).errorMessage, "Image rejected");
  await assert.rejects(make([ok({ data: { post: null } })]).a.getPostStatus("p1"), SchedulerAmbiguous);
  await assert.rejects(make([new Response("", { status: 401 })]).a.getPostStatus("p1"), SchedulerAuthError);
  // credentials: round trip, AAD binding, tamper detection
  const key = randomBytes(32), c = encryptCredential("secret-token", "owner:1|biz:1|buffer", key);
  assert.doesNotMatch(c, /secret-token/); assert.equal(decryptCredential(c, "owner:1|biz:1|buffer", key), "secret-token");
  assert.throws(() => decryptCredential(c, "owner:2|biz:1|buffer", key));
  assert.throws(() => decryptCredential(c, "owner:1|biz:1|buffer", randomBytes(32)));
  console.log("buffer adapter contract (mocked) and credential encryption tests passed");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
