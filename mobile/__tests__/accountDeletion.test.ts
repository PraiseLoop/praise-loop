import { ApiError, createApiClient } from "../src/api/client";
import { deleteAccount } from "../src/api/account";
import {
  DELETE_ACCOUNT_CONFIRMATION,
  DELETE_ACCOUNT_SUBSCRIPTION_NOTE,
  DELETE_ACCOUNT_WARNING,
  confirmsDeletion,
  deletionErrorMessage
} from "../src/profile/accountDeletion";

function client(status: number, body: unknown = { ok: true }, calls: { url: string; method?: string; body?: unknown }[] = []) {
  return createApiClient({
    baseUrl: "http://localhost:3000",
    getToken: () => "mobile-token",
    fetchImpl: (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
    }) as typeof fetch
  });
}

describe("account deletion", () => {
  it("requires the exact typed confirmation", () => {
    expect(DELETE_ACCOUNT_CONFIRMATION).toBe("DELETE");
    expect(confirmsDeletion("DELETE")).toBe(true);
    expect(confirmsDeletion(" DELETE ")).toBe(true);
    for (const value of ["", "delete", "Delete", "DELETE account", "DELET"]) {
      expect(confirmsDeletion(value)).toBe(false);
    }
  });

  it("calls the owner-wide route with the confirmation field", async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    await deleteAccount(client(200, { ok: true }, calls));
    expect(calls[0].url).toBe("http://localhost:3000/api/account");
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].body).toEqual({ confirm: "DELETE" });
  });

  it("maps a 401 to the normal signed-out path", async () => {
    const error = await deleteAccount(client(401)).catch(cause => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: "signedOut", status: 401 });
    expect(deletionErrorMessage(error)).toBeNull();
  });

  it("keeps the server's refusal for a retryable failure", async () => {
    const error = await deleteAccount(client(400, { error: "Type DELETE to confirm account deletion" })).catch(cause => cause);
    expect(deletionErrorMessage(error)).toBe("Type DELETE to confirm account deletion");
  });

  it("shows a plain retry for network failures", () => {
    expect(deletionErrorMessage(new ApiError("network"))).toMatch(/check your connection/i);
    expect(deletionErrorMessage(new ApiError("timeout"))).toMatch(/check your connection/i);
    expect(deletionErrorMessage(new ApiError("http", 500))).toBe("That didn’t work. Try again.");
  });

  it("states what is deleted, that a web subscription is cancelled, and that store subscriptions must be cancelled in their store", () => {
    expect(DELETE_ACCOUNT_WARNING).toMatch(/businesses, reviews, posts, drafts, images/i);
    expect(DELETE_ACCOUNT_WARNING).toMatch(/cannot|no recovery/i);
    expect(DELETE_ACCOUNT_SUBSCRIPTION_NOTE).toMatch(/cancels a web subscription for you/i);
    expect(DELETE_ACCOUNT_SUBSCRIPTION_NOTE).toMatch(/does not cancel an App Store or Google Play/i);
    expect(DELETE_ACCOUNT_SUBSCRIPTION_NOTE).toMatch(/App Store/);
    expect(DELETE_ACCOUNT_SUBSCRIPTION_NOTE).toMatch(/Google Play/);
  });
});
