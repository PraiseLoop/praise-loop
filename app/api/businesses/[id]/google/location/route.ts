import { NextRequest, NextResponse } from "next/server";
import { currentOwner, ownerRoute } from "../../../../../../lib/authorization";
import { businessIdFrom, googleFailure, type BusinessIdContext } from "../../../../../../lib/google/connectionRoute";
import { chooseGoogleLocation } from "../../../../../../lib/services/googleConnection";

// The body carries the name of one location from the pending grant; the service
// matches it against the stored list and decrypts the stored token itself.
async function handlePOST(req: NextRequest, context: BusinessIdContext) {
  const businessId = businessIdFrom((await context.params).id);
  if (!businessId) return NextResponse.json({ error: "Valid business id required" }, { status: 400 });
  const body = await req.json().catch(() => null) as { location?: unknown } | null;
  try {
    return NextResponse.json(await chooseGoogleLocation(currentOwner(), businessId, body?.location));
  } catch (error) {
    return googleFailure(error);
  }
}

export const POST = ownerRoute(handlePOST);
