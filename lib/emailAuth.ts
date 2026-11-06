import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { signInWithIdentity, type SignInResult } from "./authLinking";
import { query, transaction } from "./db";
import { EmailError, getEmailTransport, oneTimeCodeEmail, sendEmail, stepUpCodeEmail } from "./email";

// One-time email codes (#157, #221). Sign-in and step-up codes share the same
// generator, hashing, expiry, attempt limits and throttles; only the purpose
// differs. A code issued for one purpose is stored with that purpose and can
// never be consumed by the other. Responses never reveal whether an address has
// an owner: only a malformed code or an exhausted code is rejected.
export type EmailCodePurpose = "sign_in" | "step_up";
export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_MAX_ATTEMPTS = 5;
// Wrong guesses allowed per address across all of its codes before the address is refused for a while.
export const ADDRESS_MAX_FAILURES = 15;
export const ADDRESS_FAILURE_WINDOW_MINUTES = 60;
const CODE_PATTERN = /^\d{6}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REQUEST_WINDOW_MS = 15 * 60 * 1000;
const REQUEST_PER_ADDRESS = 5;
const REQUEST_PER_IP = 20;

export class EmailSignInNotConfiguredError extends Error {
  constructor() { super("Email sign-in is not configured"); this.name = "EmailSignInNotConfiguredError"; }
}

// Missing NEXTAUTH_SECRET, or a transport that cannot send, is a server-wide
// configuration problem: the route may say so without revealing any address.
export function emailSignInConfigured(): boolean {
  if (!secret()) return false;
  try { getEmailTransport(); return true; } catch { return false; }
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length > 0 && email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null;
}

function secret(env: Record<string, string | undefined> = process.env): string | null {
  const value = env.NEXTAUTH_SECRET?.trim();
  return value ? value : null;
}

function hashCode(email: string, code: string, key: string, purpose: EmailCodePurpose): string {
  // Sign-in keeps its original input so codes issued before this change still verify.
  const input = purpose === "sign_in" ? `${email}:${code}` : `${purpose}:${email}:${code}`;
  return createHmac("sha256", key).update(input).digest("hex");
}

// Sign-in keeps its existing keys; step-up has its own budget, so the two paths
// can never throttle each other.
function throttleKey(purpose: EmailCodePurpose, kind: "address" | "ip", value: string): string {
  return purpose === "sign_in" ? `${kind}:${value}` : `step_up:${kind}:${value}`;
}

const requests = new Map<string, number[]>();

function recentRequests(key: string, now: number) {
  const recent = (requests.get(key) ?? []).filter(at => now - at < REQUEST_WINDOW_MS);
  if (recent.length) requests.set(key, recent); else requests.delete(key);
  return recent;
}

function recordRequest(key: string, now: number) {
  requests.set(key, [...recentRequests(key, now), now]);
  if (requests.size > 10000) {
    for (const [name, times] of requests) if (!times.some(at => now - at < REQUEST_WINDOW_MS)) requests.delete(name);
  }
}

export function resetEmailCodeThrottle() { requests.clear(); }

export type EmailCodeRequest = "sent" | "throttled";

// Always resolves the same way for a valid address. A throttled request sends
// nothing and is indistinguishable from a delivered one to the caller.
export async function requestEmailCode(email: string, ip: string, now = Date.now(), purpose: EmailCodePurpose = "sign_in"): Promise<EmailCodeRequest> {
  const key = secret();
  if (!key || !emailSignInConfigured()) throw new EmailSignInNotConfiguredError();
  const addressKey = throttleKey(purpose, "address", email), ipKey = throttleKey(purpose, "ip", ip);
  const allowed = recentRequests(addressKey, now).length < REQUEST_PER_ADDRESS
    && recentRequests(ipKey, now).length < REQUEST_PER_IP;
  if (!allowed) return "throttled";
  recordRequest(addressKey, now);
  recordRequest(ipKey, now);

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const hash = hashCode(email, code, key, purpose);

  // Send first. If the message cannot be sent (the transport's own hourly budget, a provider outage),
  // the code that was already delivered must stay valid, so nothing in the database changes. The
  // caller gets the same generic answer either way.
  try {
    const template = purpose === "step_up"
      ? stepUpCodeEmail(code, { minutes: CODE_TTL_MS / 60000 })
      : oneTimeCodeEmail(code, { minutes: CODE_TTL_MS / 60000 });
    await sendEmail({ to: email, ...template });
  } catch (error) {
    // Keep only a sanitized code in the log.
    const reason = error instanceof EmailError ? error.code : "email_send_failed";
    console.error(JSON.stringify({ event: "email_send_failed", reason }));
    return "sent";
  }

  await transaction(async () => {
    // Serialize replacement for one address and purpose. Without this, two concurrent requests
    // could both see no active row, insert, and leave two unsuperseded codes.
    const lockKey = purpose === "sign_in" ? email : `${purpose}:${email}`;
    await query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [lockKey]);
    await query(
      "UPDATE email_sign_in_codes SET superseded_at=now() WHERE email=$1 AND purpose=$2 AND consumed_at IS NULL AND superseded_at IS NULL",
      [email, purpose]
    );
    await query(
      "INSERT INTO email_sign_in_codes(email,code_hash,expires_at,purpose) VALUES($1,$2,$3,$4)",
      [email, hash, new Date(now + CODE_TTL_MS), purpose]
    );
  });
  return "sent";
}

export type EmailSignInResult =
  | { ok: true; ownerId: string }
  | { ok: false; reason: "invalid_code" | "invite_only" };

// Returns the owner on success. Wrong, expired, reused, superseded and exhausted
// codes all return `invalid_code` with no detail for the caller. A valid code for a
// brand-new address that the invite gate refuses returns `invite_only`; the code is
// consumed and no owner, method or session is left behind (#195).
export async function verifyEmailCode(email: string, code: string, now = Date.now()): Promise<EmailSignInResult> {
  const key = secret();
  if (!key || !CODE_PATTERN.test(code)) return { ok: false, reason: "invalid_code" };
  return transaction(async () => {
    if (!await consumeEmailCode(email, code, key, now, "sign_in")) return { ok: false, reason: "invalid_code" };
    const result = await findOrCreateEmailOwnerResult(email);
    if (result.ok) return { ok: true, ownerId: result.ownerId };
    return { ok: false, reason: result.reason === "invite_only" ? "invite_only" : "invalid_code" };
  });
}

// A step-up code only marks the current session; it never signs anyone in or
// creates or links an owner. Returns true when the code was valid and consumed.
export async function verifyStepUpCode(email: string, code: string, now = Date.now()): Promise<boolean> {
  const key = secret();
  if (!key || !CODE_PATTERN.test(code)) return false;
  return transaction(() => consumeEmailCode(email, code, key, now, "step_up"));
}

// The shared check for both purposes: newest active code for this address and
// purpose, the same expiry and attempt limits, and the same per-address cap.
async function consumeEmailCode(email: string, code: string, key: string, now: number, purpose: EmailCodePurpose): Promise<boolean> {
  const row = (await query<{ id: string; code_hash: string; attempts: number; expires_at: Date }>(
    `SELECT id,code_hash,attempts,expires_at FROM email_sign_in_codes
     WHERE email=$1 AND purpose=$2 AND consumed_at IS NULL AND superseded_at IS NULL
     ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [email, purpose]
  )).rows[0];
  if (!row) return false;
  // A fresh code resets its own guess count, so an attacker who keeps requesting codes would get five
  // more guesses each time. Cap the wrong guesses across every code for this address and purpose as
  // well. This lives in Postgres, so a restart or a second web replica does not reset it.
  const failed = Number((await query<{ n: string }>(
    "SELECT coalesce(sum(attempts),0) AS n FROM email_sign_in_codes WHERE email=$1 AND purpose=$2 AND created_at > now() - ($3 * interval '1 minute')",
    [email, purpose, ADDRESS_FAILURE_WINDOW_MINUTES]
  )).rows[0].n);
  if (failed >= ADDRESS_MAX_FAILURES) return false;
  if (row.expires_at.getTime() <= now || row.attempts >= CODE_MAX_ATTEMPTS) {
    await query("UPDATE email_sign_in_codes SET consumed_at=coalesce(consumed_at,now()) WHERE id=$1", [row.id]);
    return false;
  }
  const expected = Buffer.from(row.code_hash, "hex");
  const actual = Buffer.from(hashCode(email, code, key, purpose), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    await query("UPDATE email_sign_in_codes SET attempts=attempts+1 WHERE id=$1", [row.id]);
    return false;
  }
  await query("UPDATE email_sign_in_codes SET consumed_at=now() WHERE id=$1", [row.id]);
  return true;
}

// The linking policy (#156) lives in lib/authLinking.ts and is shared with Google: a code proves
// control of the address, so an owner already known by that address keeps one owner and gains an
// email method (with its added and last-used times), and concurrent first sign-ins are serialized
// there. Returns null when the policy refuses the sign-in; the result form below keeps the reason.
export async function findOrCreateEmailOwnerResult(email: string): Promise<SignInResult> {
  const result = await signInWithIdentity({ provider: "email", subject: email, email, emailVerified: true });
  if (result.ok) {
    // The code proved control of the mailbox, so the address now counts as verified.
    await query(`UPDATE auth_users SET "emailVerified"=coalesce("emailVerified",now()) WHERE id=$1`, [result.ownerId]);
  }
  return result;
}

export async function findOrCreateEmailOwner(email: string): Promise<string | null> {
  const result = await findOrCreateEmailOwnerResult(email);
  return result.ok ? result.ownerId : null;
}
