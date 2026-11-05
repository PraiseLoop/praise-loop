import { NextRequest, NextResponse } from "next/server";
import { currentSession, ownerRoute } from "../../../../../lib/authorization";
import { verifyStepUp } from "../../../../../lib/stepUp";

// Owner-wide (#221): confirm a step-up code and mark this session only. A code
// without a matching step-up row is rejected, and a sign-in code is not accepted.
export const dynamic = "force-dynamic";

const reply = (status: number, body: object) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function readCode(req: NextRequest): Promise<string> {
  try {
    const body = JSON.parse(await req.text()) as { code?: unknown } | null;
    return typeof body?.code === "string" ? body.code.trim() : "";
  } catch {
    return "";
  }
}

export const POST = ownerRoute(async (req: NextRequest) => {
  const session = currentSession();
  if (!session) return reply(401, { error: "Sign in to continue" });
  const result = await verifyStepUp(session, await readCode(req));
  if (result === "verified") return reply(200, { ok: true });
  if (result === "sign_in_again") return reply(403, { error: "sign_in_again" });
  if (result === "session_missing") return reply(401, { error: "Sign in to continue" });
  return reply(400, { error: "invalid_code" });
});
