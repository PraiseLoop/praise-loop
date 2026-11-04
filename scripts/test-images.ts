import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import { foreground, renderDraftImage } from "../lib/services/imageRenderer";
import { QUOTE_TEMPLATES } from "../lib/branding";

// A frozen copy of the original quote-card-v1 renderer. The production design
// must stay byte-identical to this on every host, not just in this environment.
const legacyFont = resolve("assets/fonts/BricolageGrotesque.ttf");
const legacyEscape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const legacyFace = (weight: "Regular" | "SemiBold") => existsSync(legacyFont)
  ? { font: `Bricolage Grotesque ${weight === "Regular" ? "" : weight}`.trim(), fontfile: legacyFont }
  : { font: weight === "Regular" ? "DejaVu Sans" : "DejaVu Sans Bold" };
async function legacyLayout(text: string, width: number, height: number, sizes: number[], fill: string, type: { font: string; fontfile?: string }, align: "left" | "right" = "left") {
  for (const size of sizes) {
    const { data, info } = await sharp({ text: {
      text: `<span foreground="${fill}">${legacyEscape(text)}</span>`,
      font: `${type.font} ${size}`, fontfile: type.fontfile, width, align, rgba: true, wrap: "word-char", dpi: 72
    } }).png().toBuffer({ resolveWithObject: true });
    if (info.width <= width && info.height <= height) return { input: data, width: info.width, height: info.height };
  }
  throw new Error("legacy text does not fit");
}
function legacyStars(rating: number, fill: string) {
  const star = "M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z";
  const paths = Array.from({ length: rating }, (_, n) => `<path transform="translate(${n * 52} 0) scale(1.83)" d="${star}"/>`).join("");
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${rating * 52}" height="44" fill="${fill}">${paths}</svg>`);
}
async function legacyQuoteCardV1(params: { businessName: string; quoteText: string; brandHex: string; secondaryBrandHex: string; rating: number; authorName: string }) {
  const primary = params.brandHex, secondary = params.secondaryBrandHex, ink = foreground(primary);
  const business = await legacyLayout(params.businessName, 560, 80, [26, 24, 22, 20], ink, legacyFace("Regular"), "right");
  const author = await legacyLayout(`— ${params.authorName}`, 920, 90, [34, 30, 26, 22], ink, legacyFace("SemiBold"));
  const authorTop = 1000 - author.height;
  const quoteTop = Math.max(172, 80 + business.height + 40), quoteBottom = Math.min(authorTop, 1080) - 40;
  const quote = await legacyLayout(`“${params.quoteText}”`, 920, quoteBottom - quoteTop, [48, 44, 40, 36, 32], ink, legacyFace("SemiBold"));
  const layers: OverlayOptions[] = [
    { input: { create: { width: 1080, height: 14, channels: 4, background: secondary } }, top: 0, left: 0 },
    { input: quote.input, top: quoteTop + Math.floor((quoteBottom - quoteTop - quote.height) / 2), left: 80 },
    { input: business.input, top: 80, left: 1000 - business.width },
    { input: legacyStars(params.rating, ink === "#ffffff" ? "#F4B731" : "#9A5A0B"), top: 80, left: 80 },
    { input: author.input, top: authorTop, left: 80 }
  ];
  return sharp({ create: { width: 1080, height: 1080, channels: 4, background: primary } }).composite(layers).png().toBuffer();
}
async function main() {
  const root = mkdtempSync(join(tmpdir(), "quote-cards-"));
  process.env.MEDIA_ROOT = root;
  try {
    const logo = await sharp({ create: { width: 30, height: 30, channels: 3, background: "#ff0000" } }).png().toBuffer();
    const base = { draftPostId: 901, businessName: "Synthetic Café & Bakery", quoteText: "Warm welcome, lovely coffee — merci! Καλημέρα", brandHex: "#ffffff", logoUrl: `data:image/png;base64,${logo.toString("base64")}`, rating: 5, authorName: "Synthetic reviewer" };
    const result = await renderDraftImage(base);
    const bytes = readFileSync(result.fileSystemPath);
    const meta = await sharp(bytes).metadata();
    assert.equal(meta.width, 1080); assert.equal(meta.height, 1080); assert.equal(meta.format, "png");
    const pixel = await sharp(bytes).extract({ left: 920, top: 920, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    assert.deepEqual([...pixel], [255, 0, 0], "actual logo pixels appear bottom right");
    const star = await sharp(bytes).extract({ left: 102, top: 104, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    assert.deepEqual([...star], [0x9a, 0x5a, 0x0b], "rating stars appear top left");
    const reviewer = await sharp(bytes).extract({ left: 80, top: 860, width: 700, height: 140 }).stats();
    assert.ok(reviewer.channels[0].min < 50, "the reviewer's name is drawn bottom left as the signature");
    const header = await sharp(bytes).extract({ left: 420, top: 80, width: 580, height: 60 }).stats();
    assert.ok(header.channels[0].min < 50, "the business name is drawn top right as a brand header");
    // The signature is the reviewer alone: no author means an empty signature area, never the business name.
    const unsigned = readFileSync((await renderDraftImage({ ...base, draftPostId: 906, authorName: null, quoteText: "A short synthetic quote" })).fileSystemPath);
    const signatureArea = await sharp(unsigned).extract({ left: 80, top: 880, width: 700, height: 120 }).removeAlpha().raw().toBuffer();
    assert.ok(signatureArea.every(value => value === 255), "a review without a reviewer name has no signature");
    const unsignedHeader = await sharp(unsigned).extract({ left: 420, top: 80, width: 580, height: 60 }).stats();
    assert.ok(unsignedHeader.channels[0].min < 50, "the business name still appears as the header");
    // The header sits level with the stars, and the quote never starts under it.
    const longName = readFileSync((await renderDraftImage({ ...base, draftPostId: 907, rating: null, businessName: "Synthetic Café & Bakery of the Greater Synthetic Region", quoteText: "A short synthetic quote" })).fileSystemPath);
    const headerGap = await sharp(longName).extract({ left: 80, top: 140, width: 920, height: 20 }).removeAlpha().raw().toBuffer();
    assert.ok(headerGap.every(value => value === 255), "the header does not run into the quote area");
    const region = await sharp(bytes).extract({ left: 80, top: 300, width: 920, height: 650 }).stats();
    assert.ok(region.channels[0].min < 50, "real text backend draws visible quote glyphs");
    assert.equal(foreground("#ffffff"), "#000000"); assert.equal(foreground("#000000"), "#ffffff");
    const changed = await renderDraftImage({ ...base, draftPostId: 902, quoteText: "A different synthetic quote" });
    assert.notDeepEqual(bytes, readFileSync(changed.fileSystemPath));
    // quote-card-v1 is frozen: the production renderer must still produce the
    // original layout's bytes, so existing businesses and images never change.
    const golden = {
      businessName: "Synthetic Café", quoteText: "A warm and welcoming synthetic visit",
      brandHex: "#1f2937", secondaryBrandHex: "#374151", rating: 5, authorName: "Synthetic reviewer"
    };
    const frozen = await legacyQuoteCardV1(golden);
    const current = await renderDraftImage({
      ...golden, draftPostId: 908, templateConfig: { template: "quote-card-v1", quoteSize: "standard" }
    });
    assert.deepEqual(readFileSync(current.fileSystemPath), frozen, "quote-card-v1 output stays byte-identical");
    await renderDraftImage({ ...base, draftPostId: 903, logoUrl: null, rating: null, authorName: null, brandHex: "#000000", businessName: "A long synthetic business name with several words".repeat(2), quoteText: "A beautifully welcoming place. ".repeat(22) });
    await renderDraftImage({ ...base, draftPostId: 904, authorName: "Maximiliana Alexandrina\nWolfeschlegelsteinhausen-Bergerdorff of Synthetic Upon Avon" });
    await assert.rejects(renderDraftImage({ ...base, authorName: "Synthetic reviewer ".repeat(20) }), /does not fit/, "an unfit reviewer name is rejected, not dropped");
    const crowded = readFileSync((await renderDraftImage({ ...base, draftPostId: 905, authorName: null, quoteText: "W".repeat(240) })).fileSystemPath);
    // The logo is drawn last and would hide an overlapping quote, so check the quote ends above it.
    const gap = await sharp(crowded).extract({ left: 80, top: 822, width: 920, height: 36 }).removeAlpha().raw().toBuffer();
    assert.ok(gap.every(value => value === 255), "a long quote stops above the logo");
    await assert.rejects(renderDraftImage({ ...base, logoUrl: "http://169.254.169.254/secret" }), /remote URLs/);
    await assert.rejects(renderDraftImage({ ...base, logoUrl: "data:image/png;base64,YWJj" }), /Invalid raster/);
    await assert.rejects(renderDraftImage({ ...base, quoteText: "word ".repeat(1500) }), /too long/);
    await assert.rejects(renderDraftImage({ ...base, brandHex: "red" }), /hexadecimal/);

    // Every design is deterministic, distinct, and keeps a long quote, logo, reviewer
    // and free watermark inside the card rather than cutting any of them off.
    const designs = new Map<string, Buffer>();
    const longQuote = "A warm welcome, thoughtful service and a genuine sense of care. ".repeat(11);
    const logos: Record<string, [number, number]> = {
      "quote-card-v1": [920, 920], "quote-card-v2": [120, 120], "quote-card-v3": [920, 900], "quote-card-v4": [920, 900]
    };
    for (const [index, template] of QUOTE_TEMPLATES.entries()) {
      const templateConfig = { primary: "#ffffff", secondary: "#111111", template, quoteSize: "large" };
      const first = await renderDraftImage({ ...base, draftPostId: 920 + index, templateConfig, watermark: true });
      const second = await renderDraftImage({ ...base, draftPostId: 920 + index, templateConfig: JSON.parse(JSON.stringify(templateConfig)), watermark: true });
      assert.equal(second.publicPath, first.publicPath, `${template} is content-addressed from the same input`);
      const bytes = readFileSync(first.fileSystemPath);
      assert.deepEqual(readFileSync(second.fileSystemPath), bytes, `${template} renders deterministically`);
      designs.set(template, bytes);
      const [left, top] = logos[template];
      const pixel = await sharp(bytes).extract({ left, top, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
      assert.deepEqual([...pixel], [255, 0, 0], `${template} draws the logo without covering the quote`);
      // The longest supported synthetic quote still shrinks to fit every design.
      const long = await renderDraftImage({ ...base, draftPostId: 930 + index, templateConfig: { ...templateConfig, quoteSize: "standard" }, quoteText: longQuote, watermark: true });
      const longBytes = readFileSync(long.fileSystemPath);
      const quoteArea = await sharp(longBytes).extract({ left: 80, top: 200, width: 920, height: 500 }).stats();
      assert.ok(quoteArea.channels[0].min < 50, `${template} draws a long quote`);
    }
    assert.notDeepEqual(designs.get("quote-card-v1"), designs.get("quote-card-v2"), "the designs are visibly different");
    assert.notDeepEqual(designs.get("quote-card-v2"), designs.get("quote-card-v3"));
    assert.notDeepEqual(designs.get("quote-card-v3"), designs.get("quote-card-v4"));
    // A saved design outside the plan falls back to quote-card-v1, while the other
    // plans' renders and the files already on disk stay byte-identical.
    const savedV1 = readFileSync((await renderDraftImage({ ...base, draftPostId: 940, templateConfig: { template: "quote-card-v1", primary: "#ffffff", secondary: "#111111" } })).fileSystemPath);
    const proOnly = await renderDraftImage({ ...base, draftPostId: 940, templateConfig: { template: "quote-card-v2", primary: "#ffffff", secondary: "#111111" }, templatesAllowed: 1 });
    assert.equal(proOnly.publicPath, (await renderDraftImage({ ...base, draftPostId: 940, templateConfig: { template: "quote-card-v1", primary: "#ffffff", secondary: "#111111" } })).publicPath, "the fallback uses the v1 content address");
    assert.deepEqual(readFileSync(proOnly.fileSystemPath), savedV1, "the fallback is byte-identical to the saved v1 render");
    const savedPro = await renderDraftImage({ ...base, draftPostId: 941, templateConfig: { template: "quote-card-v2", primary: "#ffffff", secondary: "#111111" }, templatesAllowed: 4 });
    const savedProBytes = readFileSync(savedPro.fileSystemPath);
    const changedPlan = await renderDraftImage({ ...base, draftPostId: 941, templateConfig: { template: "quote-card-v2", primary: "#ffffff", secondary: "#111111" }, templatesAllowed: 1 });
    assert.notEqual(changedPlan.publicPath, savedPro.publicPath, "a downgraded render gets a new content address");
    assert.deepEqual(readFileSync(savedPro.fileSystemPath), savedProBytes, "an image rendered before the downgrade does not change");
    // Optional review evidence persists outside source control.
    if (process.env.IMAGE_EVIDENCE_DIR) {
      const { mkdirSync, copyFileSync, readdirSync } = await import("node:fs");
      mkdirSync(process.env.IMAGE_EVIDENCE_DIR, { recursive: true });
      for (const id of [901, 902, 903]) copyFileSync(join(root, readdirSync(root).find(n => n.startsWith(`draft-${id}-`))!), join(process.env.IMAGE_EVIDENCE_DIR, `synthetic-${id}.png`));
    }
    console.log("real raster layout/logo/overflow tests passed");
  } finally { rmSync(root, { recursive: true, force: true }); }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
