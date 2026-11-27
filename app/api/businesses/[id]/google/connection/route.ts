import { NextRequest, NextResponse } from "next/server";
import { currentOwner, ownerRoute } from "../../../../../../lib/authorization";
import { businessIdFrom, googleFailure, type BusinessIdContext } from "../../../../../../lib/google/connectionRoute";
import { disconnectGoogle, getGoogleConnection } from "../../../../../../lib/services/googleConnection";

// The view is display data only: never a token, ciphertext or provider error text.
async function handleGET(_req: NextRequest, context: BusinessIdContext) {
  const businessId = businessIdFrom((await context.params).id);
  if (!businessId) return NextResponse.json({ error: "Valid business id required" }, { status: 400 });
  try {
    return NextResponse.json(await getGoogleConnection(currentOwner(), businessId));
  } catch (error) {
    return googleFailure(error);
  }
}

// Disconnect is always allowed: a flag switched off after connecting must not
// strand an encrypted token, and a pending grant must not outlive the choice.
async function handleDELETE(_req: NextRequest, context: BusinessIdContext) {
  const businessId = businessIdFrom((await context.params).id);
  if (!businessId) return NextResponse.json({ error: "Valid business id required" }, { status: 400 });
  try {
    await disconnectGoogle(currentOwner(), businessId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return googleFailure(error);
  }
}

export const GET = ownerRoute(handleGET);
export const DELETE = ownerRoute(handleDELETE);
