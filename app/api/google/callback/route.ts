import { NextRequest, NextResponse } from "next/server";
import { ownerId } from "../../../../lib/authorization";
import { recordFailure, tooManyFailures } from "../../../../lib/mobileSignIn";
import { errorFields, log } from "../../../../lib/log";
import { clientIp } from "../../../../lib/requestIp";
import {
  completeGoogleConnect,
  GoogleConnectionError,
  type GoogleOutcome
} from "../../../../lib/services/googleConnection";

// Public to the route guard (Google's redirect carries no bearer token and no
// CSRF header), but NOT anonymous: the browser must be signed in as the owner
// who started the flow, so a state alone cannot attach a location to someone
// else's business. Never answers 5xx to a browser redirect.
export const dynamic = "force-dynamic";

function destination(req: NextRequest, businessId: number | null, outcome: GoogleOutcome) {
  const base = process.env.NEXTAUTH_URL?.replace(/\/+$/, "") || req.nextUrl.origin;
  const query = new URLSearchParams();
  if (businessId !== null) query.set("businessId", String(businessId));
  query.set("google", outcome);
  // String concatenation cannot throw: a browser redirect must never become a 5xx.
  return NextResponse.redirect(`${base}/reviews?${query.toString()}`, 302);
}

function outcomeFor(error: unknown): GoogleOutcome {
  if (error instanceof GoogleConnectionError) {
    if (error.code === "not_configured") return "not_configured";
    if (error.code === "expired") return "expired";
    if (error.code === "plan_required") return "plan_required";
    if (error.code === "missing_scope") return "missing_scope";
  }
  return "failed";
}

export async function GET(req: NextRequest) {
  try {
    const error = req.nextUrl.searchParams.get("error");
    if (error) {
      // No error_description to read: only a short, allow-listed code is logged.
      log.warn("google_callback_refused", { googleError: /^[a-z_]{1,40}$/.test(error) ? error : "other" });
      return destination(req, null, error === "access_denied" ? "denied" : "failed");
    }

    const ip = clientIp(req);
    if (tooManyFailures(ip)) { log.warn("google_callback_rate_limited"); return destination(req, null, "failed"); }

    // The signed-in owner of this browser. A missing session, or a different owner
    // than the one who started the flow, consumes nothing and stores nothing.
    const owner = await ownerId(req);
    if (!owner) {
      log.warn("google_callback_no_session", { reason: "no signed-in PraiseLoop session on the callback request" });
      recordFailure(ip);
      return destination(req, null, "failed");
    }

    const result = await completeGoogleConnect({
      state: req.nextUrl.searchParams.get("state"),
      code: req.nextUrl.searchParams.get("code"),
      ownerId: owner
    });
    log.info("google_connect_callback", { outcome: result.outcome, businessId: result.businessId, locations: result.locations });
    return destination(req, result.businessId, result.outcome);
  } catch (failure) {
    const outcome = outcomeFor(failure);
    log.warn("google_callback_failed", { outcome, ...errorFields(failure) });
    if (outcome !== "not_configured") recordFailure(clientIp(req));
    return destination(req, null, outcome);
  }
}
