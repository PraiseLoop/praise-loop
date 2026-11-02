import { NextRequest, NextResponse } from "next/server";
import { recordFailure, tooManyFailures } from "../../../../lib/mobileSignIn";
import { clientIp } from "../../../../lib/requestIp";
import {
  BufferConnectionError,
  completeBufferConnect,
  type BufferOutcome
} from "../../../../lib/services/bufferConnection";

// Public by design: Buffer sends the owner's browser here without the session
// cookie. The single-use state row is what authenticates the completion, so the
// route never trusts a cookie and never answers 5xx to a browser redirect flow.
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

  try {
    const result = await completeBufferConnect({
      state: req.nextUrl.searchParams.get("state"),
      code: req.nextUrl.searchParams.get("code")
    });
    return destination(req, result.outcome);
  } catch (failure) {
    const outcome = outcomeFor(failure);
    if (outcome !== "not_configured") recordFailure(ip);
    return destination(req, outcome);
  }
}
