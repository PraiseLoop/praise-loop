import { appConfig } from "../config";

// The modules are required lazily: Expo Go and Jest do not always have a usable
// native browser, and the app must still start there. The Microsoft button is
// hidden when the modules or the client id are absent.
type AuthSessionModule = typeof import("expo-auth-session");

// Microsoft's multi-tenant discovery document serves work/school and personal
// accounts. The token endpoint accepts a public client with PKCE and no secret.
const MICROSOFT_ISSUER = "https://login.microsoftonline.com/common/v2.0";
const REDIRECT_PATH = "auth/microsoft";
const SCOPES = ["openid", "email", "profile"];

export class MicrosoftSignInCancelledError extends Error {
  constructor() {
    super("Microsoft sign-in was cancelled.");
    this.name = "MicrosoftSignInCancelledError";
  }
}

export function isMicrosoftSignInCancelled(error: unknown): boolean {
  return error instanceof MicrosoftSignInCancelledError;
}

function loadAuthSessionModule(): AuthSessionModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("expo-auth-session") as AuthSessionModule;
  } catch {
    return null;
  }
}

// The arguments are injectable for tests; normal callers use the modules and the
// build's configuration.
export function microsoftSignInAvailable(
  module: AuthSessionModule | null = loadAuthSessionModule(),
  clientId: string = appConfig.microsoftClientId
): boolean {
  return module !== null && clientId.length > 0;
}

export async function signInWithMicrosoft(
  module: AuthSessionModule | null = loadAuthSessionModule(),
  clientId: string = appConfig.microsoftClientId
): Promise<string> {
  if (!module || !microsoftSignInAvailable(module, clientId)) {
    throw new Error("Microsoft sign-in is not available in this build.");
  }

  const discovery = await module.fetchDiscoveryAsync(MICROSOFT_ISSUER);
  if (!discovery.authorizationEndpoint || !discovery.tokenEndpoint) {
    throw new Error("Microsoft sign-in is not configured correctly.");
  }

  const redirectUri = module.makeRedirectUri({ scheme: "praiseloop", path: REDIRECT_PATH });
  const request = new module.AuthRequest({
    clientId,
    scopes: SCOPES,
    redirectUri,
    responseType: module.ResponseType.Code,
    usePKCE: true,
    prompt: module.Prompt.SelectAccount
  });

  const result = await request.promptAsync({ authorizationEndpoint: discovery.authorizationEndpoint });
  if (result.type === "cancel" || result.type === "dismiss") throw new MicrosoftSignInCancelledError();
  if (result.type !== "success") throw new Error("Microsoft sign-in failed. Try again.");

  const code = result.params.code;
  if (typeof code !== "string" || code.length === 0) {
    throw new Error("Microsoft did not return an authorization code.");
  }

  const token = await module.exchangeCodeAsync({
    clientId,
    code,
    redirectUri,
    scopes: SCOPES,
    extraParams: { code_verifier: request.codeVerifier ?? "" }
  }, { tokenEndpoint: discovery.tokenEndpoint });
  if (typeof token.idToken !== "string" || token.idToken.length === 0) {
    throw new Error("Microsoft did not return a sign-in token.");
  }
  return token.idToken;
}
