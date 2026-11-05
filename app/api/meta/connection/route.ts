import { NextResponse } from "next/server";
import { currentOwner, ownerRoute } from "../../../../lib/authorization";
import { disconnectMeta, getMetaConnection } from "../../../../lib/services/metaConnection";

async function handleGET() {
  return NextResponse.json(await getMetaConnection(currentOwner()));
}

async function handleDELETE() {
  await disconnectMeta(currentOwner());
  return NextResponse.json({ ok: true });
}

export const GET = ownerRoute(handleGET);
export const DELETE = ownerRoute(handleDELETE);
