import { NextResponse } from "next/server";
import { currentOwner, ownerRoute } from "../../../../lib/authorization";
import { log } from "../../../../lib/log";
import { MetaConnectionError, startMetaConnect } from "../../../../lib/services/metaConnection";

// Owner-wide: the Page list belongs to the signed-in owner, not to one business.
async function handlePOST() {
  try {
    return NextResponse.json({ url: await startMetaConnect(currentOwner()) });
  } catch (error) {
    if (error instanceof MetaConnectionError && error.code === "not_configured") {
      log.warn("meta_connect_not_configured", {
        note: "META_APP_ID, META_APP_SECRET, CREDENTIAL_ENCRYPTION_KEY and NEXTAUTH_URL (or META_REDIRECT_URI) must all be set on the web container"
      });
      return NextResponse.json({ error: "Meta isn't configured" }, { status: 503 });
    }
    if (error instanceof MetaConnectionError && error.code === "plan_required") {
      return NextResponse.json({ error: "automatic_posting_required" }, { status: 403 });
    }
    throw error;
  }
}

export const POST = ownerRoute(handlePOST);
