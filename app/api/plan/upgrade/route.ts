import { ownerRoute, currentOwner } from "../../../../lib/authorization";
import { selfServiceUpgrade, selfServiceUpgradeStatus } from "../../../../lib/services/planUpgrade";
import { NextResponse } from "next/server";

// Pilot self-service plan change. Owners whose email is on the allowlist may
// upgrade themselves to Pro; everyone else is refused and the plan page never
// shows the button. The server still owns the limits either way.
async function handleGET() {
  const { eligible, entitlements } = await selfServiceUpgradeStatus(currentOwner());
  return NextResponse.json({ eligible, plan: entitlements.plan });
}

async function handlePOST() {
  const result = await selfServiceUpgrade(currentOwner());
  if (!result.eligible) {
    return NextResponse.json({ error: "Self-service upgrades are not enabled for this account" }, { status: 403 });
  }
  return NextResponse.json({ changed: result.changed, ...result.entitlements });
}

export const GET = ownerRoute(handleGET);
export const POST = ownerRoute(handlePOST);
