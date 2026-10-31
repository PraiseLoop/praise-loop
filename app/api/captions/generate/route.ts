import { draftMutation } from "../../../../lib/services/draftLifecycle";
import { ownerRoute } from "../../../../lib/authorization";
import { NextRequest, NextResponse } from "next/server";
import { query } from "../../../../lib/db";
import type { BrandTone } from "../../../../lib/branding";
import { generateCaptionVariants } from "../../../../lib/services/captions";

async function handlePOST(req: NextRequest) {
  try {
    const body = await req.json();
    const draftPostId = Number(body?.draftPostId);

    if (!Number.isInteger(draftPostId) || draftPostId <= 0) {
      return NextResponse.json({ error: "valid draftPostId is required" }, { status: 400 });
    }

    const draftRes = await query<{
      id: number;
      quote_text: string;
      business_name: string;
      brand_tone: BrandTone;
      brand_voice?: string | null;
    }>(
      `SELECT d.id, d.quote_text, b.name AS business_name, b.brand_tone, b.brand_voice
       FROM draft_posts d
       JOIN businesses b ON b.id = d.business_id
       WHERE d.id = $1
       LIMIT 1`,
      [draftPostId]
    );

    if (!draftRes.rowCount) {
      return NextResponse.json({ error: "draft post not found" }, { status: 404 });
    }

    const row = draftRes.rows[0];
    const captions = await generateCaptionVariants({
      businessName: row.business_name,
      quoteText: row.quote_text,
      brandTone: row.brand_tone,
      brandVoice: row.brand_voice
    });

    return NextResponse.json({ captions });
  } catch (err) {
    // minimal logging without secrets/prompts
    console.error("caption_generation_failed", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "caption generation failed" }, { status: 500 });
  }
}

export const POST = ownerRoute(draftMutation("captions", handlePOST));
