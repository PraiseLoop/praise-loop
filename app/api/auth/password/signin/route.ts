import { NextRequest, NextResponse } from "next/server";
import { INVALID_CREDENTIALS_MESSAGE, signInWithPassword } from "../../../../../lib/passwordAuth";
import { readLimitedText, sameOriginRequest } from "../../../../../lib/requestBody";
import { clientIp } from "../../../../../lib/requestIp";
import { createWebSession, webSessionCookie } from "../../../../../lib/webSessions";

// Public by design: the web half of password sign-in (#159). It sets the same
// hashed Postgres session cookie as Google and the email code. An unknown address
// and a wrong password return exactly the same body and status.
export const dynamic = "force-dynamic";

const reply = (status: number, body: object, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

export async function POST(req: NextRequest) {
  if (!sameOriginRequest(req)) return reply(403, { error: "Same-origin request required" });

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
    return reply(401, { error: "invalid_credentials", message: INVALID_CREDENTIALS_MESSAGE });
  }

  const session = await createWebSession(result.ownerId, Date.now(), { method: "password", userAgent: req.headers.get("user-agent") });
  const response = reply(200, { ok: true });
  response.cookies.set(webSessionCookie(session.token, session.expires));
  return response;
}
