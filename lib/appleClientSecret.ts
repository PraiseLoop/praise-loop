import { sign } from "node:crypto";

// Sign in with Apple's web flow needs a short-lived ES256 JWT instead of a static
// client secret. It is signed with the team's `.p8` key and identifies the
// Services ID (`sub`) and Team ID (`iss`) to Apple's token endpoint.
// https://developer.apple.com/documentation/sign_in_with_apple/generate_and_validate_tokens
export const APPLE_ISSUER = "https://appleid.apple.com";
// Apple allows up to six months. A short lifetime keeps a leaked value useless,
// and the provider regenerates the JWT on each NextAuth request (#92).
export const APPLE_CLIENT_SECRET_TTL_SECONDS = 60 * 60;

export type AppleWebConfig = {
  /** The Services ID, used as the OAuth client id. */
  clientId: string;
  teamId: string;
  keyId: string;
  /** PKCS#8 PEM contents of the `.p8` key. */
  privateKey: string;
};

function value(input: string | undefined): string {
  return (input ?? "").trim();
}

// Environment files and Docker Compose often carry the key with literal `\n`
// escapes instead of real line breaks.
export function normaliseApplePrivateKey(privateKey: string): string {
  return privateKey.replace(/\\n/g, "\n").trim();
}

// Fail closed: the web provider (and its button) exists only when every value is
// present. The native phone check is separate and uses APPLE_CLIENT_ID.
export function appleWebConfig(env: Record<string, string | undefined> = process.env): AppleWebConfig | null {
  const clientId = value(env.APPLE_WEB_CLIENT_ID);
  const teamId = value(env.APPLE_TEAM_ID);
  const keyId = value(env.APPLE_KEY_ID);
  const privateKey = normaliseApplePrivateKey(value(env.APPLE_PRIVATE_KEY));
  if (!clientId || !teamId || !keyId || !privateKey) return null;
  return { clientId, teamId, keyId, privateKey };
}

function base64url(input: object): string {
  return Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
}

// The JWT Apple accepts as `client_secret`. `dsaEncoding: "ieee-p1363"` is the
// raw R||S form JOSE requires; Node's default DER encoding would be rejected.
export function createAppleClientSecret(
  config: AppleWebConfig,
  issuedAt: number = Math.floor(Date.now() / 1000)
): string {
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) throw new Error("Invalid Apple client secret issue time");
  const header = base64url({ alg: "ES256", kid: config.keyId });
  const claims = base64url({
    iss: config.teamId,
    iat: issuedAt,
    exp: issuedAt + APPLE_CLIENT_SECRET_TTL_SECONDS,
    aud: APPLE_ISSUER,
    sub: config.clientId
  });
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`, "utf8"), {
    key: config.privateKey,
    dsaEncoding: "ieee-p1363"
  });
  return `${header}.${claims}.${signature.toString("base64url")}`;
}
