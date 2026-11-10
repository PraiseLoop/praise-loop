import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { query, transaction } from "./db";
import { normalizeEmail, verifyEmailCode } from "./emailAuth";
import { EmailError, getEmailTransport, passwordLockedEmail, passwordResetEmail, passwordResetNoAccountEmail, sendEmail } from "./email";
import { log } from "./log";
import { sessionHash } from "./auth-adapter";
import { checkPasswordBreach } from "./passwordBreach";
import { primaryVerifiedOwnerEmail, verifiedOwnerEmails } from "./verifiedEmails";

// Email and password sign-in (#159). The rule that decides who an owner is stays
// in lib/authLinking.ts: sign-up proves the mailbox with the existing email code,
// which creates or finds the owner through the #156 policy and passes the #195
// invite gate. This module only stores and checks a credential on that owner.
//
// Plaintext passwords exist in memory for the hash call and nowhere else. They
// are never written to a database column, a log line, an email or a response.

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

// New hashes use these parameters. Verification always reads the row's stored
// values, so raising these defaults only affects hashes created afterwards.
export const PASSWORD_HASH_PARAMS = { n: 16384, r: 8, p: 1, keyLength: 32 } as const;
const SALT_BYTES = 16;

export const ACCOUNT_FAILURE_LIMIT = 10;
export const ACCOUNT_FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const ACCOUNT_LOCK_BASE_MS = 15 * 60 * 1000;
export const ACCOUNT_LOCK_MAX_MS = 24 * 60 * 60 * 1000;

export const SIGN_IN_IP_LIMIT = 30;
export const SIGN_IN_WINDOW_MS = 15 * 60 * 1000;
export const SIGN_IN_BLOCK_BASE_MS = 15 * 60 * 1000;
export const SIGN_IN_BLOCK_MAX_MS = 24 * 60 * 60 * 1000;

export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
export const RESET_EMAIL_LIMIT = 5;
export const RESET_IP_LIMIT = 20;
export const RESET_WINDOW_MS = 15 * 60 * 1000;
export const RESET_BLOCK_BASE_MS = 15 * 60 * 1000;
export const RESET_BLOCK_MAX_MS = 24 * 60 * 60 * 1000;

export const INVALID_CREDENTIALS_MESSAGE = "That email and password don’t match.";
export const PASSWORD_RULE_MESSAGE = "Use at least 12 characters (up to 256). There are no other rules.";
export const PASSWORD_RULE_MESSAGE_TOO_LONG = "Use at most 256 characters.";

export type PasswordProblem = "too_short" | "too_long" | null;

export function passwordProblem(value: unknown): PasswordProblem {
  if (typeof value !== "string") return "too_short";
  const length = Array.from(value).length;
  if (length < PASSWORD_MIN_LENGTH) return "too_short";
  if (length > PASSWORD_MAX_LENGTH) return "too_long";
  return null;
}

export function passwordRuleMessage(problem: PasswordProblem) {
  return problem === "too_long" ? PASSWORD_RULE_MESSAGE_TOO_LONG : PASSWORD_RULE_MESSAGE;
}

export type ScryptParams = { n: number; r: number; p: number; keyLength: number };

export type StoredPasswordHash = ScryptParams & { hash: string; salt: string };

function validParams(params: ScryptParams): boolean {
  const { n, r, p, keyLength } = params;
  // N must be a power of two and stay inside a memory budget that a damaged or
  // tampered row cannot turn into an unbounded allocation.
  return Number.isInteger(n) && n >= 2 && n <= 262144 && (n & (n - 1)) === 0
    && Number.isInteger(r) && r >= 1 && r <= 32
    && Number.isInteger(p) && p >= 1 && p <= 16
    && Number.isInteger(keyLength) && keyLength >= 16 && keyLength <= 128;
}

function maxmem(params: ScryptParams) {
  // scrypt needs roughly 128*N*r bytes. Leave headroom for the implementation.
  return Math.max(32 * 1024 * 1024, 128 * params.n * params.r + 8 * 1024 * 1024);
}

function scryptKey(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, params.keyLength, { N: params.n, r: params.r, p: params.p, maxmem: maxmem(params) }, (error, key) => {
      if (error) reject(error); else resolve(key);
    });
  });
}

export async function hashPassword(password: string, params: ScryptParams = PASSWORD_HASH_PARAMS): Promise<StoredPasswordHash> {
  if (!validParams(params)) throw new Error("Invalid scrypt parameters");
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptKey(password, salt, params);
  return {
    n: params.n,
    r: params.r,
    p: params.p,
    keyLength: params.keyLength,
    salt: salt.toString("base64"),
    hash: key.toString("base64")
  };
}

// Constant-time comparison after scrypt. A missing or malformed row is a
// deliberate false, never a thrown error that a route might report differently.
export async function verifyPassword(password: string, stored: StoredPasswordHash): Promise<boolean> {
  const params = { n: stored.n, r: stored.r, p: stored.p, keyLength: stored.keyLength };
  if (!validParams(params) || typeof stored.salt !== "string" || typeof stored.hash !== "string") return false;
  if (Array.from(password).length > PASSWORD_MAX_LENGTH) return false;
  let salt: Buffer, expected: Buffer;
  try {
    salt = Buffer.from(stored.salt, "base64");
    expected = Buffer.from(stored.hash, "base64");
  } catch {
    return false;
  }
  if (salt.length < 8 || expected.length !== params.keyLength) return false;
  let actual: Buffer;
  try {
    actual = await scryptKey(password, salt, params);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Unknown addresses still cost one scrypt call, so "no such account" is not
// conspicuously faster than a wrong password.
async function decoyPasswordCheck(password: string) {
  const params = PASSWORD_HASH_PARAMS;
  try {
    await scryptKey(password, Buffer.from("praiseloop-decoy"), params);
  } catch {
    // A failed decoy is still a failed sign-in.
  }
}

type CredentialRow = {
  owner_id: string;
  email: string;
  password_hash: string;
  scrypt_n: number;
  scrypt_r: number;
  scrypt_p: number;
  salt: string;
  key_length: number;
  verified_at: Date;
  failed_attempts: number;
  failure_window_started_at: Date | null;
  lock_count: number;
  locked_until: Date | null;
};

function credentialHash(row: CredentialRow): StoredPasswordHash {
  return {
    n: Number(row.scrypt_n),
    r: Number(row.scrypt_r),
    p: Number(row.scrypt_p),
    keyLength: Number(row.key_length),
    salt: row.salt,
    hash: row.password_hash
  };
}

async function credentialByEmail(email: string) {
  return (await query<CredentialRow>(
    "SELECT * FROM password_credentials WHERE lower(email)=$1",
    [email]
  )).rows[0] ?? null;
}

async function credentialByOwner(ownerId: string) {
  return (await query<CredentialRow>(
    "SELECT * FROM password_credentials WHERE owner_id=$1",
    [ownerId]
  )).rows[0] ?? null;
}

export async function hasPassword(ownerId: string): Promise<boolean> {
  return !!(await query("SELECT 1 FROM password_credentials WHERE owner_id=$1", [ownerId])).rowCount;
}

// --- DB-backed throttles --------------------------------------------------

export type ThrottlePolicy = { limit: number; windowMs: number; blockMs: number; maxBlockMs: number };

export const SIGN_IN_IP_POLICY: ThrottlePolicy = {
  limit: SIGN_IN_IP_LIMIT,
  windowMs: SIGN_IN_WINDOW_MS,
  blockMs: SIGN_IN_BLOCK_BASE_MS,
  maxBlockMs: SIGN_IN_BLOCK_MAX_MS
};
export const RESET_EMAIL_POLICY: ThrottlePolicy = {
  limit: RESET_EMAIL_LIMIT,
  windowMs: RESET_WINDOW_MS,
  blockMs: RESET_BLOCK_BASE_MS,
  maxBlockMs: RESET_BLOCK_MAX_MS
};
export const RESET_IP_POLICY: ThrottlePolicy = {
  limit: RESET_IP_LIMIT,
  windowMs: RESET_WINDOW_MS,
  blockMs: RESET_BLOCK_BASE_MS,
  maxBlockMs: RESET_BLOCK_MAX_MS
};

function backoff(blockCount: number, base: number, max: number) {
  const exponent = Math.min(Math.max(blockCount - 1, 0), 16);
  return Math.min(base * 2 ** exponent, max);
}

/** Retry-After in milliseconds while a bucket is blocked; 0 when it is not. */
export async function throttleRetryAfter(bucket: string, now = Date.now()): Promise<number> {
  const row = (await query<{ blocked_until: Date | null }>(
    "SELECT blocked_until FROM password_throttle WHERE bucket=$1",
    [bucket]
  )).rows[0];
  if (!row?.blocked_until) return 0;
  const remaining = row.blocked_until.getTime() - now;
  return remaining > 0 ? remaining : 0;
}

/**
 * Count one hit against a bucket. When the limit is reached the bucket is
 * blocked with exponential backoff. The insert/update is atomic, so concurrent
 * attempts cannot each win an extra try. Returns the block end time when this
 * hit caused (or extended) a block.
 */
export async function bumpThrottle(bucket: string, policy: ThrottlePolicy, now = Date.now()): Promise<Date | null> {
  return transaction(async () => {
    const row = (await query<{ failures: number; block_count: number }>(
      `INSERT INTO password_throttle(bucket,failures,window_started_at,updated_at)
       VALUES($1,1,$2,$2)
       ON CONFLICT(bucket) DO UPDATE SET
         failures = CASE WHEN password_throttle.window_started_at <= $2::timestamptz - ($3::double precision * interval '1 millisecond')
                         THEN 1 ELSE password_throttle.failures + 1 END,
         window_started_at = CASE WHEN password_throttle.window_started_at <= $2::timestamptz - ($3::double precision * interval '1 millisecond')
                                  THEN $2 ELSE password_throttle.window_started_at END,
         updated_at = $2
       RETURNING failures, block_count`,
      [bucket, new Date(now), policy.windowMs]
    )).rows[0];
    if (row.failures < policy.limit) return null;
    const blockCount = row.block_count + 1;
    const blockedUntil = new Date(now + backoff(blockCount, policy.blockMs, policy.maxBlockMs));
    await query(
      `UPDATE password_throttle
       SET failures=0, block_count=$3, blocked_until=$4, window_started_at=$2, updated_at=$2
       WHERE bucket=$1`,
      [bucket, new Date(now), blockCount, blockedUntil]
    );
    return blockedUntil;
  });
}

export function signInIpBucket(ip: string) {
  return `signin:ip:${ip}`;
}

function resetEmailBucket(email: string) {
  return `reset:email:${createHash("sha256").update(email).digest("hex").slice(0, 32)}`;
}

function resetIpBucket(ip: string) {
  return `reset:ip:${ip}`;
}

// --- Account lock ---------------------------------------------------------

type CredentialFailure = { lockedUntil: Date };

async function recordCredentialFailure(ownerId: string, now: number): Promise<CredentialFailure | null> {
  return transaction(async () => {
    const row = (await query<CredentialRow>(
      "SELECT * FROM password_credentials WHERE owner_id=$1 FOR UPDATE",
      [ownerId]
    )).rows[0];
    if (!row) return null;
    if (row.locked_until && row.locked_until.getTime() > now) return null;

    const withinWindow = row.failure_window_started_at
      && now - row.failure_window_started_at.getTime() <= ACCOUNT_FAILURE_WINDOW_MS;
    const failures = withinWindow ? row.failed_attempts + 1 : 1;
    const windowStart = withinWindow ? row.failure_window_started_at : new Date(now);
    if (failures >= ACCOUNT_FAILURE_LIMIT) {
      const lockCount = row.lock_count + 1;
      const lockedUntil = new Date(now + backoff(lockCount, ACCOUNT_LOCK_BASE_MS, ACCOUNT_LOCK_MAX_MS));
      await query(
        `UPDATE password_credentials
         SET failed_attempts=0, failure_window_started_at=$2, lock_count=$3, locked_until=$4, updated_at=$2
         WHERE owner_id=$1`,
        [ownerId, new Date(now), lockCount, lockedUntil]
      );
      return { lockedUntil };
    }
    await query(
      `UPDATE password_credentials
       SET failed_attempts=$2, failure_window_started_at=$3, updated_at=$4
       WHERE owner_id=$1`,
      [ownerId, failures, windowStart, new Date(now)]
    );
    return null;
  });
}

async function resetCredentialCounters(ownerId: string) {
  await query(
    `UPDATE password_credentials
     SET failed_attempts=0, failure_window_started_at=NULL, lock_count=0, locked_until=NULL, updated_at=now()
     WHERE owner_id=$1`,
    [ownerId]
  );
}

// --- Lock email (best effort) --------------------------------------------

const pendingLockEmails = new Set<Promise<void>>();

function lockEmailUrl(env: NodeJS.ProcessEnv = process.env) {
  const base = env.NEXTAUTH_URL?.trim().replace(/\/+$/, "");
  if (!base) return null;
  try {
    const url = new URL(base);
    return url.protocol === "http:" || url.protocol === "https:" ? `${url.origin}/reset-password` : null;
  } catch {
    return null;
  }
}

async function deliverLockEmail(ownerId: string, lockedUntil: Date) {
  const recipients = await verifiedOwnerEmails(ownerId);
  if (recipients.length === 0) return;
  const template = passwordLockedEmail({
    resetUrl: lockEmailUrl(),
    minutes: Math.max(1, Math.round((lockedUntil.getTime() - Date.now()) / 60000))
  });
  for (const to of recipients) {
    try {
      await sendEmail({ to, ...template });
    } catch (error) {
      log.error("password_lock_email_failed", {
        reason: error instanceof EmailError ? error.code : "unexpected"
      });
    }
  }
}

function notifyAccountLocked(ownerId: string, lockedUntil: Date) {
  const task = deliverLockEmail(ownerId, lockedUntil)
    .catch(error => log.error("password_lock_email_failed", {
      reason: error instanceof EmailError ? error.code : "unexpected"
    }))
    .finally(() => { pendingLockEmails.delete(task); });
  pendingLockEmails.add(task);
}

/** Tests wait for the best-effort lock messages; sign-in never does. */
export async function flushPasswordLockEmails(): Promise<void> {
  while (pendingLockEmails.size > 0) await Promise.allSettled([...pendingLockEmails]);
}

// --- Sign-in --------------------------------------------------------------

export type PasswordSignInResult =
  | { ok: true; ownerId: string }
  | { ok: false; reason: "invalid_credentials" }
  | { ok: false; reason: "throttled"; retryAfterMs: number };

export async function signInWithPassword(
  emailInput: unknown,
  password: unknown,
  ip: string,
  now = Date.now()
): Promise<PasswordSignInResult> {
  const email = normalizeEmail(emailInput);
  const ipBucket = signInIpBucket(ip);
  const blockedFor = await throttleRetryAfter(ipBucket, now);
  if (blockedFor > 0) return { ok: false, reason: "throttled", retryAfterMs: blockedFor };

  // A malformed address still costs a decoy so it is not a free probe.
  if (!email || typeof password !== "string") {
    await decoyPasswordCheck(typeof password === "string" ? password : "");
    await bumpThrottle(ipBucket, SIGN_IN_IP_POLICY, now);
    return { ok: false, reason: "invalid_credentials" };
  }

  const credential = await credentialByEmail(email);
  if (!credential || !credential.verified_at) {
    await decoyPasswordCheck(password);
    await bumpThrottle(ipBucket, SIGN_IN_IP_POLICY, now);
    return { ok: false, reason: "invalid_credentials" };
  }

  // A locked account refuses even the right password until the lock expires or
  // the owner resets it. This is what makes the lock meaningful against guesses.
  if (credential.locked_until && credential.locked_until.getTime() > now) {
    await decoyPasswordCheck(password);
    await bumpThrottle(ipBucket, SIGN_IN_IP_POLICY, now);
    return { ok: false, reason: "invalid_credentials" };
  }

  const match = await verifyPassword(password, credentialHash(credential));
  if (!match) {
    await bumpThrottle(ipBucket, SIGN_IN_IP_POLICY, now);
    const lock = await recordCredentialFailure(credential.owner_id, now);
    if (lock) notifyAccountLocked(credential.owner_id, lock.lockedUntil);
    return { ok: false, reason: "invalid_credentials" };
  }

  await resetCredentialCounters(credential.owner_id);
  return { ok: true, ownerId: credential.owner_id };
}

// --- Sign-up --------------------------------------------------------------

export type PasswordSignUpResult =
  | { ok: true; ownerId: string }
  | { ok: false; reason: "invalid_code" | "invite_only" | "invalid_password" | "password_exists" | "email_taken" | "breached_password" };

/**
 * Create a credential for a mailbox the owner has just proved with the existing
 * email code. The code is consumed and the owner is found or created by
 * lib/authLinking.ts, so the #156 linking policy and the #195 invite gate decide
 * whether the address may belong to this owner. No credential is written before
 * that succeeds.
 */
export async function signUpWithPassword(
  emailInput: unknown,
  codeInput: unknown,
  passwordInput: unknown,
  now = Date.now()
): Promise<PasswordSignUpResult> {
  const email = normalizeEmail(emailInput);
  const problem = passwordProblem(passwordInput);
  if (problem) return { ok: false, reason: "invalid_password" };
  if (!email) return { ok: false, reason: "invalid_code" };
  const password = passwordInput as string;

  // Checked before the code is consumed, so a rejected password does not also
  // burn the owner's sign-up code. An unavailable lookup fails open.
  if (await checkPasswordBreach(password) === "breached") return { ok: false, reason: "breached_password" };

  const verified = await verifyEmailCode(email, String(codeInput ?? "").trim(), now);
  if (!verified.ok) return { ok: false, reason: verified.reason === "invite_only" ? "invite_only" : "invalid_code" };

  const created = await createPasswordCredential(verified.ownerId, email, password, now);
  if (!created.ok) return { ok: false, reason: created.reason };
  return { ok: true, ownerId: verified.ownerId };
}

// Used by sign-up and the dev seeder after the address is verified. Exported so
// the seeder can create its synthetic demo credential through the same hash path.
export async function createPasswordCredential(
  ownerId: string,
  emailInput: unknown,
  password: string,
  now = Date.now()
): Promise<{ ok: true } | { ok: false; reason: "password_exists" | "email_taken" }> {
  const email = normalizeEmail(emailInput);
  if (!email) throw new Error("A verified address is required for a password credential");
  if (passwordProblem(password)) throw new Error("A password credential must meet the length rules");
  const stored = await hashPassword(password);
  return transaction(async () => {
    // Serialize two sign-ups racing for one address so the unique index is a
    // backstop rather than the first thing that notices.
    await query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`password:${email}`]);
    const owner = (await query("SELECT id FROM auth_users WHERE id=$1 FOR UPDATE", [ownerId])).rows[0];
    if (!owner) throw new Error("Unknown owner for a password credential");
    const existing = (await query<{ owner_id: string; email: string }>(
      "SELECT owner_id,email FROM password_credentials WHERE owner_id=$1 OR lower(email)=$2 FOR UPDATE",
      [ownerId, email]
    )).rows;
    if (existing.some(row => row.owner_id === ownerId)) return { ok: false, reason: "password_exists" } as const;
    if (existing.length) return { ok: false, reason: "email_taken" } as const;
    await query(
      `INSERT INTO password_credentials(owner_id,email,password_hash,scrypt_n,scrypt_r,scrypt_p,salt,key_length,verified_at,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$9)`,
      [ownerId, email, stored.hash, stored.n, stored.r, stored.p, stored.salt, stored.keyLength, new Date(now)]
    );
    return { ok: true } as const;
  });
}

// --- Set a password while signed in (#286) --------------------------------

export type SetPasswordResult =
  | { ok: true }
  | { ok: false; reason: "no_verified_email" | "password_exists" | "email_taken" | "invalid_password" | "breached_password" };

/**
 * Add a password credential to an owner who signed in another way. The caller
 * has already passed a fresh step-up. The address must be one the sign-in
 * policy treats as verified, and it is fixed to the owner's primary verified
 * address so the credential cannot claim an address the owner does not hold.
 */
export async function setPasswordForOwner(
  ownerId: string,
  passwordInput: unknown,
  now = Date.now()
): Promise<SetPasswordResult> {
  const problem = passwordProblem(passwordInput);
  if (problem) return { ok: false, reason: "invalid_password" };
  if (await hasPassword(ownerId)) return { ok: false, reason: "password_exists" };
  const email = await primaryVerifiedOwnerEmail(ownerId);
  if (!email) return { ok: false, reason: "no_verified_email" };
  const password = passwordInput as string;
  if (await checkPasswordBreach(password) === "breached") return { ok: false, reason: "breached_password" };
  const created = await createPasswordCredential(ownerId, email, password, now);
  if (!created.ok) return { ok: false, reason: created.reason };
  return { ok: true };
}

// --- Password reset -------------------------------------------------------

export function passwordEmailConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!lockEmailUrl(env)) return false;
  try {
    getEmailTransport(env);
    return true;
  } catch {
    return false;
  }
}

function resetTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function resetLink(token: string, env: NodeJS.ProcessEnv = process.env) {
  const base = env.NEXTAUTH_URL?.trim().replace(/\/+$/, "");
  return `${base}/reset-password?token=${encodeURIComponent(token)}`;
}

export type PasswordResetRequestResult = "sent" | "invalid_email";

/**
 * Always answers the same for a real and an unknown address. Throttled requests
 * answer "sent" without sending, so they cannot be used to probe addresses.
 */
export async function requestPasswordReset(
  emailInput: unknown,
  ip: string,
  now = Date.now()
): Promise<PasswordResetRequestResult> {
  const email = normalizeEmail(emailInput);
  if (!email) return "invalid_email";
  const emailBucket = resetEmailBucket(email);
  const ipBucket = resetIpBucket(ip);
  if (await throttleRetryAfter(emailBucket, now) > 0) return "sent";
  if (await throttleRetryAfter(ipBucket, now) > 0) return "sent";
  await bumpThrottle(emailBucket, RESET_EMAIL_POLICY, now);
  await bumpThrottle(ipBucket, RESET_IP_POLICY, now);

  const credential = await credentialByEmail(email);
  if (!credential) {
    // Send a short no-account notice instead of returning early: a failed or
    // slower send for one branch would turn the route into an existence oracle.
    try {
      await sendEmail({ to: email, ...passwordResetNoAccountEmail() });
    } catch (error) {
      log.error("password_reset_email_failed", {
        reason: error instanceof EmailError ? error.code : "unexpected"
      });
    }
    return "sent";
  }

  const token = randomBytes(32).toString("base64url");
  await transaction(async () => {
    await query(
      `UPDATE password_reset_tokens SET superseded_at=$2
       WHERE owner_id=$1 AND consumed_at IS NULL AND superseded_at IS NULL`,
      [credential.owner_id, new Date(now)]
    );
    await query(
      `INSERT INTO password_reset_tokens(owner_id,token_hash,created_at,expires_at)
       VALUES($1,$2,$3,$4)`,
      [credential.owner_id, resetTokenHash(token), new Date(now), new Date(now + RESET_TOKEN_TTL_MS)]
    );
  });

  try {
    const template = passwordResetEmail(resetLink(token), { minutes: RESET_TOKEN_TTL_MS / 60000 });
    await sendEmail({ to: email, ...template });
  } catch (error) {
    // Sanitized: no address, token or message content.
    log.error("password_reset_email_failed", {
      reason: error instanceof EmailError ? error.code : "unexpected"
    });
  }
  return "sent";
}

export type PasswordResetResult =
  | { ok: true; ownerId: string }
  | { ok: false; reason: "invalid_token" | "invalid_password" | "breached_password" };

/**
 * Consume a reset token and replace the credential. Every web and phone session
 * for the owner is deleted: the owner asked to recover the account, so other
 * devices must prove themselves again. Returns no session of its own.
 */
export async function resetPassword(
  tokenInput: unknown,
  passwordInput: unknown,
  now = Date.now()
): Promise<PasswordResetResult> {
  const problem = passwordProblem(passwordInput);
  if (problem) return { ok: false, reason: "invalid_password" };
  const token = typeof tokenInput === "string" ? tokenInput.trim() : "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { ok: false, reason: "invalid_token" };
  const hash = resetTokenHash(token);

  // Check before paying for the hash, then lock and re-check inside the
  // transaction so a concurrent use of the same token cannot also succeed.
  const initial = (await query<{ expires_at: Date; consumed_at: Date | null; superseded_at: Date | null }>(
    "SELECT expires_at,consumed_at,superseded_at FROM password_reset_tokens WHERE token_hash=$1",
    [hash]
  )).rows[0];
  if (!initial || initial.consumed_at || initial.superseded_at || initial.expires_at.getTime() <= now) {
    return { ok: false, reason: "invalid_token" };
  }

  // A valid link is not consumed by a breached-password rejection: the owner
  // can choose another password within the token's lifetime. An unavailable
  // lookup fails open.
  if (await checkPasswordBreach(passwordInput as string) === "breached") {
    return { ok: false, reason: "breached_password" };
  }

  const stored = await hashPassword(passwordInput as string);
  return transaction(async () => {
    const row = (await query<{ id: string; owner_id: string; expires_at: Date; consumed_at: Date | null; superseded_at: Date | null }>(
      "SELECT id,owner_id,expires_at,consumed_at,superseded_at FROM password_reset_tokens WHERE token_hash=$1 FOR UPDATE",
      [hash]
    )).rows[0];
    if (!row || row.consumed_at || row.superseded_at || row.expires_at.getTime() <= now) {
      return { ok: false, reason: "invalid_token" } as const;
    }
    const credential = (await query<{ owner_id: string }>(
      "SELECT owner_id FROM password_credentials WHERE owner_id=$1 FOR UPDATE",
      [row.owner_id]
    )).rows[0];
    if (!credential) return { ok: false, reason: "invalid_token" } as const;

    await query(
      `UPDATE password_credentials
       SET password_hash=$2, scrypt_n=$3, scrypt_r=$4, scrypt_p=$5, salt=$6, key_length=$7,
           verified_at=coalesce(verified_at,$8), failed_attempts=0, failure_window_started_at=NULL,
           lock_count=0, locked_until=NULL, updated_at=$8
       WHERE owner_id=$1`,
      [row.owner_id, stored.hash, stored.n, stored.r, stored.p, stored.salt, stored.keyLength, new Date(now)]
    );
    await query("UPDATE password_reset_tokens SET consumed_at=$2 WHERE id=$1", [row.id, new Date(now)]);
    await query(
      `UPDATE password_reset_tokens SET superseded_at=$2
       WHERE owner_id=$1 AND consumed_at IS NULL AND superseded_at IS NULL`,
      [row.owner_id, new Date(now)]
    );
    await query("DELETE FROM auth_sessions WHERE owner_id=$1", [row.owner_id]);
    return { ok: true, ownerId: row.owner_id } as const;
  });
}

// --- Change password from a signed-in session ----------------------------

export type ChangePasswordResult =
  | { ok: true; revoked: number }
  | { ok: false; reason: "no_password" | "invalid_current" | "invalid_password" | "breached_password" };

export async function changePassword(
  ownerId: string,
  sessionToken: string,
  currentPasswordInput: unknown,
  newPasswordInput: unknown,
  now = Date.now()
): Promise<ChangePasswordResult> {
  const problem = passwordProblem(newPasswordInput);
  if (problem) return { ok: false, reason: "invalid_password" };
  const currentPassword = typeof currentPasswordInput === "string" ? currentPasswordInput : "";
  const credential = await credentialByOwner(ownerId);
  if (!credential) return { ok: false, reason: "no_password" };

  const match = await verifyPassword(currentPassword, credentialHash(credential));
  if (!match) {
    const lock = await recordCredentialFailure(ownerId, now);
    if (lock) notifyAccountLocked(ownerId, lock.lockedUntil);
    return { ok: false, reason: "invalid_current" };
  }

  // Checked after the current-password proof, before paying for a new hash.
  // Nothing is changed, so the owner can choose another password.
  if (await checkPasswordBreach(newPasswordInput as string) === "breached") {
    return { ok: false, reason: "breached_password" };
  }

  const stored = await hashPassword(newPasswordInput as string);
  return transaction(async () => {
    // If a reset (or another tab) changed the password between the check above
    // and now, do not overwrite it with a stale current-password proof.
    const current = (await query<CredentialRow>(
      "SELECT * FROM password_credentials WHERE owner_id=$1 FOR UPDATE",
      [ownerId]
    )).rows[0];
    if (!current || current.password_hash !== credential.password_hash || current.salt !== credential.salt
      || current.scrypt_n !== credential.scrypt_n || current.scrypt_r !== credential.scrypt_r || current.scrypt_p !== credential.scrypt_p) {
      return { ok: false, reason: "invalid_current" } as const;
    }
    await query(
      `UPDATE password_credentials
       SET password_hash=$2, scrypt_n=$3, scrypt_r=$4, scrypt_p=$5, salt=$6, key_length=$7,
           failed_attempts=0, failure_window_started_at=NULL, lock_count=0, locked_until=NULL, updated_at=$8
       WHERE owner_id=$1`,
      [ownerId, stored.hash, stored.n, stored.r, stored.p, stored.salt, stored.keyLength, new Date(now)]
    );
    // A reset link issued before this change must not undo it.
    await query(
      `UPDATE password_reset_tokens SET superseded_at=$2
       WHERE owner_id=$1 AND consumed_at IS NULL AND superseded_at IS NULL`,
      [ownerId, new Date(now)]
    );
    const revoked = (await query(
      "DELETE FROM auth_sessions WHERE owner_id=$1 AND token_hash<>$2",
      [ownerId, sessionHash(sessionToken)]
    )).rowCount ?? 0;
    return { ok: true, revoked } as const;
  });
}
