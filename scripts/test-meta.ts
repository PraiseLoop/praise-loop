import assert from "node:assert/strict";
import {
  FakeMetaPublishingClient,
  MetaAccessNotApproved,
  MetaAmbiguous,
  MetaAuthError,
  MetaRateLimited,
  MetaRejected,
  MetaSchedulerAdapter,
  liveMetaClient,
  type MetaPage
} from "../lib/integrations/metaPublishing";

const PAGE: MetaPage = {
  id: "page-synthetic",
  name: "Synthetic Page",
  accessToken: "synthetic-page-token",
  instagramBusinessAccountId: "ig-synthetic",
  tasks: ["CREATE_CONTENT", "MANAGE"]
};
const INPUT = { caption: "Synthetic caption", imageUrl: "https://media.example.invalid/draft-token.jpg" };
const PAYLOAD = { draftPostId: 7, businessId: 3, captionText: INPUT.caption, mediaUrl: INPUT.imageUrl };

function rejection<T>(run: () => Promise<T>, type: new (...args: never[]) => Error): Promise<T> {
  return run().then(
    () => { throw new Error(`expected ${type.name}`); },
    error => { assert.ok(error instanceof type, `expected ${type.name}, got ${String(error)}`); return error as T; }
  );
}

async function main() {
  // The live client exists only to fail closed until Meta App Review and Business
  // Verification are complete. It must never look like a successful fake.
  const live = liveMetaClient();
  await rejection(() => live.listPages("user-token"), MetaAccessNotApproved);
  await rejection(() => live.publishInstagramImage(PAGE, INPUT), MetaAccessNotApproved);
  await rejection(() => live.publishPagePhoto(PAGE, INPUT), MetaAccessNotApproved);
  await rejection(() => live.getPostStatus("post", PAGE), MetaAccessNotApproved);

  // Connect step: the fake lists the Pages a long-lived User token can see, and
  // refuses a missing or revoked token the way Meta does.
  const connected = new FakeMetaPublishingClient({ pages: [PAGE] });
  assert.deepEqual(await connected.listPages("user-token"), [PAGE]);
  await rejection(() => connected.listPages(""), MetaAuthError);
  await rejection(() => connected.listPages("revoked"), MetaAuthError);

  // Instagram publish: JPEG-ready public image URL in, a Meta media id out.
  const instagram = new FakeMetaPublishingClient({ pages: [PAGE] });
  const igReceipt = await instagram.publishInstagramImage(PAGE, INPUT);
  assert.deepEqual(igReceipt, { provider: "meta", externalId: "fake_ig_1", status: "published" });
  assert.deepEqual(instagram.calls, [{ method: "instagram", pageId: PAGE.id }]);
  assert.equal(instagram.calls[0].pageId, PAGE.id, "the selected Page is the one published to");

  // Facebook Page photo uses the same input and a Page post id.
  const facebook = new FakeMetaPublishingClient({ pages: [PAGE] });
  assert.deepEqual(await facebook.publishPagePhoto(PAGE, INPUT), {
    provider: "meta", externalId: "fake_fb_1", status: "published"
  });
  assert.deepEqual(facebook.calls, [{ method: "facebook", pageId: PAGE.id }]);

  // A Page without a linked Instagram account is refused before any call.
  const unlinked = new FakeMetaPublishingClient({ pages: [PAGE] });
  await rejection(
    () => unlinked.publishInstagramImage({ ...PAGE, instagramBusinessAccountId: null }, INPUT),
    MetaRejected
  );
  assert.deepEqual(unlinked.calls, []);

  // Input checks are local: nothing is sent for a missing caption or a URL Meta
  // could not fetch.
  const validation = new FakeMetaPublishingClient();
  await rejection(() => validation.publishInstagramImage(PAGE, { ...INPUT, caption: "  " }), MetaRejected);
  await rejection(() => validation.publishInstagramImage(PAGE, { ...INPUT, imageUrl: "http://media.example.invalid/a.jpg" }), MetaRejected);
  await rejection(() => validation.publishInstagramImage(PAGE, { ...INPUT, imageUrl: "https://localhost/a.jpg" }), MetaRejected);
  await rejection(() => validation.publishInstagramImage(PAGE, { ...INPUT, imageUrl: "not a url" }), MetaRejected);
  await rejection(() => validation.publishInstagramImage({ ...PAGE, tasks: [] }, INPUT), MetaRejected);
  assert.deepEqual(validation.calls, []);
  // Newer Page settings report the PROFILE_PLUS_* task names.
  await validation.publishInstagramImage({ ...PAGE, tasks: ["PROFILE_PLUS_CREATE_CONTENT"] }, INPUT);
  assert.equal(validation.calls.length, 1);

  // Provider failures are named, and the fake's one-shot failure does not repeat.
  const rejected = new FakeMetaPublishingClient({ failure: "rejected" });
  await rejection(() => rejected.publishInstagramImage(PAGE, INPUT), MetaRejected);
  assert.equal((await rejected.publishInstagramImage(PAGE, INPUT)).externalId, "fake_ig_1");

  const limited = new FakeMetaPublishingClient({ failure: "rate_limit", retryAfterMs: 12_000 });
  const limitedError = await rejection(() => limited.publishInstagramImage(PAGE, INPUT), MetaRateLimited);
  assert.equal((limitedError as unknown as MetaRateLimited).retryAfterMs, 12_000);

  const ambiguous = new FakeMetaPublishingClient({ failure: "ambiguous" });
  await rejection(() => ambiguous.publishInstagramImage(PAGE, INPUT), MetaAmbiguous);
  assert.deepEqual(ambiguous.calls, [], "an ambiguous call records no accepted post");

  const auth = new FakeMetaPublishingClient({ failure: "auth" });
  await rejection(() => auth.publishPagePhoto(PAGE, INPUT), MetaAuthError);

  // The fake does not deduplicate: a caller that retries after an ambiguous
  // outcome can create two posts. The posting state machine must mark the first
  // attempt unknown and never resubmit it.
  const noDedupe = new FakeMetaPublishingClient();
  const first = await noDedupe.publishInstagramImage(PAGE, INPUT);
  const second = await noDedupe.publishInstagramImage(PAGE, INPUT);
  assert.notEqual(first.externalId, second.externalId);

  // The adapter is the shared SchedulerAdapter shape, so approval/draft code does
  // not need to know whether Buffer or Meta posts.
  const igAdapter = new MetaSchedulerAdapter({ target: "instagram", page: PAGE, client: new FakeMetaPublishingClient() });
  const igPost = await igAdapter.submitPost(PAYLOAD);
  assert.equal(igPost.provider, "meta");
  assert.match(igPost.externalId, /^fake_ig_/);
  assert.equal((await igAdapter.getPostStatus(igPost.externalId)).status, "published");

  const fbCalls = new FakeMetaPublishingClient();
  const fbAdapter = new MetaSchedulerAdapter({ target: "facebook", page: PAGE, client: fbCalls });
  const fbPost = await fbAdapter.submitPost(PAYLOAD);
  assert.equal(fbPost.provider, "meta");
  assert.match(fbPost.externalId, /^fake_fb_/);
  assert.deepEqual(fbCalls.calls, [{ method: "facebook", pageId: PAGE.id }]);

  // A live adapter cannot publish without access.
  const liveAdapter = new MetaSchedulerAdapter({ target: "instagram", page: PAGE, client: liveMetaClient() });
  await rejection(() => liveAdapter.submitPost(PAYLOAD), MetaAccessNotApproved);

  console.log("Meta publishing stub, fake adapter and scheduler contract tests passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
