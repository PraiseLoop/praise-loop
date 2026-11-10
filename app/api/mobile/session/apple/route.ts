import { NextRequest, NextResponse } from "next/server";
import { verifyAppleIdToken } from "../../../../../lib/appleIdToken";
import { recordFailure, signInAppleIdentity, tooManyFailures } from "../../../../../lib/mobileSignIn";
import { createMobileSession } from "../../../../../lib/mobileSessions";
import { clientIp } from "../../../../../lib/requestIp";
import { INVITE_ONLY_MESSAGE } from "../../../../../lib/signupMessages";
import { NAME_MAX_LENGTH } from "../../../../../lib/services/profile";

// Reads at most `max` bytes of the stream, so a missing or false Content-Length cannot make us buffer more.
async function readLimited(req: NextRequest, max: number) {
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { await reader.cancel(); throw new Error("body too large"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Apple sends the owner's name only on the first authorization, outside the
// identity token. Trim and cap what the app sends so it can fill a missing name
// but never exceed the profile limit.
function cleanFullName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim().slice(0, NAME_MAX_LENGTH) || null;
}

// Public by design: this is where a bearer session is born. Exchanges an Apple
// identity token from native Sign in with Apple for a mobile session. Neither
// token is logged.
export async function POST(req: NextRequest) {
  const reply = (status: number, body: object) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  try {
    // Client-supplied IP headers are only trustworthy behind a proxy that overwrites them.
    const client = clientIp(req);
    if (tooManyFailures(client)) return reply(429, { error: "Too many failed sign-in attempts; try again later" });
    let body: { idToken?: unknown; fullName?: unknown } | null = null;
    try { body = JSON.parse(await readLimited(req, 8192)); } catch { /* handled below */ }
    const identity = typeof body?.idToken === "string" ? await verifyAppleIdToken(body.idToken) : null;
    if (!identity) { recordFailure(client); return reply(401, { error: "Invalid Apple sign-in" }); }
    const result = await signInAppleIdentity(identity, cleanFullName(body?.fullName));
    if (!result.ok) {
      if (result.reason === "invite_only") return reply(403, { error: "invite_only", message: INVITE_ONLY_MESSAGE });
      recordFailure(client);
      return reply(401, { error: "Invalid Apple sign-in" });
    }
    const session = await createMobileSession(result.ownerId, { method: "apple", userAgent: req.headers.get("user-agent") });
    return reply(200, { token: session.token, expires: session.expires });
  } catch { return reply(500, { error: "Sign-in failed; retry" }); }
}
