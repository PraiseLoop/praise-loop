import { AsyncLocalStorage } from "node:async_hooks";
import { NextRequest, NextResponse } from "next/server";
import { query } from "./db";
import { authAdapter } from "./auth-adapter";
import { resolveMobileSession } from "./mobileSessions";
type Session = { owner: string; kind: "web" | "mobile"; token: string };
const sessions = new AsyncLocalStorage<Session>();
export function currentOwner() { const session = sessions.getStore(); if (!session) throw new Error("Owner context missing"); return session.owner; }
export function currentSession() { return sessions.getStore() ?? null; }
export async function readSession(req: NextRequest): Promise<Session | null> {
  const cookie = req.cookies.get("__Secure-next-auth.session-token")?.value ?? req.cookies.get("next-auth.session-token")?.value;
  const authorization = req.headers.get("authorization");
  // A request must authenticate one way only; accepting both would make CSRF
  // behaviour depend on header precedence.
  if (cookie && authorization) return null;
  if (authorization) {
    const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization);
    if (!match || match[1].length !== 43) return null;
    const session = await resolveMobileSession(match[1]);
    return session ? { owner: session.ownerId, kind: "mobile", token: session.token } : null;
  }
  if (!cookie || cookie.length > 512) return null;
  const owner = (await authAdapter.getSessionAndUser!(cookie))?.user.id;
  return owner ? { owner, kind: "web", token: cookie } : null;
}
export async function ownerId(req: NextRequest) { return (await readSession(req))?.owner ?? null; }
export async function chargeGeneration(owner: string, amount = 1, kind = "generation") {
  const configured = Number(process.env.OWNER_GENERATION_DAILY_LIMIT ?? 25);
  const limit = kind === "preview" ? 120 : Number.isSafeInteger(configured) && configured > 0 ? configured : 25;
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > limit) return false;
  return !!(await query(`INSERT INTO owner_usage(owner_id,day,kind,calls) VALUES($1,(now() AT TIME ZONE 'UTC')::date,$2,$3)
    ON CONFLICT(owner_id,day,kind) DO UPDATE SET calls=owner_usage.calls+$3 WHERE owner_usage.calls+$3<=$4 RETURNING calls`, [owner,kind,amount,limit])).rowCount;
}
const OWNER_WIDE_PATHS = ["/api/businesses", "/api/branding/preview", "/api/drafts/bulk", "/api/onboarding", "/api/mobile/session/revoke", "/api/entitlements", "/api/mobile/push-tokens", "/api/profile", "/api/account", "/api/account/methods"];
export function ownerRoute(handler: (req: NextRequest, context: any) => Promise<Response>) {
  return async (req: NextRequest, context?: any) => {
    const deny = (status: number, error: string) => NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
    try {
      const session = await readSession(req);
      if (!session) return deny(401, "Sign in to access your business");
      const owner = session.owner;
      const path = req.nextUrl.pathname, mutation = !["GET", "HEAD"].includes(req.method);
      let input: Record<string, unknown> = {};
      if (mutation) {
        // Cookie writes stay same-origin so browsers can't be tricked into CSRF.
        // Bearer writes need no origin: a browser never attaches the token itself.
        if (session.kind === "web") {
          const expected = process.env.NEXTAUTH_URL;
          if (!expected || req.headers.get("origin") !== new URL(expected).origin || req.headers.get("sec-fetch-site") === "cross-site") return deny(403, "Same-origin request required");
        }
        const reader = req.clone().body?.getReader(); let bytes = 0;
        if (reader) { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 1500000) { void reader.cancel(); return deny(413, "Upload exceeds 1.5 MB"); } } }
        const copy = req.clone();
        if (req.headers.get("content-type")?.startsWith("multipart/form-data")) input = Object.fromEntries(await copy.formData());
        else {
          const text = await copy.text();
          if (text.length > 0) {
            try { input = JSON.parse(text); } catch { return deny(400, "Valid JSON body required"); }
          }
        }
      }
      let businessId: unknown, draftId: unknown;
      const businessPath = /^\/api\/businesses\/(\d+)(?:\/brand-voice)?$/.exec(path);
      if (OWNER_WIDE_PATHS.includes(path)) { /* owner-wide operations */ }
      else if (businessPath) businessId = businessPath[1];
      else if (["/api/reviews", "/api/drafts", "/api/generation", "/api/posting-slots"].includes(path)) businessId = mutation ? input.businessId : req.nextUrl.searchParams.get("businessId");
      else if (["/api/reviews/import", "/api/quotes/select", "/api/posting-slots", "/api/posting-slots/assign"].includes(path)) businessId = input.businessId;
      else if (/^\/api\/(drafts\/(caption|status|schedule)|generation\/(retry|regenerate)|captions\/generate|images\/render)$/.test(path)) draftId = input.draftPostId;
      else if (path.startsWith("/api/media/")) {
        const exists = await query("SELECT 1 FROM draft_posts d JOIN businesses b ON b.id=d.business_id WHERE b.owner_id=$1 AND d.image_path=$2", [owner,path]);
        if (!exists.rowCount) return deny(404, "Image not found");
      } else return deny(403, "Unrecognized protected operation");
      if (businessId !== undefined || draftId !== undefined) {
        const id = Number(businessId ?? draftId);
        if (!Number.isSafeInteger(id) || id <= 0) return deny(400, "Valid resource ID required");
        const exists = draftId !== undefined ? await query("SELECT 1 FROM draft_posts d JOIN businesses b ON b.id=d.business_id WHERE d.id=$1 AND b.owner_id=$2", [id,owner]) : await query("SELECT 1 FROM businesses WHERE id=$1 AND owner_id=$2", [id,owner]);
        if (!exists.rowCount) return deny(404, "Resource not found");
      } else if (!OWNER_WIDE_PATHS.includes(path) && !path.startsWith("/api/media/")) return deny(400, "Resource ID required");
      if (["/api/captions/generate", "/api/images/render"].includes(path) && !await chargeGeneration(owner)) return deny(429, "Daily generation limit reached");
      if (path === "/api/branding/preview" && !await chargeGeneration(owner, 1, "preview")) return deny(429, "Preview limit reached");
      const response = await sessions.run(session, () => handler(req, context));
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    } catch { return deny(500, "Request failed; check configuration or retry"); }
  };
}
