import { api } from "../api";
import { sessionStore } from "./store";
import { signInWithEmailCode } from "./email";
import { unregisterPushDevice } from "../notifications/controller";
import type { DemoOwnerKey } from "./demoOwners";

// Demo sign-in. The route only exists on a development server started with
// MOBILE_DEV_AUTH=1; production and every other build answer 404.
export async function signInDemo(owner: DemoOwnerKey): Promise<void> {
  const session = await api.request<{ token?: unknown }>("/api/mobile/session/dev", { method: "POST", body: { owner } });
  if (typeof session?.token !== "string" || session.token.length === 0) {
    throw new Error("The demo sign-in response was invalid.");
  }
  await sessionStore.save(session.token);
}

// Email one-time code (#157): the server verifies the code and returns a normal
// bearer session, which is stored exactly like the demo and Google paths.
export async function signInWithEmail(email: string, code: string): Promise<void> {
  const token = await signInWithEmailCode(api, email, code);
  await sessionStore.save(token);
}

// Native Google Sign-In (#85): the Google ID token goes to the server once, is
// exchanged for our own bearer session and is never stored or logged here.
export async function signInWithGoogleToken(idToken: string): Promise<void> {
  const session = await api.request<{ token?: unknown }>("/api/mobile/session", {
    method: "POST",
    body: { idToken }
  });
  if (typeof session?.token !== "string" || session.token.length === 0) {
    throw new Error("The Google sign-in response was invalid.");
  }
  await sessionStore.save(session.token);
}

// Native Sign in with Apple (#92): Apple sends the name only on the first
// authorization, so it is passed alongside the identity token. Neither is stored.
export async function signInWithAppleToken(identityToken: string, fullName: string | null = null): Promise<void> {
  const session = await api.request<{ token?: unknown }>("/api/mobile/session/apple", {
    method: "POST",
    body: { idToken: identityToken, ...(fullName ? { fullName } : {}) }
  });
  if (typeof session?.token !== "string" || session.token.length === 0) {
    throw new Error("The Apple sign-in response was invalid.");
  }
  await sessionStore.save(session.token);
}

// Native Microsoft Entra ID sign-in (#158): the ID token goes to the server once,
// is exchanged for our own bearer session and is never stored or logged here.
export async function signInWithMicrosoftToken(idToken: string): Promise<void> {
  const session = await api.request<{ token?: unknown }>("/api/mobile/session/microsoft", {
    method: "POST",
    body: { idToken }
  });
  if (typeof session?.token !== "string" || session.token.length === 0) {
    throw new Error("The Microsoft sign-in response was invalid.");
  }
  await sessionStore.save(session.token);
}

// Revoking is best-effort: the local token is cleared even when the server is
// unreachable, so the next launch starts signed out. The push token is removed
// first, while the session that owns it is still valid.
export async function signOut(): Promise<void> {
  await unregisterPushDevice(api);
  try {
    await api.request("/api/mobile/session/revoke", { method: "POST" });
  } catch {
    // Ignored on purpose.
  }
  await sessionStore.clear();
}
