import * as AuthSession from "expo-auth-session";
import { appConfig } from "../src/config";
import {
  MicrosoftSignInCancelledError,
  isMicrosoftSignInCancelled,
  microsoftSignInAvailable,
  signInWithMicrosoft
} from "../src/auth/microsoft";

// The browser and discovery modules are mocked; a real flow needs a development
// or store build and an Entra app registration.
jest.mock("../src/config", () => ({
  appConfig: {
    apiBaseUrl: "",
    googleWebClientId: "",
    googleIosClientId: "",
    microsoftClientId: "microsoft-client-id",
    variant: "test",
    version: "1.0.0"
  }
}));

jest.mock("expo-auth-session", () => ({
  AuthRequest: jest.fn(),
  ResponseType: { Code: "code" },
  Prompt: { SelectAccount: "select_account" },
  fetchDiscoveryAsync: jest.fn(),
  exchangeCodeAsync: jest.fn(),
  makeRedirectUri: jest.fn()
}));

const AuthRequest = AuthSession.AuthRequest as unknown as jest.Mock;
const fetchDiscovery = AuthSession.fetchDiscoveryAsync as jest.Mock;
const exchangeCode = AuthSession.exchangeCodeAsync as jest.Mock;
const makeRedirectUri = AuthSession.makeRedirectUri as jest.Mock;
const promptAsync = jest.fn();
const fakeModule = AuthSession as unknown as Parameters<typeof microsoftSignInAvailable>[0];

describe("native Microsoft sign-in", () => {
  beforeEach(() => {
    appConfig.microsoftClientId = "microsoft-client-id";
    AuthRequest.mockImplementation(() => ({ promptAsync, codeVerifier: "code-verifier" }));
    fetchDiscovery.mockResolvedValue({
      authorizationEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token"
    });
    makeRedirectUri.mockReturnValue("praiseloop://auth/microsoft");
    promptAsync.mockResolvedValue({ type: "success", params: { code: "auth-code" } });
    exchangeCode.mockResolvedValue({ idToken: "microsoft-id-token" });
  });

  it("is available only when the module and client id are present", () => {
    expect(microsoftSignInAvailable(null, "microsoft-client-id")).toBe(false);
    expect(microsoftSignInAvailable(fakeModule, "")).toBe(false);
    expect(microsoftSignInAvailable(fakeModule, "microsoft-client-id")).toBe(true);
    expect(microsoftSignInAvailable()).toBe(true);
  });

  it("uses Microsoft discovery and PKCE, then returns the ID token", async () => {
    await expect(signInWithMicrosoft()).resolves.toBe("microsoft-id-token");

    expect(fetchDiscovery).toHaveBeenCalledWith("https://login.microsoftonline.com/common/v2.0");
    expect(makeRedirectUri).toHaveBeenCalledWith({ scheme: "praiseloop", path: "auth/microsoft" });
    expect(AuthRequest).toHaveBeenCalledWith({
      clientId: "microsoft-client-id",
      scopes: ["openid", "email", "profile"],
      redirectUri: "praiseloop://auth/microsoft",
      responseType: "code",
      usePKCE: true,
      prompt: "select_account"
    });
    expect(promptAsync).toHaveBeenCalledWith({
      authorizationEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
    });
    expect(exchangeCode).toHaveBeenCalledWith({
      clientId: "microsoft-client-id",
      code: "auth-code",
      redirectUri: "praiseloop://auth/microsoft",
      scopes: ["openid", "email", "profile"],
      extraParams: { code_verifier: "code-verifier" }
    }, { tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token" });
  });

  it("turns closing the browser into a quiet no-op marker", async () => {
    promptAsync.mockResolvedValue({ type: "cancel", params: {} });

    const error = await signInWithMicrosoft().catch(cause => cause);
    expect(error).toBeInstanceOf(MicrosoftSignInCancelledError);
    expect(isMicrosoftSignInCancelled(error)).toBe(true);
  });

  it("also treats a dismissed browser as a cancellation", async () => {
    promptAsync.mockResolvedValue({ type: "dismiss", params: {} });

    const error = await signInWithMicrosoft().catch(cause => cause);
    expect(isMicrosoftSignInCancelled(error)).toBe(true);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("reports an authorization error instead of exchanging it", async () => {
    promptAsync.mockResolvedValue({ type: "error", params: { error: "access_denied" } });

    await expect(signInWithMicrosoft()).rejects.toThrow(/failed/i);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("rejects a success response without a code or an ID token", async () => {
    promptAsync.mockResolvedValueOnce({ type: "success", params: {} });
    await expect(signInWithMicrosoft()).rejects.toThrow(/authorization code/i);
    expect(exchangeCode).not.toHaveBeenCalled();

    exchangeCode.mockResolvedValueOnce({ idToken: null });
    await expect(signInWithMicrosoft()).rejects.toThrow(/did not return/i);
  });

  it("fails closed when discovery has no endpoints or the build is unconfigured", async () => {
    fetchDiscovery.mockResolvedValueOnce({ authorizationEndpoint: null, tokenEndpoint: null });
    await expect(signInWithMicrosoft()).rejects.toThrow(/configured correctly/i);

    appConfig.microsoftClientId = "";
    await expect(signInWithMicrosoft()).rejects.toThrow(/not available/i);
    expect(promptAsync).not.toHaveBeenCalled();
  });
});
