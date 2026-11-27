import { NextRequest, NextResponse } from "next/server";
import { currentOwner, ownerRoute } from "../../../../../../lib/authorization";
import { businessIdFrom, googleFailure, type BusinessIdContext } from "../../../../../../lib/google/connectionRoute";
import { startGoogleConnect } from "../../../../../../lib/services/googleConnection";

// Business-scoped: ownerRoute checks that this business belongs to the caller.
async function handlePOST(_req: NextRequest, context: BusinessIdContext) {
  const businessId = businessIdFrom((await context.params).id);
  if (!businessId) return NextResponse.json({ error: "Valid business id required" }, { status: 400 });
  try {
    return NextResponse.json({ url: await startGoogleConnect(currentOwner(), businessId) });
  } catch (error) {
    return googleFailure(error);
  }
}

export const POST = ownerRoute(handlePOST);
