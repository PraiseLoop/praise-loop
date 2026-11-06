import { ownerRoute } from "../../../../lib/authorization";
import { NextRequest, NextResponse } from "next/server";
import { query } from "../../../../lib/db";
import { importReviewsCsv, MAX_REVIEW_IMPORT_BYTES } from "../../../../lib/services/reviewImport";

async function handlePOST(req: NextRequest) {
  const formData = await req.formData();
  const businessIdRaw = String(formData.get("businessId") ?? "").trim();
  const file = formData.get("file");

  const businessId = Number(businessIdRaw);
  if (!Number.isInteger(businessId) || businessId <= 0) {
    return NextResponse.json({ error: "valid businessId is required" }, { status: 400 });
  }

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  if (file.size > MAX_REVIEW_IMPORT_BYTES) return NextResponse.json({ error: "CSV exceeds 1 MB" }, { status: 413 });
  const exists = await query("SELECT id FROM businesses WHERE id = $1", [businessId]);
  if (!exists.rowCount) return NextResponse.json({ error: "business not found" }, { status: 404 });
  const csvText = await file.text();
  try {
    return NextResponse.json(await importReviewsCsv(businessId, csvText));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "invalid CSV" },
      { status: 400 }
    );
  }
}

export const POST = ownerRoute(handlePOST);
