import { NextRequest, NextResponse } from "next/server";
import { ownerId } from "../../../../lib/authorization";
import { recordFailure, tooManyFailures } from "../../../../lib/mobileSignIn";
import { errorFields, log } from "../../../../lib/log";
import { clientIp } from "../../../../lib/requestIp";
import {
  MetaConnectionError,
  completeMetaConnect,
  type MetaOutcome
} from "../../../../lib/services/metaConnection";

// Public to the route guard (Facebook's redirect carries no bearer token and no
// CSRF header), but NOT anonymous: the browser must be signed in as the same
// owner who started the flow, so a state alone cannot attach a victim's Meta
// account to an attacker's PraiseLoop account. Never answers 5xx to a browser
// redirect flow.
export const dynamic = "force-dynamic";

function destination(req: NextRequest, outcome: MetaOutcome) {
  const base = process.env.NEXTAUTH_URL?.replace(/\/+$/, "") || req.nextUrl.origin;
  return NextResponse.redirect(`${base}/connections?meta=${outcome}`, 302);
}

function outcomeFor(error: unknown): MetaOutcome {
  if (error instanceof MetaConnectionError) {
    if (error.code === "not_configured") return "not_configured";
    if (error.code === "expired") return "expired";
    if (error.code === "plan_required") return "plan_required";
  }
  return "failed";
}

export async function GET(req: NextRequest) {
  const error = req.nextUrl.searchParams.get("error");
  // Facebook reports a refused or cancelled authorization as `error`; there is no
  // error_description to read or pass on.
  if (error) {
    log.warn("meta_callback_refused", { metaError: /^[a-z_]{1,40}$/.test(error) ? error : "other" });
    return destination(req, error === "access_denied" ? "denied" : "failed");
  }

  const ip = clientIp(req);
  if (tooManyFailures(ip)) { log.warn("meta_callback_rate_limited"); return destination(req, "failed"); }

  // The signed-in owner of this browser. A missing session, or a different owner
  // than the one who started the flow, consumes nothing and stores nothing.
  const owner = await ownerId(req);
  if (!owner) {
    log.warn("meta_callback_no_session", { reason: "no signed-in PraiseLoop session on the callback request" });
    recordFailure(ip);
    return destination(req, "failed");
  }

  try {
    const result = await completeMetaConnect({
      state: req.nextUrl.searchParams.get("state"),
      code: req.nextUrl.searchParams.get("code"),
      ownerId: owner
    });
    log.info("meta_connect_callback", { outcome: result.outcome, pages: result.pages });
    return destination(req, result.outcome);
  } catch (failure) {
    const outcome = outcomeFor(failure);
    log.warn("meta_callback_failed", { outcome, ...errorFields(failure) });
    if (outcome !== "not_configured") recordFailure(ip);
    return destination(req, outcome);
  }
}
