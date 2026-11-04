import { draftMutation } from "../../../../lib/services/draftLifecycle";
import { ownerRoute } from "../../../../lib/authorization";
import { NextRequest, NextResponse } from "next/server";
import { query } from "../../../../lib/db";
import type { BrandTone } from "../../../../lib/branding";
import { renderDraftImage } from "../../../../lib/services/imageRenderer";
import { entitlementsFor } from "../../../../lib/services/entitlements";

async function handlePOST(req: NextRequest) {
  try {
    const body = await req.json();
    const draftPostId = Number(body?.draftPostId);

    if (!Number.isInteger(draftPostId) || draftPostId <= 0) {
      return NextResponse.json({ error: "valid draftPostId is required" }, { status: 400 });
    }

    const draft = await query<{
      id: number;
      quote_text: string;
      business_name: string;
      owner_id: string;
      brand_colors: Record<string, string> | null;
      logo_url: string | null;
      brand_tone: BrandTone;
      rating: number | null;
      author_name: string | null;
    }>(
      `SELECT d.id, d.quote_text, b.name AS business_name, b.owner_id, b.brand_colors, b.logo_url, b.brand_tone, r.rating, r.author_name
       FROM draft_posts d
       JOIN businesses b ON b.id = d.business_id
       LEFT JOIN reviews r ON r.id = d.review_id AND r.business_id = d.business_id
       WHERE d.id = $1
       LIMIT 1`,
      [draftPostId]
    );

    if (!draft.rowCount) {
      return NextResponse.json({ error: "draft not found" }, { status: 404 });
    }

    const row = draft.rows[0];
    const brandHex = row.brand_colors?.primary ?? null;
    const secondaryBrandHex = row.brand_colors?.secondary ?? null;
    const entitlements = await entitlementsFor(row.owner_id);

    const rendered = await renderDraftImage({
      draftPostId,
      businessName: row.business_name,
      quoteText: row.quote_text,
      rating: row.rating,
      authorName: row.author_name,
      brandHex,
      secondaryBrandHex,
      logoUrl: row.logo_url,
      brandTone: row.brand_tone,
      templateConfig: row.brand_colors,
      watermark: entitlements.limits.watermark,
      templatesAllowed: entitlements.limits.templates
    });

    const updated = await query<{ id: number; image_path: string }>(
      `UPDATE draft_posts
       SET image_path = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING id, image_path`,
      [draftPostId, rendered.publicPath]
    );

    return NextResponse.json({ draft: updated.rows[0] });
  } catch (err) {
    console.error("image_render_failed", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "render failed" }, { status: 500 });
  }
}

export const POST = ownerRoute(draftMutation("render", handlePOST));
