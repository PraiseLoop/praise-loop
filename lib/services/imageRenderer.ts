import { rasterLogo } from "./logos";
import { existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import sharp, { type OverlayOptions } from "sharp";
import { quoteOptions, templateForLimit, type BrandTone, type QuoteOptions } from "../branding";
import { draftImageFilename, draftImageUrl, mediaRoot } from "./media";

const escapeMarkup = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
export function foreground(hex: string): string {
  const rgb = hex.slice(1).match(/../g)!.map(c => parseInt(c, 16) / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#000000" : "#ffffff";
}
function color(value: string | null | undefined, fallback: string) {
  if (!value) return fallback;
  if (!/^#[a-f\d]{6}$/i.test(value)) throw new Error("Use six-digit hexadecimal brand colors");
  return value;
}
// Bricolage Grotesque ships in the repo (assets/fonts, SIL OFL) so cards look the same on every
// host; Pango still falls back to the system Noto fonts for scripts it does not cover.
const brandFontFile = resolve("assets/fonts/BricolageGrotesque.ttf");
type Face = { font: string; fontfile?: string };
function face(weight: "SemiBold" | "Regular", serif = false): Face {
  if (serif) return { font: "DejaVu Serif" };
  if (existsSync(brandFontFile)) return { font: `Bricolage Grotesque ${weight === "Regular" ? "" : weight}`.trim(), fontfile: brandFontFile };
  return { font: weight === "Regular" ? "DejaVu Sans" : "DejaVu Sans Bold" };
}
async function layout(text: string, width: number, height: number, sizes: number[], fill: string, type: Face, align: "left" | "right" | "centre" = "left") {
  if (!text.trim() || text.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    throw new Error("Text is empty, unsupported, or too long; select a shorter verbatim quote");
  }
  for (const size of sizes) {
    const { data, info } = await sharp({ text: {
      text: `<span foreground="${fill}">${escapeMarkup(text)}</span>`,
      font: `${type.font} ${size}`, fontfile: type.fontfile, width, align, rgba: true, wrap: "word-char", dpi: 72
    }}).png().toBuffer({ resolveWithObject: true });
    if (info.width <= width && info.height <= height) return { input: data, width: info.width, height: info.height };
  }
  throw new Error("Text does not fit safely; select a shorter verbatim quote or business display name");
}
function stars(rating: number, fill: string) {
  const star = "M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z";
  const paths = Array.from({ length: rating }, (_, n) => `<path transform="translate(${n * 52} 0) scale(1.83)" d="${star}"/>`).join("");
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${rating * 52}" height="44" fill="${fill}">${paths}</svg>`);
}
export type RenderParams = {
  draftPostId: number; businessName: string; quoteText: string;
  brandHex?: string | null; secondaryBrandHex?: string | null;
  logoUrl?: string | null; brandTone?: BrandTone; templateConfig?: unknown;
  rating?: number | null; authorName?: string | null; watermark?: boolean;
  /** The plan's template allowance; omit when the caller is not rendering for a plan. */
  templatesAllowed?: number;
};
const cleanReviewer = (name?: string | null) => name?.replace(/\s+/g, " ").trim() ?? "";
const safeRating = (rating?: number | null) => Number.isInteger(rating) && rating! >= 1 && rating! <= 5 ? rating! : 0;
// quote-card-v1: stars top left and the business name top right as a small brand header, the verbatim
// quote, then the reviewer's name as the signature at the bottom left with the logo bottom right,
// inside 80px safe margins on a 1080px square. A review with no reviewer name has no signature: the
// business name is never promoted into it. This layout is frozen: existing renders must stay
// byte-identical, so new designs get their own functions below.
async function renderQuoteCardV1(params: RenderParams, options: QuoteOptions) {
  const primary = color(params.brandHex, "#1f2937"), secondary = color(params.secondaryBrandHex, "#374151");
  const ink = foreground(primary);
  const logo = await rasterLogo(params.logoUrl);
  const textWidth = logo ? 740 : 920;
  const rating = safeRating(params.rating);
  // The brand header shares the top row with the stars, so it gets the space to their right.
  const business = await layout(params.businessName, rating ? 560 : 920, 80, [26, 24, 22, 20], ink, face("Regular"), "right");
  // Reviewer names wrap to two lines and shrink like the quote; like the quote, one that still
  // doesn't fit is rejected rather than cut or silently dropped.
  const reviewer = cleanReviewer(params.authorName);
  const author = reviewer ? await layout(`— ${reviewer}`, textWidth, 90, [34, 30, 26, 22], ink, face("SemiBold")) : null;
  const authorTop = author ? 1000 - author.height : 1000;
  // The quote stops above the reviewer block, and above the bottom-right logo when there is one.
  const quoteTop = Math.max(rating ? 172 : 100, 80 + business.height + 40), quoteBottom = Math.min(authorTop, logo ? 860 : 1080) - 40;
  const quote = await layout(`“${params.quoteText}”`, 920, quoteBottom - quoteTop, options.quoteSize === "large" ? [56, 52, 48, 44, 40] : [48, 44, 40, 36, 32], ink, face("SemiBold", params.brandTone === "premium"));
  // Free-plan mark sits in the bottom safe margin, so it never covers the quote,
  // reviewer, business name or logo and needs no layout changes to the card.
  const watermark = params.watermark ? await layout("Praise Loop", 920, 32, [22, 20, 18, 16], ink, face("Regular")) : null;
  const layers: OverlayOptions[] = [
    { input: { create: { width: 1080, height: 14, channels: 4, background: secondary } }, top: 0, left: 0 },
    { input: quote.input, top: quoteTop + Math.floor((quoteBottom - quoteTop - quote.height) / 2), left: 80 },
    { input: business.input, top: 80, left: 1000 - business.width }
  ];
  if (rating) layers.push({ input: stars(rating, ink === "#ffffff" ? "#F4B731" : "#9A5A0B"), top: 80, left: 80 });
  if (author) layers.push({ input: author.input, top: authorTop, left: 80 });
  if (logo) layers.push({ input: logo, top: 860, left: 860 });
  if (watermark) layers.push({ input: watermark.input, top: 1012, left: Math.floor((1080 - watermark.width) / 2) });
  return sharp({ create: { width: 1080, height: 1080, channels: 4, background: primary } }).composite(layers).png().toBuffer();
}
// quote-card-v2: a centred poster. Logo top left, business name and stars centred above a centred
// quote, reviewer centred below it. Keeps the same bottom safe margin for the free watermark.
async function renderQuoteCardV2(params: RenderParams, options: QuoteOptions) {
  const primary = color(params.brandHex, "#1f2937"), secondary = color(params.secondaryBrandHex, "#374151");
  const ink = foreground(primary);
  const logo = await rasterLogo(params.logoUrl);
  const rating = safeRating(params.rating);
  const business = await layout(params.businessName, 600, 80, [26, 24, 22, 20, 18], ink, face("Regular"), "centre");
  const reviewer = cleanReviewer(params.authorName);
  const author = reviewer ? await layout(`— ${reviewer}`, 920, 90, [32, 28, 24, 20], ink, face("SemiBold"), "centre") : null;
  const quoteTop = Math.max(rating ? 250 : 200, 80 + business.height + 40);
  const quoteBottom = author ? 810 : 940;
  const quote = await layout(`“${params.quoteText}”`, 880, quoteBottom - quoteTop, options.quoteSize === "large" ? [56, 52, 48, 44, 40, 36, 32] : [46, 42, 38, 34, 30, 26, 22, 20], ink, face("SemiBold", params.brandTone === "premium"), "centre");
  const watermark = params.watermark ? await layout("Praise Loop", 920, 32, [22, 20, 18, 16], ink, face("Regular")) : null;
  const layers: OverlayOptions[] = [
    { input: { create: { width: 1080, height: 10, channels: 4, background: secondary } }, top: 0, left: 0 },
    { input: business.input, top: 80, left: Math.floor((1080 - business.width) / 2) },
    { input: quote.input, top: quoteTop + Math.floor((quoteBottom - quoteTop - quote.height) / 2), left: Math.floor((1080 - quote.width) / 2) }
  ];
  if (logo) layers.push({ input: logo, top: 80, left: 80 });
  if (rating) layers.push({ input: stars(rating, ink === "#ffffff" ? "#F4B731" : "#9A5A0B"), top: 190, left: Math.floor((1080 - rating * 52) / 2) });
  if (author) layers.push({ input: author.input, top: 860, left: Math.floor((1080 - author.width) / 2) });
  if (watermark) layers.push({ input: watermark.input, top: 1012, left: Math.floor((1080 - watermark.width) / 2) });
  return sharp({ create: { width: 1080, height: 1080, channels: 4, background: primary } }).composite(layers).png().toBuffer();
}
// quote-card-v3: a split card. The quote sits in the brand colour above, while the business name,
// reviewer and logo sit in the secondary colour below. Contrast is chosen separately for each band.
async function renderQuoteCardV3(params: RenderParams, options: QuoteOptions) {
  const primary = color(params.brandHex, "#1f2937"), secondary = color(params.secondaryBrandHex, "#374151");
  const ink = foreground(primary), footerInk = foreground(secondary);
  const logo = await rasterLogo(params.logoUrl);
  const rating = safeRating(params.rating);
  const business = await layout(params.businessName, 600, 70, [30, 26, 22, 20, 18], footerInk, face("Regular"));
  const reviewer = cleanReviewer(params.authorName);
  const author = reviewer ? await layout(`— ${reviewer}`, 600, 90, [28, 24, 20, 18], footerInk, face("SemiBold")) : null;
  const quote = await layout(`“${params.quoteText}”`, 920, 480, options.quoteSize === "large" ? [56, 52, 48, 44, 40, 36, 32] : [46, 42, 38, 34, 30, 26, 22, 20], ink, face("SemiBold", params.brandTone === "premium"));
  const watermark = params.watermark ? await layout("Praise Loop", 920, 32, [22, 20, 18, 16], footerInk, face("Regular")) : null;
  const layers: OverlayOptions[] = [
    { input: { create: { width: 1080, height: 720, channels: 4, background: primary } }, top: 0, left: 0 },
    { input: quote.input, top: 190 + Math.floor((480 - quote.height) / 2), left: 80 },
    { input: business.input, top: 750, left: 80 }
  ];
  if (rating) layers.push({ input: stars(rating, ink === "#ffffff" ? "#F4B731" : "#9A5A0B"), top: 90, left: 1000 - rating * 52 });
  if (author) layers.push({ input: author.input, top: 840, left: 80 });
  if (logo) layers.push({ input: logo, top: 840, left: 860 });
  if (watermark) layers.push({ input: watermark.input, top: 1012, left: Math.floor((1080 - watermark.width) / 2) });
  return sharp({ create: { width: 1080, height: 1080, channels: 4, background: secondary } }).composite(layers).png().toBuffer();
}
// quote-card-v4: a framed editorial column. The reviewer sits at the top, the quote runs in a
// narrower column, and the business name sits along the bottom inside a thin secondary frame.
async function renderQuoteCardV4(params: RenderParams, options: QuoteOptions) {
  const primary = color(params.brandHex, "#1f2937"), secondary = color(params.secondaryBrandHex, "#374151");
  const ink = foreground(primary);
  const logo = await rasterLogo(params.logoUrl);
  const rating = safeRating(params.rating);
  const business = await layout(params.businessName, 700, 80, [30, 26, 22, 20, 18], ink, face("Regular"));
  const reviewer = cleanReviewer(params.authorName);
  const author = reviewer ? await layout(`— ${reviewer}`, 600, 90, [30, 26, 22, 20, 18], ink, face("SemiBold")) : null;
  const quote = await layout(`“${params.quoteText}”`, 760, 590, options.quoteSize === "large" ? [56, 52, 48, 44, 40, 36, 32] : [48, 44, 40, 36, 32, 28, 24, 20], ink, face("SemiBold", params.brandTone === "premium"));
  const watermark = params.watermark ? await layout("Praise Loop", 920, 32, [22, 20, 18, 16], ink, face("Regular")) : null;
  const frame = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080"><rect x="40" y="40" width="1000" height="1000" fill="none" stroke="${secondary}" stroke-width="6"/></svg>`);
  const layers: OverlayOptions[] = [
    { input: frame, top: 0, left: 0 },
    { input: quote.input, top: 250 + Math.floor((590 - quote.height) / 2), left: 80 },
    { input: business.input, top: 870, left: 80 }
  ];
  if (author) layers.push({ input: author.input, top: 100, left: 80 });
  if (rating) layers.push({ input: stars(rating, ink === "#ffffff" ? "#F4B731" : "#9A5A0B"), top: 100, left: 1000 - rating * 52 });
  if (logo) layers.push({ input: logo, top: 840, left: 860 });
  if (watermark) layers.push({ input: watermark.input, top: 1012, left: Math.floor((1080 - watermark.width) / 2) });
  return sharp({ create: { width: 1080, height: 1080, channels: 4, background: primary } }).composite(layers).png().toBuffer();
}
export async function renderQuoteCard(params: RenderParams) {
  const options = quoteOptions(params.templateConfig);
  const template = templateForLimit(options.template, params.templatesAllowed);
  if (template === "quote-card-v2") return renderQuoteCardV2(params, options);
  if (template === "quote-card-v3") return renderQuoteCardV3(params, options);
  if (template === "quote-card-v4") return renderQuoteCardV4(params, options);
  return renderQuoteCardV1(params, options);
}
export async function renderDraftImage(params: RenderParams) {
  const png = await renderQuoteCard(params);
  const digest = createHash("sha256").update(png).digest("hex").slice(0,20);
  const root = mediaRoot();
  mkdirSync(root, { recursive: true });
  const outPath = join(root, draftImageFilename(params.draftPostId, digest));
  const temp = `${outPath}.${randomUUID()}.tmp`;
  writeFileSync(temp, png);
  renameSync(temp, outPath);
  return { fileSystemPath: outPath, publicPath: draftImageUrl(params.draftPostId, digest) };
}
