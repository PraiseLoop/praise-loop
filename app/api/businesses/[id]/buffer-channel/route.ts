import { NextRequest, NextResponse } from "next/server";
import { currentOwner, ownerRoute } from "../../../../../lib/authorization";
import {
  BufferConnectionError,
  clearBufferChannel,
  getSelectedBufferChannel,
  selectBufferChannel
} from "../../../../../lib/services/bufferConnection";

type BusinessIdContext = { params: Promise<{ id: string }> };

// ownerRoute already checked that the business belongs to the caller; these
// handlers still re-read the id for the service calls.
function businessIdFrom(value: string) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function failure(error: unknown) {
  if (error instanceof BufferConnectionError) {
    return NextResponse.json({ error: error.code }, { status: error.status });
  }
  return NextResponse.json({ error: "Request failed" }, { status: 500 });
}

async function handleGET(_req: NextRequest, context: BusinessIdContext) {
  const businessId = businessIdFrom((await context.params).id);
  if (!businessId) return NextResponse.json({ error: "Valid business id required" }, { status: 400 });
  return NextResponse.json({ channel: await getSelectedBufferChannel(currentOwner(), businessId) });
}

async function handlePUT(req: NextRequest, context: BusinessIdContext) {
  const businessId = businessIdFrom((await context.params).id);
  if (!businessId) return NextResponse.json({ error: "Valid business id required" }, { status: 400 });
  const body = await req.json().catch(() => null) as { channelId?: unknown } | null;
  if (typeof body?.channelId !== "string" || !body.channelId) {
    return NextResponse.json({ error: "channelId is required" }, { status: 400 });
  }
  try {
    return NextResponse.json({ channel: await selectBufferChannel(currentOwner(), businessId, body.channelId) });
  } catch (error) {
    return failure(error);
  }
}

async function handleDELETE(_req: NextRequest, context: BusinessIdContext) {
  const businessId = businessIdFrom((await context.params).id);
  if (!businessId) return NextResponse.json({ error: "Valid business id required" }, { status: 400 });
  await clearBufferChannel(currentOwner(), businessId);
  return NextResponse.json({ channel: null });
}

export const GET = ownerRoute(handleGET);
export const PUT = ownerRoute(handlePUT);
export const DELETE = ownerRoute(handleDELETE);
