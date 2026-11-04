import { databaseFixture } from "./db-fixture";
import assert from "node:assert/strict";
import { QUOTE_TEMPLATES, quoteOptions, templateForLimit, validBrandConfig, parseBrandColors } from "../lib/branding";
import { renderQuoteCard } from "../lib/services/imageRenderer";
const boundary = require("../lib/authorization");
boundary.ownerRoute = (handler: unknown) => handler;
boundary.currentOwner = () => "synthetic-owner";
const { POST } = require("../app/api/branding/preview/route");
import { NextRequest } from "next/server";
async function main() {
  assert.deepEqual(quoteOptions(undefined), { template: "quote-card-v1", quoteSize: "standard" });
  assert.deepEqual(QUOTE_TEMPLATES, ["quote-card-v1", "quote-card-v2", "quote-card-v3", "quote-card-v4"]);
  for (const template of QUOTE_TEMPLATES) assert.equal(quoteOptions({ template }).template, template);
  assert.throws(() => quoteOptions({ template: "unknown" }));
  assert.throws(() => quoteOptions({ quoteSize: "tiny" }));
  assert.equal(templateForLimit("quote-card-v2", 1), "quote-card-v1");
  assert.equal(templateForLimit("quote-card-v2", 4), "quote-card-v2");
  assert.equal(validBrandConfig({ primary: "not-a-color" }), false);
  assert.equal(validBrandConfig([]), false);
  const config = parseBrandColors({ primary: " ffffff ", secondary: "000000", quoteSize: "large" });
  assert.equal(config.primary, "#ffffff"); assert.equal(config.quoteSize, "large");
  const reloaded = JSON.parse(JSON.stringify(config));
  const args = { draftPostId: 0, businessName: "Synthetic", quoteText: "Thoughtful service", templateConfig: reloaded };
  assert.deepEqual(await renderQuoteCard(args), await renderQuoteCard({ ...args, templateConfig: config }));
  const rendered = new Map<string, Buffer>();
  for (const template of QUOTE_TEMPLATES) {
    const templateConfig = { ...config, template };
    const first = await renderQuoteCard({ ...args, templateConfig });
    const second = await renderQuoteCard({ ...args, templateConfig: JSON.parse(JSON.stringify(templateConfig)) });
    assert.deepEqual(second, first, `${template} renders deterministically from the same input`);
    assert.ok(first.length > 0);
    rendered.set(template, first);
  }
  assert.notDeepEqual(rendered.get("quote-card-v1"), rendered.get("quote-card-v2"), "each design has a distinct layout");
  assert.notDeepEqual(rendered.get("quote-card-v2"), rendered.get("quote-card-v3"));
  assert.notDeepEqual(rendered.get("quote-card-v3"), rendered.get("quote-card-v4"));
  // A saved pro design on a plan that only includes one still renders the original, unchanged design.
  const fallback = await renderQuoteCard({ ...args, templateConfig: { ...config, template: "quote-card-v2" }, templatesAllowed: 1 });
  assert.deepEqual(fallback, rendered.get("quote-card-v1"), "a plan-limited render falls back to quote-card-v1");
  const request = (body: unknown) => new NextRequest("http://localhost/api/branding/preview", { method: "POST", body: JSON.stringify(body) });
  const preview = await POST(request({ brandColors: config }));
  assert.equal(preview.status, 200); assert.equal(preview.headers.get("content-type"), "image/png");
  for (const template of QUOTE_TEMPLATES) {
    assert.equal((await POST(request({ brandColors: { ...config, template } }))).status, 200, `${template} previews`);
  }
  assert.equal((await POST(request({ brandColors: { template: "wrong" } }))).status, 400);
  await databaseFixture(async client => {
    const row = (await client.query("SELECT brand_colors FROM businesses WHERE name='Synthetic migration fixture'")).rows[0];
    assert.equal(row.brand_colors.primary, "#abcdef"); assert.equal(row.brand_colors.template, "quote-card-v1");
    await client.query("UPDATE businesses SET brand_colors = brand_colors || $1::jsonb", [JSON.stringify(config)]);
    const saved = (await client.query("SELECT brand_colors FROM businesses LIMIT 1")).rows[0].brand_colors;
    assert.equal(saved.quoteSize, "large"); assert.equal(saved.template, "quote-card-v1");
  }, async (name, client) => {
    if (name === "005_quote_template.sql") await client.query("INSERT INTO businesses(name,timezone,brand_colors) VALUES('Synthetic migration fixture','UTC','{\"primary\":\"#abcdef\"}')");
  });
  console.log("template default/validation/persistence/render/preview tests passed");
}
main().catch(err => { console.error(err); process.exitCode = 1; });
