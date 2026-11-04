import { validTimezone } from "../../../../lib/timezone";
import { rasterLogo } from "../../../../lib/services/logos";
import { ownerRoute, currentOwner } from "../../../../lib/authorization";
import { NextRequest, NextResponse } from "next/server";
import { parseBrandColors, parseLogoUrl, quoteOptions, templateWithinLimit, validBrandConfig, type BrandTone } from "../../../../lib/branding";
import { entitlementsFor } from "../../../../lib/services/entitlements";
import { query } from "../../../../lib/db";

type BusinessRow = {
  id: number;
  name: string;
  timezone: string;
  brand_colors: Record<string, string> | null;
  logo_url: string | null;
  brand_tone: BrandTone;
  weekly_target: number;
};

function normalizeBrandTone(input: unknown): BrandTone {
  const tone = String(input ?? "friendly").trim().toLowerCase();
  if (tone === "premium" || tone === "playful") return tone;
  return "friendly";
}

function normalizeHex(input: unknown): string | null {
  const value = String(input ?? "").trim();
  if (!value) return null;
  if (!/^#?[0-9a-fA-F]{6}$/.test(value)) return null;
  return value.startsWith("#") ? value.toLowerCase() : `#${value.toLowerCase()}`;
}

async function handlePATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const businessId = Number(params.id);

  if (!Number.isInteger(businessId) || businessId <= 0) {
    return NextResponse.json({ error: "valid business id is required" }, { status: 400 });
  }

  const body = await req.json();
  if(body.logoUrl !== undefined){try{await rasterLogo(body.logoUrl);}catch{return NextResponse.json({error:"Upload a valid PNG/JPEG/WebP logo under 256 KB and 4 megapixels; remote logos are unsupported"},{status:400});}}
  if (body.timezone !== undefined && !validTimezone(String(body.timezone))) return NextResponse.json({error:"Use a valid IANA timezone"},{status:400});
  if (body.weeklyTarget !== undefined && (!Number.isInteger(body.weeklyTarget) || body.weeklyTarget < 1 || body.weeklyTarget > 5)) return NextResponse.json({error:"Weekly target must be 1–5"},{status:400});
  if (body?.brandColors !== undefined && !validBrandConfig(body.brandColors)) {
    return NextResponse.json({ error: "Invalid brand colors or template options" }, { status: 400 });
  }

  const hasLegacyColorFields = body?.primaryColor !== undefined || body?.secondaryColor !== undefined;
  const hasExtendedFields =
    body?.name !== undefined || body?.timezone !== undefined || body?.brandColors !== undefined;

  if (hasLegacyColorFields && !hasExtendedFields) {
    const primaryColor = normalizeHex(body?.primaryColor);
    const secondaryColor = normalizeHex(body?.secondaryColor);
    if (!primaryColor || !secondaryColor) {
      return NextResponse.json(
        { error: "primaryColor and secondaryColor must be valid 6-digit hex colors" },
        { status: 400 }
      );
    }

    const logoUrl = parseLogoUrl(body?.logoUrl);
    const brandTone = normalizeBrandTone(body?.brandTone);

    const result = await query<{
      id: number;
      name: string;
      logo_url: string | null;
      brand_tone: BrandTone;
      brand_colors: { primary?: string; secondary?: string };
    }>(
      `UPDATE businesses
       SET logo_url = $2,
           brand_colors = brand_colors || $3::jsonb,
           brand_tone = $4
       WHERE id = $1
       RETURNING id, name, logo_url, brand_tone, brand_colors`,
      [
        businessId,
        logoUrl,
        JSON.stringify({ primary: primaryColor, secondary: secondaryColor }),
        brandTone
      ]
    );

    if (!result.rowCount) {
      return NextResponse.json({ error: "business not found" }, { status: 404 });
    }

    return NextResponse.json({ business: result.rows[0] });
  }

  const existing = await query<BusinessRow>(
    `SELECT id, name, timezone, brand_colors, logo_url, brand_tone, weekly_target
     FROM businesses
     WHERE id = $1
     LIMIT 1`,
    [businessId]
  );

  if (!existing.rowCount) {
    return NextResponse.json({ error: "business not found" }, { status: 404 });
  }

  const current = existing.rows[0];

  const name = body?.name === undefined ? current.name : String(body.name ?? "").trim();
  if (!name || name.length > 120) {
    return NextResponse.json({ error: "Use a business name of 1–120 characters" }, { status: 400 });
  }

  const timezone =
    body?.timezone === undefined
      ? current.timezone
      : String(body.timezone ?? "").trim() || current.timezone;

  if (!validTimezone(timezone)) return NextResponse.json({error:"Use a valid IANA timezone"},{status:400});

  let brandColors: Record<string, string> = current.brand_colors ?? {};
  if (body?.brandColors !== undefined) {
    brandColors = parseBrandColors(body.brandColors);
    // A saved design may outlive a paid plan: keep it unless the owner is changing
    // it to one the effective plan does not include.
    const requestedTemplate = quoteOptions(brandColors).template;
    if (requestedTemplate !== quoteOptions(current.brand_colors ?? {}).template) {
      const entitlements = await entitlementsFor(currentOwner());
      if (!templateWithinLimit(requestedTemplate, entitlements.limits.templates)) {
        return NextResponse.json({
          error: `Your plan includes ${entitlements.limits.templates} quote design${entitlements.limits.templates === 1 ? "" : "s"}; upgrade to choose this one.`,
          code: "template_limit_reached"
        }, { status: 403 });
      }
    }
  }

  const logoRaw = body?.logoUrl === undefined ? current.logo_url : body.logoUrl;
  const logoUrl = parseLogoUrl(logoRaw);

  const toneCandidate =
    body?.brandTone === undefined ? current.brand_tone : normalizeBrandTone(body.brandTone);

  const updated = await query<BusinessRow>(
    `UPDATE businesses
     SET name = $2,
         timezone = $3,
         brand_colors = $4::jsonb,
         logo_url = $5,
         brand_tone = $6, weekly_target = $7
     WHERE id = $1
     RETURNING id, name, timezone, brand_colors, logo_url, brand_tone, weekly_target`,
    [businessId, name, timezone, JSON.stringify(brandColors), logoUrl, toneCandidate, body.weeklyTarget ?? current.weekly_target]
  );

  return NextResponse.json({ business: updated.rows[0] });
}

export const PATCH = ownerRoute(handlePATCH);
