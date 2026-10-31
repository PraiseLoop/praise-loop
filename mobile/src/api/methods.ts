import type { ApiClient } from "./client";

export type AuthMethod = {
  provider: string;
  email: string | null;
  addedAt: string | null;
  lastUsedAt: string | null;
};

// The same labels the web uses; an unknown provider falls back to its raw id.
export const providerNames: Record<string, string> = { google: "Google", apple: "Apple", microsoft: "Microsoft" };
export const providerName = (provider: string) => providerNames[provider] ?? provider;

function timestamp(value: unknown) {
  return value === null || (typeof value === "string" && !Number.isNaN(Date.parse(value)));
}

function methodsFrom(value: unknown): AuthMethod[] {
  const methods = (value as { methods?: unknown } | null)?.methods;
  if (!Array.isArray(methods) || !methods.every(method => method
    && typeof method === "object"
    && typeof method.provider === "string"
    && (method.email === null || typeof method.email === "string")
    && timestamp(method.addedAt)
    && timestamp(method.lastUsedAt))) {
    throw new Error("The server returned invalid sign-in methods.");
  }
  return methods as AuthMethod[];
}

// The same owner-wide list the web uses. A 401 is handled by the shared client.
export async function listAuthMethods(client: ApiClient): Promise<AuthMethod[]> {
  return methodsFrom(await client.request<unknown>("/api/account/methods"));
}

export async function unlinkAuthMethod(client: ApiClient, provider: string): Promise<AuthMethod[]> {
  return methodsFrom(await client.request<unknown>("/api/account/methods", { method: "DELETE", body: { provider } }));
}

// Link a Google account from an already signed-in phone session. The ID token is
// verified on the server; it is never stored or logged.
export async function linkGoogleMethod(client: ApiClient, idToken: string): Promise<AuthMethod[]> {
  return methodsFrom(await client.request<unknown>("/api/account/methods", { method: "POST", body: { provider: "google", idToken } }));
}
