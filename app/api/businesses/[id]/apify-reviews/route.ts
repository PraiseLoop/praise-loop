import { NextRequest, NextResponse } from "next/server";
import { currentOwner, ownerRoute } from "../../../../../lib/authorization";
import { ApifyReviewError, getApifyReviewsStatus, startApifyReviews } from "../../../../../lib/services/apifyReviews";

type BusinessIdContext = { params: Promise<{ id: string }> };

function businessIdFrom(value: string) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function failure(error: unknown) {
  if (error instanceof ApifyReviewError) {
    return NextResponse.json({ error: error.code }, { status: error.status });
  }
  return NextResponse.json({ error: "Request failed" }, { status: 500 });
}

// ownerRoute already checked that the business belongs to the caller.
async function handleGET(_req: NextRequest, context: BusinessIdContext) {
  const businessId = businessIdFrom((await context.params).id);
  if (!businessId) return NextResponse.json({ error: "Valid business id required" }, { status: 400 });
  try {
    return NextResponse.json(await getApifyReviewsStatus(currentOwner(), businessId));
  } catch (error) {
    return failure(error);
  }
}

async function handlePOST(req: NextRequest, context: BusinessIdContext) {
  const businessId = businessIdFrom((await context.params).id);
  if (!businessId) return NextResponse.json({ error: "Valid business id required" }, { status: 400 });
  const body = await req.json().catch(() => null) as { place?: unknown; confirmed?: unknown } | null;
  try {
    return NextResponse.json(await startApifyReviews(currentOwner(), businessId, {
      place: body?.place,
      confirmed: body?.confirmed
    }));
  } catch (error) {
    return failure(error);
  }
}

export const GET = ownerRoute(handleGET);
export const POST = ownerRoute(handlePOST);
