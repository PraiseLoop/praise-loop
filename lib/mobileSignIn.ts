import type { AppleIdentity } from "./appleIdToken";
import type { GoogleIdentity } from "./googleIdToken";
import type { MicrosoftIdentity } from "./microsoftIdToken";
import { signInWithIdentity, type SignInResult } from "./authLinking";

// Same identity as the web: auth_accounts(provider='google', provider_account_id=sub).
// The linking policy (including the verified-email fallback and the rejection of a
// different Google subject) lives in lib/authLinking.ts and is shared by web and
// phone. No Google tokens are stored. The result carries `invite_only` so the route
// can answer with the pilot's machine code (#195).
export async function signInGoogleIdentity(identity: GoogleIdentity): Promise<SignInResult> {
  return signInWithIdentity({
    provider: "google",
    subject: identity.sub,
    email: identity.email,
    emailVerified: true,
    name: identity.name
  });
}

export async function findOrCreateGoogleOwner(identity: GoogleIdentity) {
  const result = await signInGoogleIdentity(identity);
  return result.ok ? result.ownerId : null;
}

// Apple identity tokens carry the stable `sub`, never a name. The app may pass
// the first-sign-in name separately so fillProviderName can use it without
// replacing a name the owner edited.
export async function signInAppleIdentity(identity: AppleIdentity, name: string | null = null): Promise<SignInResult> {
  return signInWithIdentity({
    provider: "apple",
    subject: identity.subject,
    email: identity.email,
    emailVerified: identity.emailVerified,
    name
  });
}

export async function findOrCreateAppleOwner(identity: AppleIdentity, name: string | null = null) {
  const result = await signInAppleIdentity(identity, name);
  return result.ok ? result.ownerId : null;
}

// Microsoft's address is not guaranteed verified, so the shared policy never
// uses it to find an existing owner; the subject already includes the tenant id.
export async function signInMicrosoftIdentity(identity: MicrosoftIdentity): Promise<SignInResult> {
  return signInWithIdentity({
    provider: "microsoft",
    subject: identity.subject,
    email: identity.email,
    emailVerified: false,
    name: identity.name
  });
}

export async function findOrCreateMicrosoftOwner(identity: MicrosoftIdentity) {
  const result = await signInMicrosoftIdentity(identity);
  return result.ok ? result.ownerId : null;
}

// Failed-attempt limiter, per client key, in process memory. Resets on restart and
// is not shared between web replicas; fine for a single-instance pilot (docs/auth.md).
const FAIL_LIMIT = 10, FAIL_WINDOW_MS = 15 * 60 * 1000;
const failures = new Map<string, number[]>();
export function tooManyFailures(key: string, now = Date.now()) {
  const recent = (failures.get(key) ?? []).filter(t => now - t < FAIL_WINDOW_MS);
  if (recent.length) failures.set(key, recent); else failures.delete(key);
  return recent.length >= FAIL_LIMIT;
}
export function recordFailure(key: string, now = Date.now()) {
  if (failures.size > 10000) failures.clear();
  failures.set(key, [...(failures.get(key) ?? []), now]);
}
export function resetFailures() { failures.clear(); }
