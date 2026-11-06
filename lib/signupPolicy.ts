import { createHash } from "node:crypto";
import { log } from "./log";

// Pilot sign-up gate (#195). One rule for every sign-in path: a NEW owner may only
// be created while the gate is open or the provider's address is on the invite list.
// An identity that already has an owner, and a method linked from a live session,
// never pass through here. There is no schema change: the allow-list is an
// environment variable the operator edits and restarts.
export type SignupMode = "open" | "invite";

export type SignupIdentity = {
  provider: string;
  email: string | null;
  emailVerified: boolean;
};

let invalidModeWarned = false;

// Default `open` keeps local development, tests and existing deployments unchanged.
// Anything that is not exactly `open` or `invite` fails closed to `invite`, with one
// warning per process. The value itself is never logged.
export function signupMode(env: Record<string, string | undefined> = process.env): SignupMode {
  const raw = (env.SIGNUP_MODE ?? "").trim().toLowerCase();
  if (!raw || raw === "open") return "open";
  if (raw === "invite") return "invite";
  if (!invalidModeWarned) {
    invalidModeWarned = true;
    log.warn("signup_mode_invalid", { fallback: "invite" });
  }
  return "invite";
}

// Tests only: let a later case see its own first warning.
export function resetSignupModeWarning() {
  invalidModeWarned = false;
}

export function normaliseSignupEmail(value: string | null): string | null {
  const email = value?.trim().toLowerCase() ?? "";
  return email.length > 0 && email.length <= 320 ? email : null;
}

// Comma and/or whitespace separated. Entries are normalised once per call; an
// empty or oversized entry simply never matches. The list is never logged.
export function invitedEmails(env: Record<string, string | undefined> = process.env): Set<string> {
  return new Set(
    (env.INVITED_EMAILS ?? "")
      .split(/[\s,]+/)
      .map(entry => normaliseSignupEmail(entry))
      .filter((entry): entry is string => entry !== null)
  );
}

export function invitedEmail(email: string | null, env: Record<string, string | undefined> = process.env): boolean {
  const normalised = normaliseSignupEmail(email);
  return normalised !== null && invitedEmails(env).has(normalised);
}

// Apple may return a private-relay address or none at all, and only its verified
// claim counts; every other provider's reported address is compared as sent.
// Microsoft's address is used for the invite check even though it is not trusted
// enough to link owners, so an invited person can still create their own owner.
export function newOwnerAllowed(identity: SignupIdentity, env: Record<string, string | undefined> = process.env): boolean {
  if (signupMode(env) === "open") return true;
  if (identity.provider === "apple" && !identity.emailVerified) return false;
  return invitedEmail(identity.email, env);
}

// A refused attempt is logged without the address: provider plus a short hash of
// the normalised address (or no hash when Apple sent none). The allow-list never
// appears in a log line.
export function logRefusedSignup(identity: SignupIdentity) {
  const email = normaliseSignupEmail(identity.email);
  log.warn("signup_refused", {
    provider: identity.provider,
    identityRef: email ? createHash("sha256").update(email).digest("hex").slice(0, 12) : null
  });
}
