import { NextResponse } from "next/server";
import { GoogleConnectionError } from "../services/googleConnection";
import { log } from "../log";

export type BusinessIdContext = { params: Promise<{ id: string }> };

export function businessIdFrom(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Short codes only: no provider text, token, code or state is ever echoed. */
export function googleFailure(error: unknown) {
  if (error instanceof GoogleConnectionError) {
    if (error.code === "not_configured") {
      log.warn("google_connect_not_configured", {
        note: "GOOGLE_REVIEW_SYNC, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_TOKEN_KEY and a redirect base must be set on the web container"
      });
    }
    return NextResponse.json({ error: error.code }, { status: error.status });
  }
  return NextResponse.json({ error: "Request failed" }, { status: 500 });
}
