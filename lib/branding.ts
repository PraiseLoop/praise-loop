export const BRAND_TONES = ["friendly", "premium", "playful"] as const;
export type BrandTone = (typeof BRAND_TONES)[number];

export function isBrandTone(value: unknown): value is BrandTone {
  return typeof value === "string" && BRAND_TONES.includes(value as BrandTone);
}

function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  return /^#[0-9a-fA-F]{6}$/.test(withHash) ? withHash.toLowerCase() : null;
}

export function parseBrandColors(input: unknown): Record<string, string> {
  const source = input && typeof input === "object" ? (input as Record<string, unknown>) : {};

  const primary = normalizeHex(source.primary);
  const secondary = normalizeHex(source.secondary);

  const brandColors: Record<string, string> = {};
  if (primary) brandColors.primary = primary;
  if (secondary) brandColors.secondary = secondary;
  return { ...brandColors, ...quoteOptions(input) };
}

export function parseLogoUrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  return trimmed || null;
}

/** Ordered designs; a plan's `templates` limit is how many from the front it may use. */
export const QUOTE_TEMPLATES = ["quote-card-v1", "quote-card-v2", "quote-card-v3", "quote-card-v4"] as const;
export const QUOTE_TEMPLATE = QUOTE_TEMPLATES[0];
export type QuoteTemplate = (typeof QUOTE_TEMPLATES)[number];
export const QUOTE_TEMPLATE_NAMES: Record<QuoteTemplate, string> = {
  "quote-card-v1": "Classic",
  "quote-card-v2": "Spotlight",
  "quote-card-v3": "Split",
  "quote-card-v4": "Framed"
};
export type QuoteOptions = { template: QuoteTemplate; quoteSize: "standard" | "large" };
export function isQuoteTemplate(value: unknown): value is QuoteTemplate {
  return typeof value === "string" && QUOTE_TEMPLATES.includes(value as QuoteTemplate);
}
export function quoteOptions(value: unknown): QuoteOptions {
  const v = (value ?? {}) as Record<string, unknown>;
  if (v.template !== undefined && !isQuoteTemplate(v.template) ||
      v.quoteSize !== undefined && !["standard", "large"].includes(String(v.quoteSize))) {
    throw new Error("Unsupported quote template or text size");
  }
  return { template: isQuoteTemplate(v.template) ? v.template : QUOTE_TEMPLATE, quoteSize: v.quoteSize === "large" ? "large" : "standard" };
}
/** Whether a plan's template allowance includes a design. */
export function templateWithinLimit(template: QuoteTemplate, limit: number): boolean {
  return QUOTE_TEMPLATES.indexOf(template) < limit;
}
/** The design a render may use: a saved choice the plan no longer allows falls back to v1. */
export function templateForLimit(template: QuoteTemplate, limit: number | undefined): QuoteTemplate {
  return limit === undefined || templateWithinLimit(template, limit) ? template : QUOTE_TEMPLATE;
}
export function validBrandConfig(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  try { quoteOptions(v); } catch { return false; }
  return ["primary", "secondary"].every(key => v[key] === undefined || normalizeHex(v[key]) !== null);
}
