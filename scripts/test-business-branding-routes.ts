const lifecycle = require("../lib/services/draftLifecycle");
lifecycle.draftMutation = (_action: string, handler: unknown) => handler;
// Domain regressions bypass the boundary; test-authorization exercises real guards.
const boundary = require("../lib/authorization");
boundary.ownerRoute = (handler: unknown) => handler;
boundary.currentOwner = () => "synthetic-owner";
import assert from "node:assert/strict";

const dbModule = require("../lib/db");
const entitlementsModule = require("../lib/services/entitlements");
const captionsModule = require("../lib/services/captions");
const imageRendererModule = require("../lib/services/imageRenderer");

// Domain route tests stub Postgres and use a fake plan; the real plan checks
// run against a database in test-entitlements.ts.
entitlementsModule.entitlementsFor = async () => ({
  plan: "pro", source: "manual", expiresAt: null,
  limits: { postsPerWeek: 5, templates: 5, watermark: false, reviewSync: true, aiReplies: true, automaticPosting: true, businesses: 100 }
});
dbModule.transaction = async (run: (client: { query: unknown }) => Promise<unknown>) => run({ query: dbModule.query });

function makeJsonRequest(body: unknown) {
  return {
    json: async () => body
  } as any;
}

async function postNormalizesToneAndColorsTest() {
  let capturedParams: unknown[] = [];

  dbModule.query = async (sql: string, params: unknown[]) => {
    if (!sql.includes("INSERT INTO businesses")) return { rows: [{ n: "0" }], rowCount: 1 };
    capturedParams = params;
    return {
      rows: [
        {
          id: 1,
          name: "Tone Test",
          logo_url: null,
          brand_tone: params[4],
          brand_colors: JSON.parse(String(params[2]))
        }
      ],
      rowCount: 1
    };
  };

  const businessesRoute = require("../app/api/businesses/route");
  const res = await businessesRoute.POST(
    makeJsonRequest({
      name: "Tone Test",
      primaryColor: "NOT-HEX",
      secondaryColor: " 123456 ",
      brandTone: "LOUD"
    })
  );

  assert.equal(res.status, 201);
  assert.equal(capturedParams[4], "friendly", "invalid tone should fall back to friendly");
  assert.deepEqual(JSON.parse(String(capturedParams[2])), {
    primary: "#1f2937",
    secondary: "#123456", template: "quote-card-v1", quoteSize: "standard"
  });
}

async function patchRejectsInvalidHexTest() {
  let queryCalled = false;

  dbModule.query = async () => {
    queryCalled = true;
    return { rows: [], rowCount: 0 };
  };

  const businessByIdRoute = require("../app/api/businesses/[id]/route");
  const res = await businessByIdRoute.PATCH(
    makeJsonRequest({
      primaryColor: "#12345",
      secondaryColor: "#111111",
      brandTone: "premium"
    }),
    { params: Promise.resolve({ id: "77" }) }
  );

  assert.equal(res.status, 400);
  assert.equal(queryCalled, false, "invalid hex should be rejected before DB query");
}

async function patchMissingBusinessAndToneFallbackTest() {
  let capturedParams: unknown[] = [];

  dbModule.query = async (_sql: string, params: unknown[]) => {
    capturedParams = params;
    return { rows: [], rowCount: 0 };
  };

  const businessByIdRoute = require("../app/api/businesses/[id]/route");
  const res = await businessByIdRoute.PATCH(
    makeJsonRequest({
      primaryColor: "#111111",
      secondaryColor: "222222",
      brandTone: "serious"
    }),
    { params: Promise.resolve({ id: "999" }) }
  );

  assert.equal(res.status, 404);
  assert.equal(capturedParams[3], "friendly", "invalid patch tone should fall back to friendly");
}

async function captionsRoutePropagatesToneTest() {
  let capturedTone: string | null = null;

  dbModule.query = async () => ({
    rows: [{ id: 44, quote_text: "Amazing!", business_name: "Cafe", brand_tone: "playful" }],
    rowCount: 1
  });

  captionsModule.generateCaptionVariants = async (input: any) => {
    capturedTone = input.brandTone;
    return { friendly: "a", premium: "b", playful: "c" };
  };

  const captionsRoute = require("../app/api/captions/generate/route");
  const res = await captionsRoute.POST(makeJsonRequest({ draftPostId: 44 }));

  assert.equal(res.status, 200);
  assert.equal(capturedTone, "playful");
}

async function imageRenderRoutePropagatesToneTest() {
  let capturedTone: string | null = null;

  dbModule.query = async (sql: string) => {
    if (sql.includes("SELECT d.id")) {
      return {
        rows: [
          {
            id: 55,
            quote_text: "Great",
            business_name: "Deli",
            brand_colors: { primary: "#111111", secondary: "#222222" },
            logo_url: null,
            brand_tone: "premium"
          }
        ],
        rowCount: 1
      };
    }
    return { rows: [{ id: 55, image_path: "/generated/55.png" }], rowCount: 1 };
  };

  imageRendererModule.renderDraftImage = async (input: any) => {
    capturedTone = input.brandTone;
    return { publicPath: "/generated/55.png" };
  };

  const imagesRoute = require("../app/api/images/render/route");
  const res = await imagesRoute.POST(makeJsonRequest({ draftPostId: 55 }));

  assert.equal(res.status, 200);
  assert.equal(capturedTone, "premium");
}

async function main() {
  await postNormalizesToneAndColorsTest();
  await patchRejectsInvalidHexTest();
  await patchMissingBusinessAndToneFallbackTest();
  await captionsRoutePropagatesToneTest();
  await imageRenderRoutePropagatesToneTest();
  console.log("business branding route tests passed");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
