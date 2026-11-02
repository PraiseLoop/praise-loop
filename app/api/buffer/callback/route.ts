import { NextRequest, NextResponse } from "next/server";
import { ownerId } from "../../../../lib/authorization";
import { recordFailure, tooManyFailures } from "../../../../lib/mobileSignIn";
import { clientIp } from "../../../../lib/requestIp";
import {
  BufferConnectionError,
  completeBufferConnect,
  type BufferOutcome
} from "../../../../lib/services/bufferConnection";

// Public to the route guard (Buffer's redirect carries no bearer token and no CSRF
// header), but NOT anonymous: the browser must be signed in as the same owner who
// started the flow. The single-use state row alone is not enough. Without the
// session check, an attacker could start a connect on their own account and send
// the Buffer link to a victim, attaching the victim's Buffer account to the
// attacker's PraiseLoop account (login CSRF). The route never answers 5xx to a
// browser redirect flow.
export const dynamic = "force-dynamic";

function destination(req: NextRequest, outcome: BufferOutcome) {
  const base = process.env.NEXTAUTH_URL?.replace(/\/+$/, "") || req.nextUrl.origin;
  return NextResponse.redirect(`${base}/connections?buffer=${outcome}`, 302);
}

function outcomeFor(error: unknown): BufferOutcome {
  if (error instanceof BufferConnectionError) {
    if (error.code === "not_configured") return "not_configured";
    if (error.code === "expired") return "expired";
  }
  return "failed";
}

export async function GET(req: NextRequest) {
  const error = req.nextUrl.searchParams.get("error");
  // Buffer reports a refused or cancelled authorization as `error`; there is no
  // error_description to read or pass on.
  if (error) return destination(req, error === "access_denied" ? "denied" : "failed");

  const ip = clientIp(req);
  if (tooManyFailures(ip)) return destination(req, "failed");

  // The signed-in owner of this browser. A missing session, or a different owner
  // than the one who started the flow, consumes nothing and stores nothing.
  const owner = await ownerId(req);
  if (!owner) {
    recordFailure(ip);
    return destination(req, "failed");
  }

  try {
    const result = await completeBufferConnect({
      state: req.nextUrl.searchParams.get("state"),
      code: req.nextUrl.searchParams.get("code"),
      ownerId: owner
    });
    return destination(req, result.outcome);
  } catch (failure) {
    const outcome = outcomeFor(failure);
    if (outcome !== "not_configured") recordFailure(ip);
    return destination(req, outcome);
  }
}
