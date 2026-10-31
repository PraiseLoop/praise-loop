import { validTimezone } from "../../../lib/timezone";
import { rasterLogo } from "../../../lib/services/logos";
import { ownerRoute, currentOwner } from "../../../lib/authorization";
import { NextRequest, NextResponse } from "next/server";
import { parseBrandColors, parseLogoUrl, validBrandConfig, type BrandTone } from "../../../lib/branding";
import { query, transaction } from "../../../lib/db";
import { entitlementsFor } from "../../../lib/services/entitlements";

type BusinessRow = {
  id: number;
  name: string;
  timezone: string;
  brand_colors: Record<string, string> | null;
  logo_url: string | null;
  brand_tone: BrandTone;
  weekly_target: number;
  brand_voice?: string | null;
  brand_voice_source_url?: string | null;
  brand_voice_updated_at?: Date | string | null;
};

function normalizeBrandTone(input: unknown): BrandTone {
  const tone = String(input ?? "friendly").trim().toLowerCase();
  if (tone === "premium" || tone === "playful") return tone;
  return "friendly";
}

async function handleGET() {
  const result = await query<BusinessRow>(
    `SELECT id, name, timezone, brand_colors, logo_url, brand_tone, weekly_target,
            brand_voice, brand_voice_source_url, brand_voice_updated_at
     FROM businesses WHERE owner_id=$1
     ORDER BY id ASC`, [currentOwner()]
  );

  const businesses = result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    logo_url: row.logo_url,
    brand_tone: row.brand_tone,
    weekly_target: row.weekly_target,
    brand_voice: row.brand_voice ?? null,
    brand_voice_source_url: row.brand_voice_source_url ?? null,
    brand_voice_updated_at: row.brand_voice_updated_at ?? null,
    brand_colors: {
      primary: row.brand_colors?.primary ?? "#1f2937",
      secondary: row.brand_colors?.secondary ?? "#374151",
      template: row.brand_colors?.template ?? "quote-card-v1",
      quoteSize: row.brand_colors?.quoteSize ?? "standard"
    }
  }));

  return NextResponse.json({ businesses });
}

async function handlePOST(req: NextRequest) {
  const body = await req.json();
  if(body.logoUrl !== undefined){try{await rasterLogo(body.logoUrl);}catch{return NextResponse.json({error:"Upload a valid PNG/JPEG/WebP logo under 256 KB and 4 megapixels; remote logos are unsupported"},{status:400});}}
  if (body.timezone !== undefined && !validTimezone(String(body.timezone))) return NextResponse.json({error:"Use a valid IANA timezone"},{status:400});
  if (body?.brandColors !== undefined && !validBrandConfig(body.brandColors)) {
    return NextResponse.json({ error: "Invalid brand colors or template options" }, { status: 400 });
  }
  if(body.onboardingKey!==undefined && (typeof body.onboardingKey!=="string" || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(body.onboardingKey))) return NextResponse.json({error:"Invalid onboarding request key"},{status:400});
  const name = String(body?.name ?? "").trim();
  const timezone = String(body?.timezone ?? "America/Toronto").trim();

  if (!validTimezone(timezone)) return NextResponse.json({error:"Use a valid IANA timezone"},{status:400});

  const parsedBrandColors =
    body?.brandColors !== undefined
      ? parseBrandColors(body.brandColors)
      : parseBrandColors({
          primary: body?.primaryColor,
          secondary: body?.secondaryColor
        });

  const brandColors = {
    primary: parsedBrandColors.primary ?? "#1f2937",
    secondary: parsedBrandColors.secondary ?? "#374151",
    template: parsedBrandColors.template, quoteSize: parsedBrandColors.quoteSize
  };

  const logoUrl = parseLogoUrl(body?.logoUrl);
  const brandTone = normalizeBrandTone(body?.brandTone);

  if (!name || name.length > 120) {
    return NextResponse.json({ error: "Use a business name of 1–120 characters" }, { status: 400 });
  }

  const result = await transaction(async (c) => {
    const owner = currentOwner();
    // Serialize plan checks and inserts per owner so two concurrent creates
    // cannot both pass the business limit.
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [owner]);
    const onboardingKey = typeof body.onboardingKey === "string" ? body.onboardingKey : null;
    if (onboardingKey) {
      const existing = await c.query<BusinessRow>(
        `SELECT id, name, timezone, brand_colors, logo_url, brand_tone, weekly_target
         FROM businesses WHERE owner_id=$1 AND onboarding_key=$2 LIMIT 1`,
        [owner, onboardingKey]
      );
      // Retrying a lost onboarding response must return the original business,
      // even when the owner is already at the plan limit.
      if (existing.rowCount) return { business: existing.rows[0] };
    }
    const entitlements = await entitlementsFor(owner, (sql, values) => c.query(sql, values));
    const count = Number((await c.query<{ n: string }>("SELECT count(*) n FROM businesses WHERE owner_id=$1", [owner])).rows[0].n);
    if (count >= entitlements.limits.businesses) return { limit: entitlements.limits.businesses };
    const inserted = await c.query<BusinessRow>(
      `INSERT INTO businesses (name, timezone, brand_colors, logo_url, brand_tone, owner_id, onboarding_key)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
       ON CONFLICT (owner_id,onboarding_key) WHERE onboarding_key IS NOT NULL DO UPDATE SET name=businesses.name
       RETURNING id, name, timezone, brand_colors, logo_url, brand_tone, weekly_target`,
      [name, timezone, JSON.stringify(brandColors), logoUrl, brandTone, owner, onboardingKey]
    );
    return { business: inserted.rows[0] };
  });

  if ("limit" in result) {
    return NextResponse.json({
      error: `Your plan includes ${result.limit} ${result.limit === 1 ? "business" : "businesses"}; upgrade to add another.`,
      code: "business_limit_reached"
    }, { status: 403 });
  }

  return NextResponse.json({ business: result.business }, { status: 201 });
}

export const GET = ownerRoute(handleGET);
export const POST = ownerRoute(handlePOST);
