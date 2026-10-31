import type { NextAuthOptions } from "next-auth";
import { cookies } from "next/headers";
import GoogleProvider from "next-auth/providers/google";
import AzureADProvider from "next-auth/providers/azure-ad";
import { authAdapter } from "./auth-adapter";
import { signInWithIdentity, type AuthIdentity } from "./authLinking";
import { microsoftEmail, microsoftSubject } from "./microsoftIdToken";

type GoogleProfile = {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
};

type MicrosoftProfile = {
  tid?: unknown;
  sub?: unknown;
  email?: unknown;
  preferred_username?: unknown;
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

// Google and Microsoft are optional: an owner can sign in by email even when an
// organisation has no provider credentials. NextAuth still handles sessions and
// sign-out with an empty provider list, which keeps the email session's sign-out
// button working.
const googleConfigured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const microsoftConfigured = !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET);

// NextAuth's provider id is `azure-ad`; auth_accounts uses the canonical
// `microsoft` name, so lib/auth-adapter.ts maps between them. The subject is
// `${tid}:${sub}` for both web and phone, so ids from different tenants cannot collide.
const providers: NextAuthOptions["providers"] = [];
if (googleConfigured) {
  providers.push(GoogleProvider({
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? ""
  }));
}
if (microsoftConfigured) {
  providers.push(AzureADProvider({
    clientId: process.env.MICROSOFT_CLIENT_ID ?? "",
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET ?? "",
    tenantId: "common",
    authorization: { params: { scope: "openid email profile" } },
    // The provider's default profile fetches a Graph photo with the access token.
    // The ID token already has the name and address, and we store no tokens.
    profile(profile) {
      const microsoft = profile as MicrosoftProfile;
      return {
        id: microsoftSubject(microsoft.tid, microsoft.sub) ?? "",
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
        return result.ok;
      }
      if (account?.provider === "azure-ad") {
        const microsoft = profile as MicrosoftProfile | undefined;
        const subject = microsoftSubject(microsoft?.tid, microsoft?.sub);
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
        return result.ok;
      }
      return false;
    }
  },
  logger: { error: code => console.error("auth_error", code), warn: code => console.warn("auth_warning", code), debug: () => {} }
};

// Session and sign-out endpoints only need the session machinery. Google and
// Microsoft sign-in additionally need their own clients, checked below.
export function authConfigured() { return !!(process.env.NEXTAUTH_SECRET && process.env.NEXTAUTH_URL); }
export function googleSignInConfigured() { return googleConfigured; }
export function microsoftSignInConfigured() { return microsoftConfigured; }
