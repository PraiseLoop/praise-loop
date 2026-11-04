import { NextRequest, NextResponse } from "next/server";
import { currentOwner, ownerRoute } from "../../../../../lib/authorization";
import { getPostingSetup } from "../../../../../lib/services/postingSetup";

// ownerRoute already checked that the business belongs to the caller.
async function handleGET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const id = Number((await context.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ error: "Valid business id required" }, { status: 400 });
  return NextResponse.json(await getPostingSetup(currentOwner(), id), { headers: { "cache-control": "no-store" } });
}

export const GET = ownerRoute(handleGET);
