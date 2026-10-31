import { currentOwner, ownerRoute } from "../../../../../lib/authorization";
import { NextRequest, NextResponse } from "next/server";
import { query } from "../../../../../lib/db";
import {
  BrandVoiceError,
  MAX_STORED_VOICE_CHARS,
  assertBrandVoicePlan,
  learnBrandVoice
} from "../../../../../lib/services/brandVoice";

type BusinessIdContext = { params: Promise<{ id: string }> };

type VoiceRow = {
  brand_voice: string | null;
  brand_voice_source_url: string | null;
  brand_voice_updated_at: Date | null;
};

function voicePayload(row: VoiceRow) {
  return {
    voice: row.brand_voice,
    sourceUrl: row.brand_voice_source_url,
    updatedAt: row.brand_voice_updated_at ? new Date(row.brand_voice_updated_at).toISOString() : null
  };
}

function errorResponse(error: unknown) {
  if (error instanceof BrandVoiceError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  // Never echo page text, prompts or provider messages.
  return NextResponse.json({ error: "We couldn’t update the brand voice. Try again." }, { status: 500 });
}

async function handlePOST(req: NextRequest, context: BusinessIdContext) {
  try {
    const businessId = Number((await context.params).id);
    const body = await req.json().catch(() => null);
    const url = typeof body?.url === "string" ? body.url.trim() : "";
    if (!url) return NextResponse.json({ error: "Enter your website URL" }, { status: 400 });

    return NextResponse.json(await learnBrandVoice(businessId, url));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handlePUT(req: NextRequest, context: BusinessIdContext) {
  try {
    const businessId = Number((await context.params).id);
    const body = await req.json().catch(() => null);
    const voice = typeof body?.voice === "string" ? body.voice.trim() : "";
    if (!voice) return NextResponse.json({ error: "Enter a voice profile or reset to the tone setting" }, { status: 400 });
    if (voice.length > MAX_STORED_VOICE_CHARS) {
      return NextResponse.json({ error: `Keep the voice profile to ${MAX_STORED_VOICE_CHARS} characters or fewer` }, { status: 400 });
    }

    // ownerRoute proved the business is the caller's; the plan is a separate check. A downgraded
    // owner can still reset (DELETE) but not write a new profile.
    await assertBrandVoicePlan(currentOwner());

    const updated = await query<VoiceRow>(
      `UPDATE businesses
       SET brand_voice=$2, brand_voice_updated_at=now()
       WHERE id=$1
       RETURNING brand_voice, brand_voice_source_url, brand_voice_updated_at`,
      [businessId, voice]
    );
    if (!updated.rowCount) return NextResponse.json({ error: "business not found" }, { status: 404 });
    return NextResponse.json(voicePayload(updated.rows[0]));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleDELETE(_req: NextRequest, context: BusinessIdContext) {
  try {
    const businessId = Number((await context.params).id);
    const updated = await query<VoiceRow>(
      `UPDATE businesses
       SET brand_voice=NULL, brand_voice_source_url=NULL, brand_voice_updated_at=now()
       WHERE id=$1
       RETURNING brand_voice, brand_voice_source_url, brand_voice_updated_at`,
      [businessId]
    );
    if (!updated.rowCount) return NextResponse.json({ error: "business not found" }, { status: 404 });
    return NextResponse.json(voicePayload(updated.rows[0]));
  } catch (error) {
    return errorResponse(error);
  }
}

export const POST = ownerRoute(handlePOST);
export const PUT = ownerRoute(handlePUT);
export const DELETE = ownerRoute(handleDELETE);
