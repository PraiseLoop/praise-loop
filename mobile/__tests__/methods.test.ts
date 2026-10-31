import { createApiClient } from "../src/api/client";
import { linkGoogleMethod, listAuthMethods, providerName, unlinkAuthMethod } from "../src/api/methods";

function client(status: number, body: unknown = {}, calls: { url: string; method?: string; body?: unknown }[] = []) {
  return createApiClient({
    baseUrl: "http://localhost:3000",
    getToken: () => "mobile-token",
    fetchImpl: (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
    }) as typeof fetch
  });
}

const google = { provider: "google", email: "owner@example.invalid", addedAt: "2026-10-30T12:00:00.000Z", lastUsedAt: null };

describe("sign-in methods API", () => {
  it("lists methods from the shared owner-wide route", async () => {
    const calls: { url: string }[] = [];
    const methods = await listAuthMethods(client(200, { methods: [google] }, calls));
    expect(methods).toEqual([google]);
    expect(calls[0].url).toBe("http://localhost:3000/api/account/methods");
  });

  it("sends the provider when unlinking", async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    await unlinkAuthMethod(client(200, { methods: [google] }, calls), "google");
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].body).toEqual({ provider: "google" });
  });

  it("links a Google ID token from a signed-in phone", async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    await linkGoogleMethod(client(200, { methods: [google] }, calls), "synthetic-id-token");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ provider: "google", idToken: "synthetic-id-token" });
  });

  it("labels Apple, Google and Microsoft the same way as the web", () => {
    expect(providerName("apple")).toBe("Apple");
    expect(providerName("google")).toBe("Google");
    expect(providerName("microsoft")).toBe("Microsoft");
  });

  it("rejects malformed methods instead of showing another owner's data", async () => {
    await expect(listAuthMethods(client(200, { methods: [{ provider: "google" }] }))).rejects.toThrow(/invalid sign-in methods/i);
    await expect(listAuthMethods(client(200, { methods: "google" }))).rejects.toThrow(/invalid sign-in methods/i);
  });

  it("replaces the list with the server's response after unlinking", async () => {
    const email = { provider: "email", email: "owner@example.invalid", addedAt: null, lastUsedAt: null };
    await expect(unlinkAuthMethod(client(200, { methods: [email] }), "google")).resolves.toEqual([email]);
  });

  it("replaces the list with the server's response after linking Google", async () => {
    const email = { provider: "email", email: "owner@example.invalid", addedAt: null, lastUsedAt: null };
    await expect(linkGoogleMethod(client(200, { methods: [google, email] }), "synthetic-id-token")).resolves.toEqual([google, email]);
  });

  it("keeps the server's last-method refusal available to the caller", async () => {
    await expect(unlinkAuthMethod(client(409, { error: "Keep at least one sign-in method so you can sign in again" }), "google"))
      .rejects.toMatchObject({ kind: "conflict", status: 409, detail: "Keep at least one sign-in method so you can sign in again" });
  });

  it("shows the server's 400 message for a bad Google token", async () => {
    await expect(linkGoogleMethod(client(400, { error: "Invalid Google sign-in" }), "bad-token"))
      .rejects.toMatchObject({ kind: "http", status: 400, message: "Invalid Google sign-in" });
  });

  it("keeps the server's account-taken refusal on a 409", async () => {
    await expect(linkGoogleMethod(client(409, { error: "That sign-in method already belongs to another account" }), "synthetic-id-token"))
      .rejects.toMatchObject({ kind: "conflict", status: 409, detail: "That sign-in method already belongs to another account" });
  });

  it("maps an ended session on every call to signed out", async () => {
    await expect(listAuthMethods(client(401))).rejects.toMatchObject({ kind: "signedOut" });
    await expect(unlinkAuthMethod(client(401), "google")).rejects.toMatchObject({ kind: "signedOut" });
    await expect(linkGoogleMethod(client(401), "synthetic-id-token")).rejects.toMatchObject({ kind: "signedOut" });
  });
});
