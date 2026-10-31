import { ApiError } from "../src/api/client";
import { api } from "../src/api";
import { sessionStore } from "../src/auth/store";
import { signInWithMicrosoftToken } from "../src/auth/session";

jest.mock("../src/api", () => ({ api: { request: jest.fn() } }));
jest.mock("../src/auth/store", () => ({ sessionStore: { save: jest.fn() } }));

const request = api.request as jest.Mock;
const save = sessionStore.save as jest.Mock;

describe("Microsoft session exchange", () => {
  it("posts the ID token and saves the bearer session", async () => {
    request.mockResolvedValue({ token: "session-token", expires: "2026-12-01T00:00:00Z" });

    await signInWithMicrosoftToken("microsoft-id-token");

    expect(request).toHaveBeenCalledWith("/api/mobile/session/microsoft", {
      method: "POST",
      body: { idToken: "microsoft-id-token" }
    });
    expect(save).toHaveBeenCalledWith("session-token");
  });

  it("rejects an invalid session response without saving anything", async () => {
    request.mockResolvedValue({ token: 42 });

    await expect(signInWithMicrosoftToken("microsoft-id-token")).rejects.toThrow(/invalid/i);
    expect(save).not.toHaveBeenCalled();
  });

  it("passes a rejected sign-in through as signed out", async () => {
    request.mockRejectedValue(new ApiError("signedOut", 401));

    const error = await signInWithMicrosoftToken("microsoft-id-token").catch(cause => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe("signedOut");
    expect(save).not.toHaveBeenCalled();
  });
});
