// Client-side handling of an ended owner session (#137). The server already answers
// 401 to an expired or revoked session (lib/authorization.ts); this module decides
// what the browser does with that answer. Pure and dependency-free so it can be
// tested without React, and so the same rules apply on every page.

export const SESSION_ENDED_MESSAGE = "Your session ended. Sign in again.";
export const SESSION_ENDED_REASON = "session-ended";
const defaultLanding = "/approval";

// Our own protected API: a same-origin relative /api/ path. NextAuth's endpoints
// (/api/auth/*) answer for themselves and the phone app's routes (/api/mobile/*)
// are public or bearer-only, so a 401 from them never means "the cookie died".
export function isProtectedApiPath(url: string): boolean {
  if (!url.startsWith("/api/") || url.startsWith("//")) return false;
  const path = url.split(/[?#]/)[0];
  return !path.startsWith("/api/auth/") && path !== "/api/auth" && !path.startsWith("/api/mobile/");
}

// Only a 401 from a protected route ends the session. 403, 404, 409, 429 and 5xx
// keep their own messages. The landing page is where the owner signs in, the plans
// page and the legal/support pages are public and the dev email outbox is
// signed-out by design, so a 401 there must never send them anywhere (no loops,
// and a visitor can read the plans or the terms before signing in). The password
// reset page works without a session by design (#159).
const publicPages = new Set(["/", "/plans", "/privacy", "/terms", "/support", "/reset-password", "/dev/outbox"]);

export function isSessionExpiry(input: { status: number; url: string; pathname: string }): boolean {
  return input.status === 401 && isProtectedApiPath(input.url) && !publicPages.has(input.pathname);
}

// A callbackUrl is only honoured when it stays on this site: a relative path, not
// protocol-relative, no backslash tricks, and never back to a sign-in landing.
export function safeCallbackUrl(raw: string | null | undefined, fallback = defaultLanding): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || /[\u0000-\u001f]/.test(raw)) return fallback;
  if (raw === "/" || raw.startsWith("/?") || raw.startsWith("/#") || raw.startsWith("/api/")) return fallback;
  return raw;
}

// Where to send the owner: the landing page carries the sign-in button, the
// "session ended" message, and the page to come back to.
export function signInLocation(pathname: string, search = ""): string {
  const params = new URLSearchParams({ reason: SESSION_ENDED_REASON, callbackUrl: safeCallbackUrl(`${pathname}${search}`) });
  return `/?${params}`;
}

// What the landing page should show for its query string.
export function landingNotice(search: string): { message: string | null; callbackUrl: string | null } {
  const params = new URLSearchParams(search);
  const raw = params.get("callbackUrl");
  const callbackUrl = raw ? safeCallbackUrl(raw, "") || null : null;
  return { message: params.get("reason") === SESSION_ENDED_REASON ? SESSION_ENDED_MESSAGE : null, callbackUrl };
}

export type SessionExpiryDeps = {
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  // Clears the dead NextAuth cookie without navigating (signOut({ redirect: false })).
  signOut: () => Promise<unknown>;
  location: () => { pathname: string; search: string };
  navigate: (to: string) => void;
  // Upper bound on waiting for signOut so a stuck request cannot strand the owner.
  signOutTimeoutMs?: number;
};

// A fetch for our own API. Anything but a protected-route 401 comes back untouched.
// On a 401 the owner is signed out and sent to sign-in, and the returned promise
// never settles: the page's current action stops where it is instead of running
// its error handling and flashing a misleading "something went wrong".
export function createApiFetch(deps: SessionExpiryDeps) {
  let ending = false;
  return async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
    const response = await deps.fetchImpl(input, init);
    const here = deps.location();
    if (!isSessionExpiry({ status: response.status, url: input, pathname: here.pathname })) return response;
    if (!ending) {
      // Several polls can fail together; only the first one signs out and navigates.
      ending = true;
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, deps.signOutTimeoutMs ?? 3000); });
        await Promise.race([deps.signOut().catch(() => undefined), timeout]);
        clearTimeout(timer);
      } finally {
        deps.navigate(signInLocation(here.pathname, here.search));
      }
    }
    return new Promise<Response>(() => {});
  };
}
