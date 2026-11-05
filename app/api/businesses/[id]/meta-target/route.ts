import { NextRequest, NextResponse } from "next/server";
import { currentOwner, ownerRoute } from "../../../../../lib/authorization";
import {
  MetaConnectionError,
  clearMetaTarget,
  getSelectedMetaTarget,
  selectMetaTarget,
  type MetaTargetKind
} from "../../../../../lib/services/metaConnection";

type BusinessIdContext = { params: Promise<{ id: string }> };

// ownerRoute already checked that the business belongs to the caller; the service
// re-checks it before writing. Meta Pages are owner-wide and a business selects
// one of them, exactly like the Buffer channel route.
function businessIdFrom(value: string) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function failure(error: unknown) {
  if (error instanceof MetaConnectionError) {
    return NextResponse.json({ error: error.code }, { status: error.status });
  }
  return NextResponse.json({ error: "Request failed" }, { status: 500 });
}

async function handleGET(_req: NextRequest, context: BusinessIdContext) {
  const businessId = businessIdFrom((await context.params).id);
  if (!businessId) return NextResponse.json({ error: "Valid business id required" }, { status: 400 });
  return NextResponse.json({ target: await getSelectedMetaTarget(currentOwner(), businessId) });
}

async function handlePUT(req: NextRequest, context: BusinessIdContext) {
  const businessId = businessIdFrom((await context.params).id);
  if (!businessId) return NextResponse.json({ error: "Valid business id required" }, { status: 400 });
  const body = await req.json().catch(() => null) as { metaPageId?: unknown; target?: unknown } | null;
  if (typeof body?.metaPageId !== "number" || !Number.isSafeInteger(body.metaPageId)) {
    return NextResponse.json({ error: "metaPageId is required" }, { status: 400 });
  }
  if (body.target !== "instagram" && body.target !== "facebook") {
    return NextResponse.json({ error: "Choose instagram or facebook" }, { status: 400 });
  }
  try {
    return NextResponse.json({
      target: await selectMetaTarget(currentOwner(), businessId, body.metaPageId, body.target as MetaTargetKind)
    });
  } catch (error) {
    return failure(error);
  }
}

async function handleDELETE(_req: NextRequest, context: BusinessIdContext) {
  const businessId = businessIdFrom((await context.params).id);
  if (!businessId) return NextResponse.json({ error: "Valid business id required" }, { status: 400 });
  try {
    await clearMetaTarget(currentOwner(), businessId);
    return NextResponse.json({ target: null });
  } catch (error) {
    return failure(error);
  }
}

export const GET = ownerRoute(handleGET);
export const PUT = ownerRoute(handlePUT);
export const DELETE = ownerRoute(handleDELETE);
