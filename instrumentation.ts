import { logLevel } from "./lib/log";

// Runs once when the web server starts. States how it was configured (presence only, never a value)
// so a missing setting is visible instead of showing up later as a vague failure.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { log } = await import("./lib/log");
  log.info("web_started", {
    logLevel: logLevel(), appEnv: process.env.APP_ENV || "prod",
    postingMode: (await import("./lib/services/bufferPosting")).postingMode(),
    nextauthUrlIsHttps: (process.env.NEXTAUTH_URL ?? "").startsWith("https://"),
    bufferClientConfigured: !!(process.env.BUFFER_CLIENT_ID && process.env.BUFFER_CLIENT_SECRET),
    encryptionKeyConfigured: !!process.env.CREDENTIAL_ENCRYPTION_KEY,
    googleConfigured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    mailTransport: process.env.EMAIL_TRANSPORT || "default"
  });
}
