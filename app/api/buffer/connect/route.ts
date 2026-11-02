import { NextResponse } from "next/server";
import { currentOwner, ownerRoute } from "../../../../lib/authorization";
import { BufferConnectionError, startBufferConnect } from "../../../../lib/services/bufferConnection";

// Owner-wide: the connection belongs to the signed-in owner, not to one business.
async function handlePOST() {
  try {
    return NextResponse.json({ url: await startBufferConnect(currentOwner()) });
  } catch (error) {
    if (error instanceof BufferConnectionError && error.code === "not_configured") {
      return NextResponse.json({ error: "Buffer isn't configured" }, { status: 503 });
    }
    throw error;
  }
}

export const POST = ownerRoute(handlePOST);
