import { NextRequest, NextResponse } from "next/server";
import { INVALID_CREDENTIALS_MESSAGE, signInWithPassword } from "../../../../../lib/passwordAuth";
import { createMobileSession } from "../../../../../lib/mobileSessions";
import { readLimitedText } from "../../../../../lib/requestBody";
import { clientIp } from "../../../../../lib/requestIp";

// Public by design: the phone half of password sign-in (#159). A wrong password
// is a 400, not a 401: the app treats 401 as "the session ended" and would clear
// a token over a typo, exactly like the email-code exchange.
export const dynamic = "force-dynamic";

const reply = (status: number, body: object, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

export async function POST(req: NextRequest) {
  let body: { email?: unknown; password?: unknown };
  try {
    body = JSON.parse(await readLimitedText(req, 4096)) ?? {};
  } catch {
    return reply(400, { error: INVALID_CREDENTIALS_MESSAGE });
  }

  const result = await signInWithPassword(body.email, body.password, clientIp(req));
  if (!result.ok) {
    if (result.reason === "throttled") {
      return reply(429, { error: "Too many attempts; try again later" }, {
        "Retry-After": String(Math.max(1, Math.ceil(result.retryAfterMs / 1000)))
      });
    }
    return reply(400, { error: "invalid_credentials", message: INVALID_CREDENTIALS_MESSAGE });
  }

  const session = await createMobileSession(result.ownerId, { method: "password", userAgent: req.headers.get("user-agent") });
  return reply(200, { token: session.token, expires: session.expires });
}
