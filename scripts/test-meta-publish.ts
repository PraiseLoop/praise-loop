import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { NextRequest } from "next/server";
import { databaseFixture } from "./db-fixture";
import { encryptCredential } from "../lib/integrations/credentials";
import {
  FACEBOOK_CAPTION_LIMIT,
  INSTAGRAM_CAPTION_LIMIT,
  MetaAuthError,
  MetaRateLimited,
  MetaRejected,
  metaCaptionProblem
} from "../lib/integrations/metaPublishing";
import type {
  MetaContainerStatusReceipt,
  MetaPage,
  MetaPublishInput,
  MetaPublishReceipt,
  MetaPublishingClient,
  MetaTarget
} from "../lib/integrations/metaPublishing";
import type { PostStatusReceipt } from "../lib/integrations/scheduler";
import { GET as publicMedia } from "../app/api/public-media/[name]/route";
import {
  CONTAINER_POLL_MS,
  MAX_SUBMIT_ATTEMPTS,
  postingMode,
  postingTick,
  publicMetaImageUrl,
  STALE_SUBMITTING_MS,
  hashImageToken,
  newImageToken,
  type PostingDeps
} from "../lib/services/bufferPosting";
import { getSelectedMetaTarget } from "../lib/services/metaConnection";
import { selectPostingProvider } from "../lib/services/postingGate";
import { ensureDraftJpeg, renderJpegVariant, META_JPEG_MAX_BYTES } from "../lib/services/imageRenderer";

// Direct Meta publishing from the worker (#234), against a scripted fake client.
// No test can reach Meta: the client is injected and global fetch always fails.
process.env.LOG_LEVEL = "error";
process.env.NEXTAUTH_URL = "https://app.example.invalid";
process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
const ENV = { NEXTAUTH_URL: "https://app.example.invalid" };
const PAGE: MetaPage = {
  id: "page-synthetic",
  name: "Synthetic Page",
  accessToken: "synthetic-page-token",
  instagramBusinessAccountId: "ig-synthetic",
  tasks: ["CREATE_CONTENT", "MANAGE"]
};

type Failure = Error | null;

/** A controllable Meta client. It records calls, never touches the network. */
class ScriptedMeta implements MetaPublishingClient {
  calls: string[] = [];
  images: string[] = [];
  containers = new Map<string, { externalId: string | null }>();
  failCreate: Failure = null;
  failPublish: Failure = null;
  failStatus: Failure = null;
  failFacebook: Failure = null;
  statusOverride: "in_progress" | "finished" | "error" | "expired" | null = null;
  private containerSequence = 0;
  private postSequence = 0;

  async listPages(): Promise<MetaPage[]> { return [PAGE]; }

  async createInstagramContainer(_page: MetaPage, input: MetaPublishInput): Promise<{ containerId: string }> {
    this.calls.push("create");
    this.images.push(input.imageUrl);
    if (this.failCreate) { const error = this.failCreate; this.failCreate = null; throw error; }
    this.containerSequence += 1;
    const containerId = `container-${this.containerSequence}`;
    this.containers.set(containerId, { externalId: null });
    return { containerId };
  }

  async publishInstagramContainer(_page: MetaPage, containerId: string): Promise<MetaPublishReceipt> {
    this.calls.push(`publish:${containerId}`);
    if (this.failPublish) { const error = this.failPublish; this.failPublish = null; throw error; }
    const container = this.containers.get(containerId);
    if (!container) throw new MetaRejected("unknown container");
    if (!container.externalId) { this.postSequence += 1; container.externalId = `ig-${this.postSequence}`; }
    return { provider: "meta", externalId: container.externalId, status: "published" };
  }

  async getContainerStatus(_page: MetaPage, containerId: string): Promise<MetaContainerStatusReceipt> {
    this.calls.push(`status:${containerId}`);
    if (this.failStatus) { const error = this.failStatus; this.failStatus = null; throw error; }
    const container = this.containers.get(containerId);
    if (container?.externalId) return { status: "published", externalId: container.externalId, externalLink: null };
    return { status: this.statusOverride ?? "finished", externalId: null, externalLink: null };
  }

  async publishInstagramImage(page: MetaPage, input: MetaPublishInput): Promise<MetaPublishReceipt> {
    const { containerId } = await this.createInstagramContainer(page, input);
    return this.publishInstagramContainer(page, containerId);
  }

  async publishPagePhoto(): Promise<MetaPublishReceipt> {
    this.calls.push("facebook");
    if (this.failFacebook) { const error = this.failFacebook; this.failFacebook = null; throw error; }
    return { provider: "meta", externalId: "fb-1", status: "published", externalLink: "https://www.facebook.com/fb-1" };
  }

  async getPostStatus(): Promise<PostStatusReceipt> {
    return { status: "published", externalLink: null, sentAt: null, errorMessage: null };
  }
}

async function main() {
  // The shared gate is the same for every provider; only the env var keeps its old name.
  assert.equal(postingMode({}), "off");
  assert.equal(postingMode({ BUFFER_POSTING_MODE: "draft" }), "draft");
  assert.equal(postingMode({ BUFFER_POSTING_MODE: "live" }), "live");
  // Provider choice is deterministic: Meta's explicit target wins over Buffer.
  assert.equal(selectPostingProvider({ metaTarget: true, bufferChannel: true }), "meta");
  assert.equal(selectPostingProvider({ metaTarget: true, bufferChannel: false }), "meta");
  assert.equal(selectPostingProvider({ metaTarget: false, bufferChannel: true }), "buffer");
  assert.equal(selectPostingProvider({ metaTarget: false, bufferChannel: false }), null);

  // Caption rules: refuse, never silently cut. Same limits are documented in
  // docs/integrations.md.
  assert.equal(metaCaptionProblem("instagram", "x".repeat(INSTAGRAM_CAPTION_LIMIT)), null);
  assert.equal(metaCaptionProblem("instagram", "x".repeat(INSTAGRAM_CAPTION_LIMIT + 1)), "caption_too_long");
  assert.equal(metaCaptionProblem("instagram", Array.from({ length: 30 }, (_, i) => `#tag${i}`).join(" ")), null);
  assert.equal(metaCaptionProblem("instagram", Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" ")), "too_many_hashtags");
  assert.equal(metaCaptionProblem("facebook", "x".repeat(FACEBOOK_CAPTION_LIMIT)), null);
  assert.equal(metaCaptionProblem("facebook", "x".repeat(FACEBOOK_CAPTION_LIMIT + 1)), "caption_too_long");

  const root = mkdtempSync(join(tmpdir(), "meta-publish-"));
  const DRAFT_PNG = "draft-1-0123456789abcdef0123.png";
  const DRAFT_IMAGE = `/api/media/${DRAFT_PNG}`;
  process.env.MEDIA_ROOT = root;
  writeFileSync(join(root, DRAFT_PNG), await sharp({ create: { width: 1080, height: 1080, channels: 3, background: "#123456" } }).png().toBuffer());
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("no real network in the Meta posting tests"); }) as typeof fetch;
  try {
    // JPEG variant: deterministic bytes, a content-addressed name, 1080x1080 in
    // Instagram's range, and comfortably below the 8 MB limit.
    const png = readFileSync(join(root, DRAFT_PNG));
    const first = await renderJpegVariant(png);
    const second = await renderJpegVariant(png);
    assert.deepEqual(first, second, "the same PNG always makes the same JPEG");
    const jpegMeta = await sharp(first).metadata();
    assert.deepEqual([jpegMeta.format, jpegMeta.width, jpegMeta.height], ["jpeg", 1080, 1080]);
    assert.ok(first.length <= META_JPEG_MAX_BYTES);
    const variant = await ensureDraftJpeg(DRAFT_IMAGE);
    assert.ok(variant);
    assert.match(variant!.name, /^draft-\d+-[a-f0-9]{20}\.jpg$/);
    assert.deepEqual(readFileSync(join(root, variant!.name)), first, "the stored variant is the same bytes");
    assert.deepEqual(await ensureDraftJpeg(DRAFT_IMAGE), variant, "generating again reuses the same content address");
    assert.equal(await ensureDraftJpeg("/api/media/../secret.png"), null, "no path traversal");
    assert.equal(await ensureDraftJpeg("/api/media/missing.png"), null);
    // Out-of-range frames are centre-cropped into 4:5-1.91:1, deterministically.
    for (const [w, h] of [[900, 1800], [2400, 800]] as const) {
      const tall = await sharp({ create: { width: w, height: h, channels: 3, background: "#654321" } }).png().toBuffer();
      const cropped = await renderJpegVariant(tall);
      const meta = await sharp(cropped).metadata();
      const ratio = meta.width! / meta.height!;
      assert.ok(ratio >= 0.8 - 0.001 && ratio <= 1.91 + 0.001, `${w}x${h} is cropped into range`);
      assert.deepEqual(cropped, await renderJpegVariant(tall), "crop and encode are deterministic");
    }
    // The Meta URL is always the JPEG variant.
    assert.equal(publicMetaImageUrl("T", ENV), "https://app.example.invalid/api/public-media/T.jpg");
    assert.equal(publicMetaImageUrl("T", {}), null);

    await databaseFixture(async (c) => {
      let n = 0;
      const PAGE_ID = "page-synthetic";
      const calls: { provider: string; owner: string }[] = [];
      let meta = new ScriptedMeta();
      const NOW = Math.floor(Date.now() / 1000) * 1000;
      let clock = NOW;

      async function seed(options: {
        target?: MetaTarget;
        plan?: "free" | "pro" | "business";
        pageStatus?: "active" | "needs_reconnect";
        connectionStatus?: "active" | "needs_reconnect";
        state?: string;
        containerId?: string;
        provider?: "meta" | "buffer" | null;
        caption?: string;
        draftStatus?: string;
        bufferChannel?: boolean;
        owner?: string;
        pageOwner?: string;
      } = {}) {
        n += 1;
        const owner = options.owner ?? `meta-owner-${n}`;
        const pageOwner = options.pageOwner ?? owner;
        if (!(await c.query("SELECT 1 FROM auth_users WHERE id=$1", [owner])).rowCount) {
          await c.query("INSERT INTO auth_users(id,email) VALUES($1,$2)", [owner, `${owner}@example.invalid`]);
        }
        if (!(await c.query("SELECT 1 FROM auth_users WHERE id=$1", [pageOwner])).rowCount) {
          await c.query("INSERT INTO auth_users(id,email) VALUES($1,$2)", [pageOwner, `${pageOwner}@example.invalid`]);
        }
        const business = Number((await c.query(
          "INSERT INTO businesses(name,timezone,owner_id) VALUES('Synthetic Meta','UTC',$1) RETURNING id", [owner]
        )).rows[0].id);
        const plan = options.plan ?? "pro";
        if (plan !== "free") {
          await c.query("INSERT INTO owner_plans(owner_id,plan,source) VALUES($1,$2,'manual') ON CONFLICT(owner_id) DO UPDATE SET plan=EXCLUDED.plan,expires_at=NULL", [owner, plan]);
        }
        const connection = Number((await c.query(
          `INSERT INTO meta_connections(owner_id,status) VALUES($1,$2)
           ON CONFLICT(owner_id) DO UPDATE SET status=EXCLUDED.status,updated_at=now() RETURNING id`,
          [pageOwner, options.connectionStatus ?? "active"]
        )).rows[0].id);
        const pageId = `${PAGE_ID}-${n}`;
        const page = Number((await c.query(
          `INSERT INTO meta_pages(connection_id,page_id,name,encrypted_page_token,instagram_business_account_id,tasks,status)
           VALUES($1,$2,'Synthetic Page',$3,'ig-synthetic',ARRAY['CREATE_CONTENT','MANAGE'],$4) RETURNING id`,
          [connection, pageId, encryptCredential(`token-${n}`, `meta:page:${pageOwner}:${pageId}`), options.pageStatus ?? "active"]
        )).rows[0].id);
        await c.query(
          "INSERT INTO business_meta_targets(business_id,meta_page_id,target) VALUES($1,$2,$3)",
          [business, page, options.target ?? "instagram"]
        );
        if (options.bufferChannel) {
          const bufferConnection = Number((await c.query(
            `INSERT INTO buffer_connections(owner_id,organization_id,encrypted_access_token,encrypted_refresh_token,access_expires_at,scope)
             VALUES($1,'org','a','r',now()+interval '1 hour','s') RETURNING id`, [owner]
          )).rows[0].id);
          await c.query(
            "INSERT INTO business_buffer_channels(business_id,connection_id,channel_id,channel_name,service,channel_type) VALUES($1,$2,'ch1','Synthetic','instagram','business')",
            [business, bufferConnection]
          );
        }
        const instant = new Date(clock - 60_000 - n * 1000).toISOString();
        const draft = Number((await c.query(
          `INSERT INTO draft_posts(business_id,quote_text,caption_text,image_path,status,scheduled_for)
           VALUES($1,'Q',$2,$5,$3,$4) RETURNING id`,
          [business, options.caption ?? "Synthetic caption", options.draftStatus ?? "scheduled", instant, DRAFT_IMAGE]
        )).rows[0].id);
        await c.query(
          `INSERT INTO posting_slot_claims(business_id,instant,draft_id,state,provider,provider_target,container_id)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [business, instant, draft, options.state ?? "queued", options.provider === undefined ? "meta" : options.provider, options.provider === null ? null : (options.target ?? "instagram"), options.containerId ?? null]
        );
        return { owner, pageOwner, business, draft, page, connection };
      }

      const claim = async (draft: number) => (await c.query("SELECT * FROM posting_slot_claims WHERE draft_id=$1", [draft])).rows[0];
      const status = async (draft: number) => (await c.query("SELECT status FROM draft_posts WHERE id=$1", [draft])).rows[0].status;
      const bufferAdapter: NonNullable<PostingDeps["adapterFor"]> = async () => {
        calls.push({ provider: "buffer", owner: "unexpected" });
        throw new Error("Buffer must not be called");
      };
      const tick = (mode: "off" | "draft" | "live", deps: { adapterFor?: PostingDeps["adapterFor"] } = {}) => postingTick({
        mode, env: ENV, now: () => clock,
        meta: { client: meta },
        // Most cases use the stored encrypted Page; this proves the real owner check.
        adapterFor: deps.adapterFor
      });
      const reset = async () => {
        // Every case gets a clean database as well as a fresh fake, so a queued
        // claim from an earlier case cannot be picked up by the next tick.
        await c.query("DELETE FROM businesses");
        await c.query("DELETE FROM auth_users");
        meta = new ScriptedMeta();
        clock = NOW;
        calls.length = 0;
      };

      // 1. Connect-state sanity: the business has one active target.
      let s = await seed();
      const selected = await getSelectedMetaTarget(s.owner, s.business);
      assert.equal(selected?.target, "instagram");
      assert.equal(selected?.page.pageId, `${PAGE_ID}-${n}`);
      assert.equal(selected?.page.status, "active");
      await reset();

      // 2. Instagram success: create container, persist it, publish, then the draft is published.
      s = await seed();
      let result = await tick("live");
      assert.equal(result.submitted, 1);
      let row = await claim(s.draft);
      assert.deepEqual([row.state, row.provider, row.provider_target], ["sent", "meta", "instagram"]);
      assert.match(row.external_id, /^ig-/);
      assert.match(row.container_id, /^container-/);
      assert.match(row.idempotency_key, new RegExp(`^meta:${s.draft}:`), "a durable key is written before the first call");
      assert.equal(await status(s.draft), "published");
      assert.match(meta.images[0], new RegExp(`/api/public-media/[A-Za-z0-9_-]{43}\\.jpg$`), "Meta gets the JPEG link");
      assert.equal(row.image_token_hash, null, "the public link is revoked after publication");
      assert.deepEqual(meta.calls, ["create", `status:${row.container_id}`, `publish:${row.container_id}`]);
      // Duplicate delivery after success changes nothing and makes no call.
      assert.equal((await tick("live")).submitted, 0);
      assert.deepEqual(meta.calls, ["create", `status:${row.container_id}`, `publish:${row.container_id}`]);
      await reset();

      // 3. Facebook Page photo: one call, no container, the post link is stored.
      s = await seed({ target: "facebook" });
      result = await tick("live");
      assert.equal(result.submitted, 1);
      row = await claim(s.draft);
      assert.deepEqual([row.state, row.provider_target, row.external_id, row.external_link], ["sent", "facebook", "fb-1", "https://www.facebook.com/fb-1"]);
      assert.equal(await status(s.draft), "published");
      assert.deepEqual(meta.calls, ["facebook"]);
      await reset();

      // 4. A permanent provider failure ends visibly and revokes the image link.
      s = await seed();
      meta.failCreate = new MetaRejected("synthetic rejection");
      result = await tick("live");
      assert.equal(result.failed, 1);
      row = await claim(s.draft);
      assert.deepEqual([row.state, row.error_code, row.image_token_hash], ["error", "rejected", null]);
      assert.equal(await status(s.draft), "failed");
      await reset();

      // 5. A revoked current token marks the Page for reconnect and never retries in a loop.
      s = await seed();
      meta.failCreate = new MetaAuthError();
      result = await tick("live");
      assert.equal(result.failed, 1);
      row = await claim(s.draft);
      assert.deepEqual([row.state, row.error_code], ["error", "needs_reconnect"]);
      assert.equal((await c.query("SELECT status FROM meta_pages WHERE id=$1", [s.page])).rows[0].status, "needs_reconnect");
      await tick("live");
      assert.equal(meta.calls.length, 1, "a reconnect-needed post is not retried");
      await reset();

      // 5b. A reconnect between reading the token and Meta rejecting it must not
      // flag the fresh token: only the exact ciphertext that failed is matched.
      s = await seed();
      const storedPage = (await c.query("SELECT page_id FROM meta_pages WHERE id=$1", [s.page])).rows[0];
      const freshCiphertext = encryptCredential("token-reconnected", `meta:page:${s.pageOwner}:${storedPage.page_id}`);
      meta.createInstagramContainer = async () => {
        // The owner reconnects while the stale request is in flight.
        await c.query(
          "UPDATE meta_pages SET encrypted_page_token=$2,status='active',updated_at=now() WHERE id=$1",
          [s.page, freshCiphertext]
        );
        throw new MetaAuthError();
      };
      result = await tick("live");
      assert.equal(result.failed, 1);
      row = await claim(s.draft);
      assert.deepEqual([row.state, row.error_code], ["error", "needs_reconnect"]);
      assert.equal(
        (await c.query("SELECT status FROM meta_pages WHERE id=$1", [s.page])).rows[0].status,
        "active",
        "a reconnect with a fresh token is left alone"
      );
      await reset();

      // 6. Rate limit: retry later with a wait, then succeed. A permanently
      // rate-limited post stops after the bound instead of looping.
      s = await seed();
      meta.failCreate = new MetaRateLimited(5_000);
      result = await tick("live");
      assert.equal(result.requeued, 1);
      row = await claim(s.draft);
      assert.deepEqual([row.state, row.error_code], ["queued", null]);
      assert.ok(Date.parse(row.next_attempt_at) > clock, "the retry waits");
      assert.equal((await tick("live")).submitted, 0, "not picked before its retry time");
      clock += 6_000;
      assert.equal((await tick("live")).submitted, 1, "after the wait it goes");
      assert.equal(await status(s.draft), "published");
      await reset();
      s = await seed();
      meta.failCreate = new MetaRateLimited(1_000);
      for (let attempt = 0; attempt < MAX_SUBMIT_ATTEMPTS; attempt++) {
        // The fake consumes one failure per tick; put it back for every attempt.
        meta.failCreate = new MetaRateLimited(1_000);
        await tick("live");
        clock += 2_000;
      }
      row = await claim(s.draft);
      assert.deepEqual([row.state, row.error_code], ["error", "rate_limited"], "bounded retries fail visibly");
      await reset();

      // 7. Crash between container creation and publish: the saved container is
      // resumed, not created again, so there is exactly one post.
      s = await seed({ state: "submitting", containerId: "container-crash" });
      meta.containers.set("container-crash", { externalId: null });
      await c.query("UPDATE posting_slot_claims SET updated_at=to_timestamp($2) WHERE draft_id=$1", [s.draft, (clock - STALE_SUBMITTING_MS - 1000) / 1000]);
      result = await tick("live");
      assert.equal(result.requeued + result.submitted >= 1, true);
      row = await claim(s.draft);
      assert.equal(row.state, "sent");
      assert.deepEqual(meta.calls, ["status:container-crash", "publish:container-crash"], "no second container");
      assert.equal(await status(s.draft), "published");
      await reset();

      // 7b. Crash after publish but before recording the receipt: the container
      // status proves publication, so it is confirmed, not published again.
      s = await seed({ state: "submitting", containerId: "container-published" });
      meta.containers.set("container-published", { externalId: "ig-existing" });
      await c.query("UPDATE posting_slot_claims SET updated_at=to_timestamp($2) WHERE draft_id=$1", [s.draft, (clock - STALE_SUBMITTING_MS - 1000) / 1000]);
      await tick("live");
      row = await claim(s.draft);
      assert.deepEqual([row.state, row.external_id], ["sent", "ig-existing"]);
      assert.deepEqual(meta.calls, ["status:container-published"], "an already-published container is confirmed only");
      await reset();

      // 7c. A container still being processed is retried, keeping the image link.
      s = await seed({ state: "submitting", containerId: "container-processing" });
      meta.containers.set("container-processing", { externalId: null });
      meta.statusOverride = "in_progress";
      await c.query(
        "UPDATE posting_slot_claims SET image_token_hash=$2,image_expires_at=now()+interval '1 hour',updated_at=to_timestamp($3) WHERE draft_id=$1",
        [s.draft, hashImageToken(newImageToken()), (clock - STALE_SUBMITTING_MS - 1000) / 1000]
      );
      result = await tick("live");
      assert.ok(result.requeued >= 1);
      row = await claim(s.draft);
      assert.equal(row.state, "queued");
      assert.notEqual(row.image_token_hash, null, "the image link stays while the container is processed");
      assert.ok(Date.parse(row.next_attempt_at) - clock >= CONTAINER_POLL_MS - 1000);
      await reset();

      // 8. Two workers at once: one container, one publish.
      s = await seed();
      const slow = meta;
      const slowCreate = slow.createInstagramContainer.bind(slow);
      slow.createInstagramContainer = async (page, input) => { await new Promise((done) => setTimeout(done, 50)); return slowCreate(page, input); };
      await Promise.all([tick("live"), tick("live"), tick("live")]);
      assert.equal(meta.calls.filter((call) => call === "create").length, 1, "SKIP LOCKED plus the committed claim state");
      assert.equal(meta.calls.filter((call) => call.startsWith("publish:")).length, 1);
      await reset();

      // 9. Another owner's Page is refused before any provider call. No pageFor
      // injection here: the real getMetaPageCredentials owner check runs.
      s = await seed({ pageOwner: "some-other-owner" });
      result = await tick("live");
      assert.equal(result.failed, 1);
      row = await claim(s.draft);
      assert.deepEqual([row.state, row.error_code], ["error", "not_connected"]);
      assert.deepEqual(meta.calls, []);
      await reset();

      // 10. Free plan: the automaticPosting limit refuses Meta too.
      s = await seed({ plan: "free" });
      result = await tick("live");
      assert.equal(result.failed, 1);
      row = await claim(s.draft);
      assert.deepEqual([row.state, row.error_code, row.image_token_hash], ["error", "plan_required", null]);
      assert.equal(await status(s.draft), "failed");
      assert.deepEqual(meta.calls, []);
      await reset();

      // 11. OFF makes no provider call at all.
      s = await seed();
      result = await tick("off");
      assert.equal(result.mode, "off");
      assert.deepEqual(meta.calls, []);
      assert.deepEqual([(await claim(s.draft)).state, await status(s.draft)], ["queued", "scheduled"]);
      await reset();

      // 12. DRAFT: Meta has no provider-side draft, so nothing is created or
      // published and the post returns to approved.
      s = await seed();
      result = await tick("draft");
      assert.equal(result.drafted, 1);
      row = await claim(s.draft);
      assert.deepEqual([row.state, row.mode], ["drafted", "draft"]);
      assert.equal(await status(s.draft), "approved");
      assert.deepEqual(meta.calls, [], "test mode creates no container and publishes nothing");
      await reset();

      // 13. A business with both providers, on a legacy claim without a recorded
      // provider, uses Meta deterministically and never touches Buffer.
      s = await seed({ bufferChannel: true, provider: null });
      result = await tick("live", { adapterFor: bufferAdapter });
      assert.equal(result.submitted, 1);
      assert.equal((await claim(s.draft)).provider, "meta");
      assert.deepEqual(calls, [], "Buffer was not called");
      await reset();

      // 14. A caption over Instagram's limit fails before any provider call.
      s = await seed({ caption: "x".repeat(INSTAGRAM_CAPTION_LIMIT + 1) });
      result = await tick("live");
      assert.equal(result.failed, 1);
      row = await claim(s.draft);
      assert.deepEqual([row.state, row.error_code], ["error", "caption_too_long"]);
      assert.deepEqual(meta.calls, []);
      await reset();

      // 15. The public route serves the JPEG variant and the stored PNG from the
      // same unguessable token, and revokes both when the token is revoked.
      s = await seed();
      const token = newImageToken();
      await c.query(
        "UPDATE posting_slot_claims SET state='unknown',image_token_hash=$2,image_expires_at=now()+interval '1 hour' WHERE draft_id=$1",
        [s.draft, hashImageToken(token)]
      );
      const fetchImage = (name: string) => publicMedia(new NextRequest(`http://localhost/api/public-media/${name}`), { params: Promise.resolve({ name }) });
      let response = await fetchImage(`${token}.jpg`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "image/jpeg");
      const jpg = Buffer.from(await response.arrayBuffer());
      assert.deepEqual(jpg, first, "the route serves the deterministic JPEG");
      response = await fetchImage(`${token}.png`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "image/png");
      await c.query("UPDATE posting_slot_claims SET image_token_hash=NULL WHERE draft_id=$1", [s.draft]);
      assert.equal((await fetchImage(`${token}.jpg`)).status, 404);
      assert.equal((await fetchImage(`${token}.png`)).status, 404, "a revoked token serves neither format");
      await reset();
    });
  } finally {
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  }
  console.log("Meta worker publishing, retry/idempotency, provider choice and JPEG variant tests passed (fake Meta only)");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
