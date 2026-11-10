import { NextRequest, NextResponse } from "next/server";
import { currentOwner, ownerRoute } from "../../../../lib/authorization";
import { emailPreferencesFor, setWeeklyEmailEnabled } from "../../../../lib/services/emailPreferences";

// Owner-wide email preferences. The account page reads and writes the weekly
// "your posts are ready" switch here (#275); the weekly email links to it.
async function handleGET() {
  return NextResponse.json(await emailPreferencesFor(currentOwner()));
}

async function handlePATCH(req: NextRequest) {
  const body = await req.json().catch(() => null) as { weeklyEmailEnabled?: unknown } | null;
  const result = await setWeeklyEmailEnabled(currentOwner(), body?.weeklyEmailEnabled);
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(result);
}

export const GET = ownerRoute(handleGET);
export const PATCH = ownerRoute(handlePATCH);
