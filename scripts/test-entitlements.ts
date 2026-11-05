import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import sharp from "sharp";
import { databaseFixture } from "./db-fixture";
import { sessionHash } from "../lib/auth-adapter";
import { PLAN_LIMITS, businessAllowance, entitlementsFor, entitlementsForPlan, setOwnerPlan } from "../lib/services/entitlements";
import { expiryNote, formatLocalDate, pausedBusinessMessage, quotaMetMessage, weekLimitNotice } from "../lib/planDisplay";
import { entitlementsWithUsage, localMidnight, weeklyUsage } from "../lib/services/planUsage";
import { processGeneration, requestGeneration, type GenerationDeps } from "../lib/services/generation";
import { renderDraftImage } from "../lib/services/imageRenderer";

async function main() {
  process.env.NEXTAUTH_URL = "http://localhost";
  const root = mkdtempSync(join(tmpdir(), "entitlements-"));
  process.env.MEDIA_ROOT = root;

  try {
    // Pure plan resolution: default free, the paid plans, and expired paid plans.
    assert.deepEqual(entitlementsForPlan("free", "default", null), { plan: "free", source: "default", expiresAt: null, expired: false, expiredPlan: null, limits: PLAN_LIMITS.free });
    assert.equal(entitlementsForPlan("pro", "manual", null).limits.postsPerWeek, 5);
    assert.equal(entitlementsForPlan("pro", "manual", null).limits.businesses, 1);
    assert.equal(PLAN_LIMITS.free.templates, 1);
    assert.equal(PLAN_LIMITS.pro.templates, 4);
    assert.equal(PLAN_LIMITS.business.templates, 4);
    assert.equal(PLAN_LIMITS.free.brandVoice, false);
    assert.equal(PLAN_LIMITS.pro.brandVoice, true);
    assert.equal(PLAN_LIMITS.free.automaticPosting, false, "automatic posting is a paid feature");
    assert.equal(PLAN_LIMITS.pro.automaticPosting, true);
    assert.equal(PLAN_LIMITS.business.automaticPosting, true);
    const businessPlan = entitlementsForPlan("business", "manual", null);
    assert.equal(businessPlan.plan, "business");
    assert.equal(businessPlan.limits.postsPerWeek, 5);
    assert.equal(businessPlan.limits.businesses, 5);
    assert.equal(businessPlan.limits.watermark, false);
    assert.equal(businessPlan.limits.brandVoice, true);
    const expiredPlan = entitlementsForPlan("pro", "manual", "2020-01-01T00:00:00Z", new Date("2026-01-01T00:00:00Z"));
    assert.equal(expiredPlan.plan, "free");
    assert.equal(expiredPlan.expired, true);
    assert.equal(expiredPlan.expiredPlan, "pro");
    assert.equal(expiredPlan.limits.watermark, true);
    assert.equal(expiredPlan.limits.automaticPosting, false, "an expired plan is refused automatic posting");
    const expiredBusiness = entitlementsForPlan("business", "manual", "2020-01-01T00:00:00Z", new Date("2026-01-01T00:00:00Z"));
    assert.equal(expiredBusiness.plan, "free");
    assert.equal(expiredBusiness.expired, true);
    assert.equal(expiredBusiness.expiredPlan, "business");
    assert.equal(expiredBusiness.limits.businesses, 1);
    const unknownPlan = entitlementsForPlan("team", "manual", "2020-01-01T00:00:00Z", new Date("2026-01-01T00:00:00Z"));
    assert.equal(unknownPlan.plan, "free");
    assert.equal(unknownPlan.expired, false, "an unknown stored plan is not reported as an expired paid plan");

    // The self-service allowlist was removed before real payments (#223): plans
    // now change only through an operator grant or a verified provider event.

    // Week reset is local midnight Monday in the business's timezone, across daylight saving.
    assert.equal(localMidnight("2026-10-26", "UTC").toISOString(), "2026-10-26T00:00:00.000Z");
    assert.equal(localMidnight("2026-10-26", "America/New_York").toISOString(), "2026-10-26T04:00:00.000Z");
    assert.equal(localMidnight("2026-11-02", "America/New_York").toISOString(), "2026-11-02T05:00:00.000Z", "after the fall-back change");
    assert.equal(localMidnight("2026-10-19", "Pacific/Auckland").toISOString(), "2026-10-18T11:00:00.000Z");
    const nyUsage = weeklyUsage({ id: 7, name: "NY", timezone: "America/New_York", weekly_target: 3 }, 1, entitlementsForPlan("free", "default", null), new Date("2026-10-29T12:00:00Z"));
    assert.equal(nyUsage.weekStart, "2026-10-26");
    assert.equal(nyUsage.resetsOn, "2026-11-02");
    assert.equal(nyUsage.resetsAt, "2026-11-02T05:00:00.000Z");
    assert.equal(nyUsage.quotaMet, true);

    await databaseFixture(async (c) => {
      await c.query(`INSERT INTO auth_users(id,email) VALUES
        ('free-owner','free@example.invalid'),('pro-owner','pro@example.invalid'),
        ('business-owner','business@example.invalid'),('expired-business-owner','expired-business@example.invalid'),
        ('expired-owner','expired@example.invalid'),('api-owner','api@example.invalid'),
        ('over-limit-owner','over-limit@example.invalid'),
        ('mixed-business-owner','mixed-business@example.invalid'),('mixed-manual-owner','mixed-manual@example.invalid'),
        ('lapsed-subscription-owner','lapsed-subscription@example.invalid')`);
      await c.query(`INSERT INTO auth_sessions VALUES
        ($1,'api-owner',now()+interval '1 hour')`,
        [sessionHash("entitlements-api-session")]);

      // No row means the default free plan; nothing needs to be seeded.
      assert.equal((await entitlementsFor("free-owner")).plan, "free");
      assert.equal((await entitlementsFor("free-owner")).source, "default");

      const pro = await setOwnerPlan("pro-owner", "pro", { actor: "operators@example.invalid", reason: "Synthetic pilot upgrade" });
      assert.equal(pro.plan, "pro");
      assert.equal(pro.limits.postsPerWeek, 5);
      assert.equal(pro.limits.watermark, false);
      const audit = (await c.query("SELECT plan,source,actor,reason FROM owner_plan_events WHERE owner_id='pro-owner'")).rows;
      assert.deepEqual(audit, [{ plan: "pro", source: "manual", actor: "operators@example.invalid", reason: "Synthetic pilot upgrade" }]);

      const businessEntitlements = await setOwnerPlan("business-owner", "business", { reason: "Synthetic Business plan" });
      assert.equal(businessEntitlements.plan, "business");
      assert.equal(businessEntitlements.limits.postsPerWeek, 5);
      assert.equal(businessEntitlements.limits.businesses, 5);
      assert.equal(businessEntitlements.limits.watermark, false);

      await setOwnerPlan("expired-owner", "pro", { expiresAt: "2020-01-01T00:00:00Z", reason: "Expired synthetic subscription" });
      const expired = await entitlementsFor("expired-owner");
      assert.equal(expired.plan, "free");
      assert.equal(expired.limits.postsPerWeek, 1);
      assert.equal((await c.query("SELECT plan FROM owner_plans WHERE owner_id='expired-owner'")).rows[0].plan, "pro", "expiry keeps the stored plan for renewal");

      await setOwnerPlan("expired-business-owner", "business", { expiresAt: "2020-01-01T00:00:00Z", reason: "Expired synthetic Business subscription" });
      const expiredBusiness = await entitlementsFor("expired-business-owner");
      assert.equal(expiredBusiness.plan, "free");
      assert.equal(expiredBusiness.limits.postsPerWeek, 1);
      assert.equal(expiredBusiness.limits.businesses, 1);
      assert.equal(expiredBusiness.expiredPlan, "business");
      assert.equal((await c.query("SELECT plan FROM owner_plans WHERE owner_id='expired-business-owner'")).rows[0].plan, "business", "expiry keeps the stored Business plan for renewal");

      // A subscription is a second, independent grant (#219): the highest active
      // plan wins and the source names the grant that won.
      await c.query(`INSERT INTO owner_subscriptions(owner_id,provider,external_id,plan,status,current_period_end) VALUES
        ('mixed-business-owner','stripe','sub-mixed-business','business','active',now()+interval '30 days'),
        ('mixed-manual-owner','stripe','sub-mixed-manual','business','canceled',now()-interval '1 day'),
        ('lapsed-subscription-owner','stripe','sub-lapsed','business','active',now()-interval '1 day')`);
      await setOwnerPlan("mixed-business-owner", "pro", { expiresAt: "2020-01-01T00:00:00Z", reason: "Expired synthetic manual grant" });
      const mixedBusiness = await entitlementsFor("mixed-business-owner");
      assert.equal(mixedBusiness.plan, "business", "an active subscription outranks an expired manual grant");
      assert.equal(mixedBusiness.source, "stripe");
      assert.equal(mixedBusiness.expired, false, "an active subscription is not reported as expired");
      assert.equal((await c.query("SELECT plan FROM owner_plans WHERE owner_id='mixed-business-owner'")).rows[0].plan, "pro", "the expired manual row is kept");

      await setOwnerPlan("mixed-manual-owner", "pro", { reason: "Active synthetic manual grant" });
      const mixedManual = await entitlementsFor("mixed-manual-owner");
      assert.equal(mixedManual.plan, "pro", "a lapsed subscription does not remove the manual grant");
      assert.equal(mixedManual.source, "manual", "the winning grant supplies the source");
      assert.equal((await c.query("SELECT status FROM owner_subscriptions WHERE owner_id='mixed-manual-owner'")).rows[0].status, "canceled", "the lapsed subscription row is kept");

      const lapsedSubscription = await entitlementsFor("lapsed-subscription-owner");
      assert.equal(lapsedSubscription.plan, "free");
      assert.equal(lapsedSubscription.expired, true);
      assert.equal(lapsedSubscription.expiredPlan, "business");
      assert.equal((await c.query("SELECT count(*)::int n FROM owner_subscriptions WHERE owner_id='lapsed-subscription-owner'")).rows[0].n, 1, "expiry keeps subscription data");

      const business = async (owner: string, name: string) =>
        (await c.query("INSERT INTO businesses(name,timezone,owner_id) VALUES($1,'UTC',$2) RETURNING id", [name, owner])).rows[0].id;
      const reviews = async (businessId: number) => c.query(
        "INSERT INTO reviews(business_id,source,source_review_id,rating,text,reviewed_at) SELECT $1,'manual',n::text,5,'A wonderful synthetic experience with friendly staff '||n,now() FROM generate_series(1,20) n",
        [businessId]
      );

      const now = new Date();
      const freeBusiness = await business("free-owner", "Free synthetic");
      await reviews(freeBusiness);
      const freeRequest = await requestGeneration(freeBusiness, 5, now);
      assert.equal(freeRequest.inserted, 1, "free plans reserve one weekly draft");
      assert.equal(freeRequest.target, 1);
      assert.equal((await requestGeneration(freeBusiness, 5, now)).reason, "quota_met");

      const proBusiness = await business("pro-owner", "Pro synthetic");
      await c.query("UPDATE businesses SET weekly_target=5 WHERE id=$1", [proBusiness]);
      await reviews(proBusiness);
      const proRequest = await requestGeneration(proBusiness, 5, now);
      assert.equal(proRequest.inserted, 5, "pro plans reserve the configured weekly target");
      assert.equal(proRequest.target, 5);

      const businessOwnerBusiness = await business("business-owner", "Business synthetic");
      await c.query("UPDATE businesses SET weekly_target=5 WHERE id=$1", [businessOwnerBusiness]);
      await reviews(businessOwnerBusiness);
      const businessRequest = await requestGeneration(businessOwnerBusiness, 5, now);
      assert.equal(businessRequest.inserted, 5, "Business plans reserve the configured weekly target");
      assert.equal(businessRequest.target, 5);

      // Upgrading mid-week raises the existing period's cap without losing its allocation.
      await setOwnerPlan("free-owner", "pro", { reason: "Synthetic mid-week upgrade" });
      await c.query("UPDATE businesses SET weekly_target=3 WHERE id=$1", [freeBusiness]);
      const upgraded = await requestGeneration(freeBusiness, 5, now);
      assert.equal(upgraded.target, 3);
      assert.equal(upgraded.inserted, 2, "the upgrade unlocks the remaining weekly drafts");
      await setOwnerPlan("free-owner", "free", { reason: "Synthetic downgrade" });

      let renderedWatermark: boolean | undefined;
      const generationDeps: GenerationDeps = {
        clock: () => now,
        captions: async () => ({ friendly: "Synthetic", premium: "Synthetic premium", playful: "Synthetic playful" }),
        render: async (params) => {
          renderedWatermark = params.watermark;
          return { publicPath: "/api/media/synthetic.png", fileSystemPath: "/tmp/synthetic.png" };
        }
      };
      const freeJob = (await c.query("SELECT id FROM generation_jobs WHERE business_id=$1 ORDER BY id LIMIT 1", [freeBusiness])).rows[0].id;
      assert.equal(await processGeneration(Number(freeJob), generationDeps), true);
      assert.equal(renderedWatermark, true, "the worker applies the free-plan watermark");
      renderedWatermark = undefined;
      const proJob = (await c.query("SELECT id FROM generation_jobs WHERE business_id=$1 ORDER BY id LIMIT 1", [proBusiness])).rows[0].id;
      assert.equal(await processGeneration(Number(proJob), generationDeps), true);
      assert.equal(renderedWatermark, false, "pro renders have no watermark");
      renderedWatermark = undefined;
      const businessJob = (await c.query("SELECT id FROM generation_jobs WHERE business_id=$1 ORDER BY id LIMIT 1", [businessOwnerBusiness])).rows[0].id;
      assert.equal(await processGeneration(Number(businessJob), generationDeps), true);
      assert.equal(renderedWatermark, false, "Business renders have no watermark");

      const apiBusiness = await business("api-owner", "API synthetic");
      const onboardingKey = "11111111-2222-3333-4444-555555555555";
      await c.query("UPDATE businesses SET onboarding_key=$2 WHERE id=$1", [apiBusiness, onboardingKey]);
      const request = (path: string, method = "GET", body?: unknown) => new NextRequest(`http://localhost${path}`, {
        method,
        headers: { cookie: "next-auth.session-token=entitlements-api-session", origin: "http://localhost", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });

      const entitlementsRoute = require("../app/api/entitlements/route");
      assert.equal(typeof entitlementsRoute.GET, "function");
      assert.equal(entitlementsRoute.POST, undefined);
      assert.equal(entitlementsRoute.PATCH, undefined);
      assert.equal(entitlementsRoute.PUT, undefined);
      const response = await entitlementsRoute.GET(request("/api/entitlements?plan=pro"));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.plan, "free", "the app can read but not change its own plan");
      assert.equal(body.limits.postsPerWeek, 1);
      assert.equal(response.headers.get("cache-control"), "private, no-store");

      // Weekly usage on the same endpoint. Free owner, nothing generated yet: 0 of the 1-post cap.
      const usageOf = (payload: any) => payload.usage[0];
      assert.equal(body.usage.length, 1);
      assert.deepEqual({ ...usageOf(body), weekStart: undefined, resetsOn: undefined, resetsAt: undefined }, {
        businessId: Number(apiBusiness), name: "API synthetic", timezone: "UTC", weekStart: undefined, resetsOn: undefined, resetsAt: undefined,
        allocated: 0, target: 1, weeklyTarget: 3, quotaMet: false, paused: false
      });
      assert.equal(usageOf(body).paused, false);
      assert.equal(pausedBusinessMessage(body), "This business is paused because the Free plan includes 1 business. Upgrade to resume new posts; your existing posts are still available.");
      assert.equal(quotaMetMessage(body, usageOf(body)), null);
      // Quota met: the route reports the used-up week and the message names the Free limit.
      await c.query("INSERT INTO generation_periods(business_id,period_start,timezone,target,allocated,completed) VALUES($1,$2,'UTC',1,1,1)", [apiBusiness, usageOf(body).weekStart]);
      const metBody = await (await entitlementsRoute.GET(request("/api/entitlements"))).json();
      assert.equal(usageOf(metBody).allocated, 1);
      assert.equal(usageOf(metBody).quotaMet, true);
      assert.match(quotaMetMessage(metBody, usageOf(metBody))!, /Free plan includes 1 post a week/);
      assert.equal(expiryNote(metBody), null);

      // Pro with the full quota used: the target is the owner's own, so the message names the Pro allowance.
      const proUsage = (await entitlementsWithUsage("pro-owner", now)).usage[0];
      assert.equal(proUsage.allocated, 5);
      assert.equal(proUsage.target, 5);
      assert.equal(proUsage.quotaMet, true);
      const proPlan = await entitlementsWithUsage("pro-owner", now);
      assert.match(quotaMetMessage(proPlan, proUsage)!, /made all 5 posts.*Pro plan allows up to 5/);

      // A Free owner who asked for 3 is held to 1 by the plan, even though 3 drafts were allocated while on Pro.
      const downgraded = await entitlementsWithUsage("free-owner", now);
      assert.equal(downgraded.plan, "free");
      assert.equal(downgraded.usage[0].allocated, 3);
      assert.equal(downgraded.usage[0].target, 1);
      assert.equal(downgraded.usage[0].weeklyTarget, 3);

      // Expired Pro reads as Free with an expiry note, and usage follows the Free cap.
      await business("expired-owner", "Expired synthetic");
      const expiredView = await entitlementsWithUsage("expired-owner", now);
      assert.equal(expiredView.plan, "free");
      assert.equal(expiredView.usage[0].target, 1);
      assert.equal(expiredView.usage[0].allocated, 0);
      assert.equal(expiryNote(expiredView), "Your Pro plan expired on 2020-01-01, so you are on the Free plan.");
      assert.equal(expiryNote(await entitlementsWithUsage("pro-owner", now)), null, "an open-ended Pro plan has no expiry note");

      // Expired Business also reads as Free, keeps its row, and names Business in the note.
      const expiredBusinessBusiness = await business("expired-business-owner", "Expired Business synthetic");
      const expiredBusinessView = await entitlementsWithUsage("expired-business-owner", now);
      assert.equal(expiredBusinessView.plan, "free");
      assert.equal(expiredBusinessView.expired, true);
      assert.equal(expiredBusinessView.expiredPlan, "business");
      assert.equal(expiredBusinessView.usage[0].target, 1);
      assert.equal(expiredBusinessView.usage[0].allocated, 0);
      assert.equal(expiryNote(expiredBusinessView), "Your Business plan expired on 2020-01-01, so you are on the Free plan.");
      assert.equal((await c.query("SELECT count(*) n FROM businesses WHERE id=$1", [expiredBusinessBusiness])).rows[0].n, "1", "expiry keeps the Business data");
      assert.equal((await c.query("SELECT plan FROM owner_plans WHERE owner_id='expired-business-owner'")).rows[0].plan, "business", "expiry keeps the stored Business plan for renewal");

      // A downgrade keeps every business but pauses the ones over the plan limit. The
      // oldest businesses (created_at, then id) stay active; renewing resumes the rest.
      await setOwnerPlan("over-limit-owner", "business", { reason: "Synthetic Business plan before downgrade" });
      const overBusiness = async (name: string, createdAt: string) =>
        Number((await c.query("INSERT INTO businesses(name,timezone,owner_id,created_at,weekly_target) VALUES($1,'UTC','over-limit-owner',$2,5) RETURNING id", [name, createdAt])).rows[0].id);
      const overNewest = await overBusiness("Newest synthetic", "2026-01-03T00:00:00Z");
      const overOldest = await overBusiness("Oldest synthetic", "2026-01-01T00:00:00Z");
      const overMiddle = await overBusiness("Middle synthetic", "2026-01-02T00:00:00Z");
      await reviews(overOldest); await reviews(overMiddle); await reviews(overNewest);
      assert.deepEqual((await businessAllowance("over-limit-owner", 5)).active, [overOldest, overMiddle, overNewest], "created_at decides the order, not the id");
      assert.deepEqual((await businessAllowance("over-limit-owner", 5)).paused, []);

      // A draft created while the business was allowed stays visible and approved after the pause.
      const pausedDraft = Number((await c.query("INSERT INTO draft_posts(business_id,quote_text,caption_text,status,created_at) VALUES($1,'Synthetic paused quote','Synthetic paused caption','approved',now()-interval '30 days') RETURNING id", [overNewest])).rows[0].id);
      await setOwnerPlan("over-limit-owner", "free", { reason: "Synthetic downgrade to Free" });
      const downgradedBusinesses = await businessAllowance("over-limit-owner", 1);
      assert.deepEqual(downgradedBusinesses.active, [overOldest]);
      assert.deepEqual(downgradedBusinesses.paused, [overMiddle, overNewest]);
      const overUsage = await entitlementsWithUsage("over-limit-owner", now);
      assert.equal(overUsage.usage.find(u => u.businessId === overOldest)?.paused, false);
      assert.equal(overUsage.usage.find(u => u.businessId === overMiddle)?.paused, true);
      assert.equal(overUsage.usage.find(u => u.businessId === overNewest)?.paused, true);
      const pausedRequest = await requestGeneration(overNewest, 5, now);
      assert.equal(pausedRequest.inserted, 0);
      assert.equal(pausedRequest.reason, "business_paused");
      assert.equal((await c.query("SELECT count(*) n FROM generation_periods WHERE business_id=$1", [overNewest])).rows[0].n, "0", "a paused business reserves no quota");
      assert.equal((await c.query("SELECT count(*) n FROM draft_posts WHERE business_id=$1", [overNewest])).rows[0].n, "1", "pausing keeps existing drafts");
      assert.equal((await c.query("SELECT status FROM draft_posts WHERE id=$1", [pausedDraft])).rows[0].status, "approved", "existing drafts can still be approved");
      assert.equal((await requestGeneration(overOldest, 5, now)).inserted, 1, "the oldest business keeps generating on Free");
      assert.equal((await c.query("SELECT count(*) n FROM businesses WHERE owner_id='over-limit-owner'")).rows[0].n, "3", "a downgrade deletes nothing");
      await setOwnerPlan("over-limit-owner", "business", { reason: "Synthetic renewal" });
      assert.equal((await entitlementsWithUsage("over-limit-owner", now)).usage.every(u => u.paused === false), true, "renewing resumes every business");
      assert.equal((await requestGeneration(overNewest, 5, now)).inserted, 5, "the resumed business generates again");

      // The This Week notice depends only on usage, not on which posts are still listed, so a
      // Free owner who skipped their one allocated post still sees the plan limit and reset day.
      assert.equal(
        weekLimitNotice(metBody, usageOf(metBody)),
        `${quotaMetMessage(metBody, usageOf(metBody))} New posts start ${formatLocalDate(usageOf(metBody).resetsOn)}.`
      );
      assert.equal(weekLimitNotice(body, { ...usageOf(body), quotaMet: false }), null, "no notice while there is room");
      assert.match(weekLimitNotice(expiredView, { ...expiredView.usage[0], allocated: 1, quotaMet: true })!, /Free plan includes 1 post.*Your Pro plan expired on 2020-01-01/);
      assert.equal(expiredView.expired, true);
      assert.equal(expiredView.expiredPlan, "pro");
      assert.equal(proPlan.expired, false);
      assert.equal(proPlan.expiredPlan, null);
      assert.equal(entitlementsForPlan("free", "default", "2020-01-01T00:00:00Z").expired, false, "a Free plan with a past date is not an expired paid plan");
      assert.equal(entitlementsForPlan("free", "default", "2020-01-01T00:00:00Z").expiredPlan, null);

      const businessesRoute = require("../app/api/businesses/route");
      const retried = await businessesRoute.POST(request("/api/businesses", "POST", { name: "Retried synthetic", timezone: "UTC", onboardingKey }));
      assert.equal(retried.status, 201);
      assert.equal((await retried.json()).business.id, apiBusiness, "a repeated onboarding key returns the original business");
      const limited = await businessesRoute.POST(request("/api/businesses", "POST", { name: "Second synthetic", timezone: "UTC" }));
      assert.equal(limited.status, 403);
      assert.equal((await limited.json()).code, "business_limit_reached");
      assert.equal((await c.query("SELECT count(*) n FROM businesses WHERE owner_id='api-owner'")).rows[0].n, "1");

      // A Free owner cannot save a Pro design, a Pro owner can, and a downgrade keeps
      // the saved choice while new renders fall back to the Free design.
      const businessRoute = require("../app/api/businesses/[id]/route");
      const patchBusiness = (body: unknown) => businessRoute.PATCH(
        request(`/api/businesses/${apiBusiness}`, "PATCH", body),
        { params: Promise.resolve({ id: String(apiBusiness) }) }
      );
      const proDesign = { primary: "#ffffff", secondary: "#111111", template: "quote-card-v2", quoteSize: "standard" };
      const refused = await patchBusiness({ brandColors: proDesign });
      assert.equal(refused.status, 403);
      assert.equal((await refused.json()).code, "template_limit_reached");
      assert.equal((await c.query("SELECT brand_colors->>'template' t FROM businesses WHERE id=$1", [apiBusiness])).rows[0].t, null, "a refused save changes nothing");

      await setOwnerPlan("api-owner", "pro", { reason: "Synthetic template test" });
      const allowed = await patchBusiness({ brandColors: proDesign });
      assert.equal(allowed.status, 200);
      assert.equal((await allowed.json()).business.brand_colors.template, "quote-card-v2");
      const proRender = await renderDraftImage({
        draftPostId: 970, businessName: "Synthetic design", quoteText: "A warm synthetic welcome",
        brandHex: proDesign.primary, secondaryBrandHex: proDesign.secondary,
        templateConfig: proDesign, templatesAllowed: PLAN_LIMITS.pro.templates
      });
      const proRenderBytes = readFileSync(proRender.fileSystemPath);

      await setOwnerPlan("api-owner", "free", { reason: "Synthetic downgrade" });
      const kept = await patchBusiness({ brandColors: { ...proDesign, primary: "#eeeeee" } });
      assert.equal(kept.status, 200, "an unchanged saved design may still be saved after a downgrade");
      assert.equal((await c.query("SELECT brand_colors->>'template' t FROM businesses WHERE id=$1", [apiBusiness])).rows[0].t, "quote-card-v2");
      const fallback = await renderDraftImage({
        draftPostId: 971, businessName: "Synthetic design", quoteText: "A warm synthetic welcome",
        brandHex: proDesign.primary, secondaryBrandHex: proDesign.secondary,
        templateConfig: { ...proDesign, primary: "#eeeeee" }, templatesAllowed: PLAN_LIMITS.free.templates
      });
      const freeDesign = await renderDraftImage({
        draftPostId: 971, businessName: "Synthetic design", quoteText: "A warm synthetic welcome",
        brandHex: proDesign.primary, secondaryBrandHex: proDesign.secondary,
        templateConfig: { template: "quote-card-v1", primary: "#eeeeee", secondary: "#111111" }, templatesAllowed: PLAN_LIMITS.free.templates
      });
      assert.deepEqual(readFileSync(fallback.fileSystemPath), readFileSync(freeDesign.fileSystemPath), "an expired or downgraded plan renders quote-card-v1");
      assert.deepEqual(readFileSync(proRender.fileSystemPath), proRenderBytes, "an image rendered before the downgrade does not change");
    });

    // The watermark is part of the deterministic render input and sits below
    // the card content, so it is visible without covering names or the logo.
    const base = { draftPostId: 950, businessName: "Synthetic Café", quoteText: "A warm and welcoming synthetic visit", brandHex: "#1f2937", rating: 5, authorName: "Synthetic reviewer" };
    const marked = await renderDraftImage({ ...base, watermark: true });
    const clean = await renderDraftImage({ ...base, watermark: false });
    const markedBytes = readFileSync(marked.fileSystemPath), cleanBytes = readFileSync(clean.fileSystemPath);
    assert.notDeepEqual(markedBytes, cleanBytes);
    const brightest = async (bytes: Buffer) => {
      const { data } = await sharp(bytes).extract({ left: 420, top: 1008, width: 240, height: 40 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      return data.reduce((max, value) => Math.max(max, value), 0);
    };
    assert.ok(await brightest(markedBytes) > 200, "the watermark is visible in the bottom margin");
    assert.ok(await brightest(cleanBytes) < 100, "no mark for a pro/free-omitted render");
    const repeated = await renderDraftImage({ ...base, watermark: true });
    assert.deepEqual(readFileSync(repeated.fileSystemPath), markedBytes, "the watermark render is deterministic");

    console.log("plan limits, weekly cap, watermark, business limit, read-only API and audit tests passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
