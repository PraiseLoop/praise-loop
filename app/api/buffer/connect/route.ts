import { NextResponse } from "next/server";
import { currentOwner, ownerRoute } from "../../../../lib/authorization";
import { log } from "../../../../lib/log";
import { BufferConnectionError, startBufferConnect } from "../../../../lib/services/bufferConnection";

// Owner-wide: the connection belongs to the signed-in owner, not to one business.
async function handlePOST() {
  try {
    return NextResponse.json({ url: await startBufferConnect(currentOwner()) });
  } catch (error) {
    if (error instanceof BufferConnectionError && error.code === "not_configured") {
      log.warn("buffer_connect_not_configured", { note: "BUFFER_CLIENT_ID, BUFFER_CLIENT_SECRET, CREDENTIAL_ENCRYPTION_KEY and NEXTAUTH_URL (or BUFFER_REDIRECT_URI) must all be set on the web container" });
      return NextResponse.json({ error: "Buffer isn't configured" }, { status: 503 });
    }
    if (error instanceof BufferConnectionError && error.code === "plan_required") {
      return NextResponse.json({ error: "automatic_posting_required" }, { status: 403 });
    }
    throw error;
  }
}

export const POST = ownerRoute(handlePOST);
