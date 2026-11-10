import { randomBytes } from "node:crypto";
import { authAdapter } from "./auth-adapter";
import { notifyNewSignIn } from "./signInAlerts";

// The web session the email-code flow creates is the same row and cookie NextAuth
// uses for Google: eight hours, hashed token, checked in Postgres on every request.
export const WEB_SESSION_HOURS = 8;

export type NewSignIn = { method: string; userAgent?: string | null };

export async function createWebSession(ownerId: string, now = Date.now(), signIn?: NewSignIn) {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(now + WEB_SESSION_HOURS * 60 * 60 * 1000);
  await authAdapter.createSession!({ sessionToken: token, userId: ownerId, expires });
  // Best effort, after the session exists: every custom web sign-in path calls
  // this, while NextAuth OAuth sign-ins notify from its post-session event.
  if (signIn) notifyNewSignIn({ ownerId, client: "web", ...signIn });
  return { token, expires };
}

// NextAuth 4 prefixes secure cookies when NEXTAUTH_URL is HTTPS. lib/authorization.ts
// already reads both names, so either deployment works.
export function webSessionCookie(token: string, expires: Date, env: Record<string, string | undefined> = process.env) {
  const secure = (env.NEXTAUTH_URL ?? "").startsWith("https://");
  return {
    name: secure ? "__Secure-next-auth.session-token" : "next-auth.session-token",
    value: token,
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure,
    expires
  };
}
