import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

// Microsoft publishes the multi-tenant signing keys here; jose caches them and
// honours Cache-Control. The same key set serves work/school and personal accounts.
const MICROSOFT_KEYS = createRemoteJWKSet(new URL("https://login.microsoftonline.com/common/discovery/v2.0/keys"));

// A multi-tenant token's issuer names the tenant, so there is no single fixed
// issuer to compare against. Accept exactly the v2.0 form and require the tenant
// in it to equal the token's own tid claim.
const ISSUER = /^https:\/\/login\.microsoftonline\.com\/([^/]+)\/v2\.0$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type MicrosoftIdentity = { subject: string; email: string | null; name: string | null; emailVerified: false };

export function allowedMicrosoftAudiences() {
  return (process.env.MICROSOFT_CLIENT_ID ?? "").split(",").map(v => v.trim()).filter(Boolean);
}

// Microsoft's email claim is informational: it is not guaranteed verified or to
// belong to the account holder, so callers must pass emailVerified: false.
export function microsoftEmail(claims: Record<string, unknown>): string | null {
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (EMAIL.test(email)) return email;
  const preferred = typeof claims.preferred_username === "string" ? claims.preferred_username.trim().toLowerCase() : "";
  return EMAIL.test(preferred) ? preferred : null;
}

// The tenant id is part of the subject so ids from different tenants cannot collide.
export function microsoftSubject(tid: unknown, sub: unknown): string | null {
  if (typeof tid !== "string" || !tid || typeof sub !== "string" || !sub) return null;
  return `${tid}:${sub}`;
}

// Returns null for any token that is not a currently valid Microsoft Entra ID
// token minted for one of our apps. `keys` is injectable for tests only.
export async function verifyMicrosoftIdToken(idToken: string, keys: JWTVerifyGetKey = MICROSOFT_KEYS): Promise<MicrosoftIdentity | null> {
  const audience = allowedMicrosoftAudiences();
  if (audience.length === 0 || idToken.length === 0 || idToken.length > 4096) return null;
  try {
    const { payload } = await jwtVerify(idToken, keys, { audience, algorithms: ["RS256"], clockTolerance: 5, requiredClaims: ["sub", "exp"] });
    const tid = payload.tid;
    const issuer = payload.iss;
    const issuerMatch = typeof issuer === "string" ? ISSUER.exec(issuer) : null;
    if (!issuerMatch || issuerMatch[1] !== tid) return null;
    const subject = microsoftSubject(tid, payload.sub);
    if (!subject) return null;
    return {
      subject,
      email: microsoftEmail(payload),
      name: typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : null,
      emailVerified: false
    };
  } catch { return null; }
}
