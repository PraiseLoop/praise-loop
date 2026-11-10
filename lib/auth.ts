import type { NextAuthOptions } from "next-auth";
import { cookies } from "next/headers";
import AppleProvider from "next-auth/providers/apple";
import GoogleProvider from "next-auth/providers/google";
import AzureADProvider from "next-auth/providers/azure-ad";
import { authAdapter } from "./auth-adapter";
import { appleWebConfig, createAppleClientSecret } from "./appleClientSecret";
import { signInWithIdentity, type AuthIdentity } from "./authLinking";
import { microsoftEmail, microsoftSubject } from "./microsoftIdToken";
import { callerUserAgent, canonicalSignInMethod, notifyNewSignIn } from "./signInAlerts";

type GoogleProfile = {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
};

type MicrosoftProfile = {
  tid?: unknown;
  oid?: unknown;
  sub?: unknown;
  email?: unknown;
  preferred_username?: unknown;
  name?: unknown;
};

type AppleProfile = {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
};

// The owner who started a link from an already signed-in page. The OAuth callback
// still carries the session cookie, which is the proof that this is an add-method
// action rather than a fresh sign-in.
async function signedInOwner() {
  try {
    const store = await cookies();
    const token = store.get("__Secure-next-auth.session-token")?.value ?? store.get("next-auth.session-token")?.value;
    if (!token || token.length > 512) return null;
    return (await authAdapter.getSessionAndUser!(token))?.user.id ?? null;
  } catch {
    return null;
  }
}

// A refused new sign-up goes back to the landing page with a machine code the page
// turns into the invite-only message (#195). Returning a string makes NextAuth use it
// as the redirect instead of its generic AccessDenied error page.
function inviteOnlyRedirect() {
  const base = (process.env.NEXTAUTH_URL ?? "").replace(/\/+$/, "");
  return `${base}/?error=invite_only`;
}

// Google, Apple and Microsoft are optional: an owner can sign in by email even
// when an organisation has no provider credentials. NextAuth still handles
// sessions and sign-out with an empty provider list, which keeps the email
// session's sign-out button working.
const googleConfigured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
// A Services ID plus the team's `.p8` key are needed only for the web flow. The
// native app keeps using APPLE_CLIENT_ID on the phone exchange.
const appleWeb = appleWebConfig();
const appleConfigured = !!appleWeb;
// MICROSOFT_CLIENT_ID may list several ids for the phone token check. The web flow needs exactly one
// application, and it is the first id in the list, so the web registration goes first.
const microsoftWebClientId = (process.env.MICROSOFT_CLIENT_ID ?? "").split(",")[0].trim();
const microsoftConfigured = !!(microsoftWebClientId && process.env.MICROSOFT_CLIENT_SECRET);

// Apple answers with response_mode=form_post, a cross-site POST. A Lax cookie is
// not sent on that request, so the PKCE verifier (and the state cookie, if a
// future NextAuth Apple provider checks it) must be SameSite=None; Secure.
// Without HTTPS there is no valid Apple return URL, so local HTTP keeps Lax and
// simply cannot complete the flow.
const secureCookies = (process.env.NEXTAUTH_URL ?? "").startsWith("https://");
const formPostSameSite: "none" | "lax" = secureCookies ? "none" : "lax";
const formPostCookieOptions = { httpOnly: true, sameSite: formPostSameSite, path: "/", secure: secureCookies, maxAge: 15 * 60 };
const formPostCookies = appleConfigured ? {
  pkceCodeVerifier: { name: `${secureCookies ? "__Secure-" : ""}next-auth.pkce.code_verifier`, options: formPostCookieOptions },
  state: { name: `${secureCookies ? "__Secure-" : ""}next-auth.state`, options: formPostCookieOptions }
} : undefined;

// NextAuth's provider id is `azure-ad`; auth_accounts uses the canonical
// `microsoft` name, so lib/auth-adapter.ts maps between them. The subject is
// `${tid}:${oid}` for both web and phone, so ids from different tenants cannot collide.
const providers: NextAuthOptions["providers"] = [];
if (googleConfigured) {
  providers.push(GoogleProvider({
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? ""
  }));
}
if (appleWeb) {
  // Apple's client secret is a short-lived ES256 JWT. Keep a getter on the options
  // object so every NextAuth request (including a callback minutes after the page
  // loaded) gets a fresh signature instead of the one frozen at process start.
  const appleOptions = { clientId: appleWeb.clientId, clientSecret: "" };
  Object.defineProperty(appleOptions, "clientSecret", {
    enumerable: true,
    get: () => createAppleClientSecret(appleWeb)
  });
  providers.push(AppleProvider(appleOptions));
}
if (microsoftConfigured) {
  providers.push(AzureADProvider({
    clientId: microsoftWebClientId,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET ?? "",
    tenantId: "common",
    authorization: { params: { scope: "openid email profile" } },
    // The provider's default profile fetches a Graph photo with the access token.
    // The ID token already has the name and address, and we store no tokens.
    profile(profile) {
      const microsoft = profile as MicrosoftProfile;
      return {
        id: microsoftSubject(microsoft.tid, microsoft.oid) ?? "",
        name: typeof microsoft.name === "string" ? microsoft.name : null,
        email: microsoftEmail(microsoft as Record<string, unknown>),
        image: null
      };
    }
  }));
}

export const authOptions: NextAuthOptions = {
  adapter: authAdapter, secret: process.env.NEXTAUTH_SECRET,
  session: { strategy: "database", maxAge: 8 * 60 * 60 },
  providers,
  cookies: formPostCookies,
  // Every provider sign-in goes through the shared linking policy before NextAuth
  // creates a session. The adapter row is written first, so NextAuth's callback
  // handler finds the same owner the policy chose instead of making a second one.
  callbacks: {
    async signIn({ account, profile }) {
      if (account?.provider === "google") {
        const google = profile as GoogleProfile | undefined;
        const verified = google?.email_verified === true || google?.email_verified === "true";
        if (!verified || typeof google?.email !== "string" || !google.email.trim()) return false;
        const subject = typeof account.providerAccountId === "string" && account.providerAccountId
          ? account.providerAccountId
          : typeof google.sub === "string" ? google.sub : "";
        if (!subject) return false;
        const identity: AuthIdentity = {
          provider: "google",
          subject,
          email: google.email,
          emailVerified: true,
          name: typeof google.name === "string" ? google.name : null
        };
        const linkToOwner = await signedInOwner();
        const result = await signInWithIdentity(identity, linkToOwner ? { linkToOwner } : {});
        if (result.ok) return true;
        return result.reason === "invite_only" ? inviteOnlyRedirect() : false;
      }
      if (account?.provider === "apple") {
        const apple = profile as AppleProfile | undefined;
        const subject = typeof account.providerAccountId === "string" && account.providerAccountId
          ? account.providerAccountId
          : typeof apple?.sub === "string" ? apple.sub : "";
        if (!subject) return false;
        const identity: AuthIdentity = {
          provider: "apple",
          subject,
          email: typeof apple?.email === "string" && apple.email.trim() ? apple.email : null,
          // Apple always sends verified addresses (including a private relay). The
          // shared policy still never uses an Apple address to find an owner by
          // email (#92, #156); it is only the pilot invite gate's input (#195).
          emailVerified: apple?.email_verified === true || apple?.email_verified === "true",
          // The id_token has no name; Apple sends the first-sign-in name only in a
          // form field, which the web provider does not expose.
          name: typeof apple?.name === "string" ? apple.name : null
        };
        const linkToOwner = await signedInOwner();
        const result = await signInWithIdentity(identity, linkToOwner ? { linkToOwner } : {});
        if (result.ok) return true;
        return result.reason === "invite_only" ? inviteOnlyRedirect() : false;
      }
      if (account?.provider === "azure-ad") {
        const microsoft = profile as MicrosoftProfile | undefined;
        const subject = microsoftSubject(microsoft?.tid, microsoft?.oid);
        if (!subject) return false;
        const identity: AuthIdentity = {
          provider: "microsoft",
          subject,
          email: microsoftEmail(microsoft as Record<string, unknown>),
          emailVerified: false,
          name: typeof microsoft?.name === "string" ? microsoft.name : null
        };
        const linkToOwner = await signedInOwner();
        const result = await signInWithIdentity(identity, linkToOwner ? { linkToOwner } : {});
        if (result.ok) return true;
        return result.reason === "invite_only" ? inviteOnlyRedirect() : false;
      }
      return false;
    }
  },
  // NextAuth emits this after the session row exists, so a new alert never comes
  // from a failed sign-in or a session refresh. The custom email/dev web routes
  // notify from createWebSession instead.
  events: {
    async signIn({ user, account }) {
      const method = canonicalSignInMethod(account?.provider);
      if (!method || !user?.id) return;
      notifyNewSignIn({ ownerId: user.id, client: "web", method, userAgent: await callerUserAgent() });
    }
  },
  logger: { error: code => console.error("auth_error", code), warn: code => console.warn("auth_warning", code), debug: () => {} }
};

// Session and sign-out endpoints only need the session machinery. Google, Apple
// and Microsoft sign-in additionally need their own clients, checked below.
export function authConfigured() { return !!(process.env.NEXTAUTH_SECRET && process.env.NEXTAUTH_URL); }
export function googleSignInConfigured() { return googleConfigured; }
export function appleSignInConfigured() { return appleConfigured; }
export function microsoftSignInConfigured() { return microsoftConfigured; }
