import { NextResponse } from "next/server";
import { DEV_OWNERS, devAuthEnabled, ensureDevOwner, type DevOwnerKey } from "../../../../../lib/devAuth";
import { createMobileSession } from "../../../../../lib/mobileSessions";

// Demo-only counterpart to POST /api/mobile/session: no Google token, a fixed
// synthetic owner. Available only in a development process with MOBILE_DEV_AUTH=1
// (see lib/devAuth.ts); otherwise it answers exactly like an unknown route.
// An optional JSON body {"owner":"business"} signs in as the seeded Business
// owner instead of the default Pro demo owner.
export async function POST(req?: Request) {
  if (!devAuthEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  let which: DevOwnerKey = "pro";
  const body = await req?.json().catch(() => null) as { owner?: unknown } | null;
  if (body?.owner !== undefined) {
    if (typeof body.owner !== "string" || !Object.prototype.hasOwnProperty.call(DEV_OWNERS, body.owner)) {
      return NextResponse.json({ error: "Unknown demo owner" }, { status: 400 });
    }
    which = body.owner as DevOwnerKey;
  }
  try {
    const owner = await ensureDevOwner(which);
    const session = await createMobileSession(owner, { method: "dev", userAgent: req?.headers.get("user-agent") });
    return NextResponse.json(
      { token: session.token, expires: session.expires, owner },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json({ error: "Sign-in failed; retry" }, { status: 500 });
  }
}
