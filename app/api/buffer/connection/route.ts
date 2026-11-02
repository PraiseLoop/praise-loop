import { NextResponse } from "next/server";
import { currentOwner, ownerRoute } from "../../../../lib/authorization";
import { disconnectBuffer, getBufferConnection } from "../../../../lib/services/bufferConnection";

async function handleGET() {
  return NextResponse.json(await getBufferConnection(currentOwner()));
}

async function handleDELETE() {
  await disconnectBuffer(currentOwner());
  return NextResponse.json({ ok: true });
}

export const GET = ownerRoute(handleGET);
export const DELETE = ownerRoute(handleDELETE);
