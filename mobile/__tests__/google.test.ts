import { TurboModuleRegistry } from "react-native";
import { GoogleSignin } from "@react-native-google-signin/google-signin";
import { appConfig } from "../src/config";
import {
  GoogleSignInCancelledError,
  googleSignInAvailable,
  isGoogleSignInCancelled,
  signInWithGoogle
} from "../src/auth/google";

// The native module is mocked; the real package needs a custom dev build and is
// not available under Jest or Expo Go.
jest.mock("../src/config", () => ({
  appConfig: {
    apiBaseUrl: "",
    googleWebClientId: "web-client.apps.googleusercontent.com",
    googleIosClientId: "ios-client.apps.googleusercontent.com",
    variant: "test",
    version: "1.0.0"
  }
}));

jest.mock("@react-native-google-signin/google-signin", () => ({
  GoogleSignin: {
    configure: jest.fn(),
    signIn: jest.fn(),
    hasPlayServices: jest.fn().mockResolvedValue(true)
  },
  statusCodes: { SIGN_IN_CANCELLED: "SIGN_IN_CANCELLED" }
}));

const signIn = GoogleSignin.signIn as jest.Mock;
const configure = GoogleSignin.configure as jest.Mock;
// Expo Go has no RNGoogleSignin in its binary, and the package throws while it
// is being imported when the module is missing. The probe keeps that import from
// happening, so the tests drive it directly.
const registryGet = jest.spyOn(TurboModuleRegistry, "get");

describe("native Google sign-in", () => {
  beforeEach(() => {
    registryGet.mockReturnValue({});
    appConfig.googleWebClientId = "web-client.apps.googleusercontent.com";
    appConfig.googleIosClientId = "ios-client.apps.googleusercontent.com";
  });

  afterAll(() => {
    registryGet.mockRestore();
  });

  it("is unavailable when the native module is not registered", () => {
    registryGet.mockReturnValue(null);

    expect(googleSignInAvailable()).toBe(false);
    expect(registryGet).toHaveBeenCalledWith("RNGoogleSignin");
  });

  it("is unavailable when the registry lookup itself throws", () => {
    registryGet.mockImplementation(() => {
      throw new Error("no turbo module registry");
    });

    expect(googleSignInAvailable()).toBe(false);
  });

  it("loads the package when the native module is registered", () => {
    expect(googleSignInAvailable()).toBe(true);
  });

  it("is unavailable without the native module and without a web client id", () => {
    const fakeModule = {
      GoogleSignin,
      statusCodes: { SIGN_IN_CANCELLED: "SIGN_IN_CANCELLED" }
    } as unknown as Parameters<typeof googleSignInAvailable>[0];
    expect(googleSignInAvailable(null, "web-client")).toBe(false);
    expect(googleSignInAvailable(fakeModule, "")).toBe(false);
    expect(googleSignInAvailable()).toBe(true);
  });

  it("needs the iOS client id on iOS only", () => {
    const fakeModule = {
      GoogleSignin,
      statusCodes: { SIGN_IN_CANCELLED: "SIGN_IN_CANCELLED" }
    } as unknown as Parameters<typeof googleSignInAvailable>[0];
    expect(googleSignInAvailable(fakeModule, "web-client", "", "ios")).toBe(false);
    expect(googleSignInAvailable(fakeModule, "web-client", "ios-client", "ios")).toBe(true);
    expect(googleSignInAvailable(fakeModule, "web-client", "", "android")).toBe(true);
  });

  it("configures the clients and returns the ID token", async () => {
    signIn.mockResolvedValue({ type: "success", data: { idToken: "google-id-token" } });

    await expect(signInWithGoogle()).resolves.toBe("google-id-token");
    expect(configure).toHaveBeenCalledWith({
      webClientId: "web-client.apps.googleusercontent.com",
      iosClientId: "ios-client.apps.googleusercontent.com"
    });
  });

  it("turns a cancelled sheet into a quiet no-op marker", async () => {
    signIn.mockResolvedValue({ type: "cancelled", data: null });

    const error = await signInWithGoogle().catch(cause => cause);
    expect(error).toBeInstanceOf(GoogleSignInCancelledError);
    expect(isGoogleSignInCancelled(error)).toBe(true);
  });

  it("also treats the native cancellation code as a cancellation", async () => {
    signIn.mockRejectedValue(Object.assign(new Error("cancelled"), { code: "SIGN_IN_CANCELLED" }));

    const error = await signInWithGoogle().catch(cause => cause);
    expect(isGoogleSignInCancelled(error)).toBe(true);
  });

  it("rejects a success response without a token", async () => {
    signIn.mockResolvedValue({ type: "success", data: { idToken: null } });

    const error = await signInWithGoogle().catch(cause => cause);
    expect(error).toBeInstanceOf(Error);
    expect(isGoogleSignInCancelled(error)).toBe(false);
    expect((error as Error).message).toMatch(/did not return/i);
  });
});
