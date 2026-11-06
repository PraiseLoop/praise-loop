import { ownerRoute } from "../../../lib/authorization";
import { NextRequest, NextResponse } from "next/server";
import { query } from "../../../lib/db";

async function handleGET(req: NextRequest) {
  const businessId = Number(req.nextUrl.searchParams.get("businessId"));
  if (!Number.isInteger(businessId) || businessId <= 0) {
    return NextResponse.json({ error: "valid businessId is required" }, { status: 400 });
  }

  const result = await query<{
    id: number; version: number;
    review_id: number | null;
    quote_text: string;
    caption_text: string;
    image_path: string | null;
    status: string;
    audit_note: string | null;
    scheduled_for: string | null;
    created_at: string;
  }>(
    `SELECT d.id, d.version, d.review_id, d.quote_text, d.caption_text, d.image_path, d.status, d.audit_note,
      d.scheduled_for::text, d.created_at::text,r.rating,r.author_name,r.reviewed_at::text,r.source,r.source_url,
      j.state AS job_state,j.error_code,j.manual_retries,s.state AS provider_state,
      s.provider AS posting_provider,s.mode AS posting_mode,s.error_code AS posting_error_code,s.external_link AS posting_link,s.sent_at::text AS posting_sent_at,
      (SELECT json_agg(e ORDER BY e.id) FROM (SELECT id,action,reason,actor_id,from_status,to_status,at FROM draft_events WHERE draft_id=d.id ORDER BY id DESC LIMIT 20) e) AS history
     FROM draft_posts d LEFT JOIN reviews r ON r.id=d.review_id AND r.business_id=d.business_id
     LEFT JOIN generation_jobs j ON j.draft_id=d.id
     LEFT JOIN posting_slot_claims s ON s.draft_id=d.id
     WHERE d.business_id = $1
     ORDER BY d.created_at DESC, d.id DESC
     LIMIT 100`,
    [businessId]
  );

  return NextResponse.json({ drafts: result.rows });
}

export const GET = ownerRoute(handleGET);
