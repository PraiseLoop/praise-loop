import { randomBytes, timingSafeEqual } from "node:crypto";
import { query } from "./db";
import { sessionHash } from "./auth-adapter";
import { notifyNewSignIn } from "./signInAlerts";

export const MOBILE_SESSION_IDLE_DAYS = 30;
export const MOBILE_SESSION_ABSOLUTE_DAYS = 90;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function tokensMatch(a: string, b: string) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export type NewMobileSignIn = { method: string; userAgent?: string | null };

// Returns the raw token once; only its SHA-256 hash is stored. This is the one
// place every phone sign-in method creates a bearer session, so the alert hook
// covers Google, Microsoft, Apple, email code and dev sign-in exactly once.
export async function createMobileSession(ownerId: string, signIn?: NewMobileSignIn) {
  const token = randomBytes(32).toString("base64url");
  const row = (await query<{ expires: Date }>(
    `INSERT INTO auth_sessions(token_hash, owner_id, expires, kind)
     VALUES($1, $2, now() + ($3 || ' days')::interval, 'mobile')
     RETURNING expires`,
    [sessionHash(token), ownerId, String(MOBILE_SESSION_IDLE_DAYS)]
  )).rows[0];
  if (signIn) notifyNewSignIn({ ownerId, client: "mobile", ...signIn });
  return { token, expires: row.expires };
}

// Sliding expiry, capped at 90 days after creation. Malformed tokens never reach
// the database and every lookup is a constant-shape hash comparison. Refreshing
// an existing session never sends a new-sign-in alert.
export async function resolveMobileSession(token: string) {
  if (!TOKEN_PATTERN.test(token)) return null;
  const hash = sessionHash(token);
  const row = (await query<{ token_hash: string; owner_id: string }>(
    `UPDATE auth_sessions
     SET expires = LEAST(now() + ($2 || ' days')::interval,
                         created_at + ($3 || ' days')::interval),
         last_seen_at = now()
     WHERE token_hash = $1
       AND kind = 'mobile'
       AND expires > now()
       AND created_at > now() - ($3 || ' days')::interval
     RETURNING token_hash, owner_id`,
    [hash, String(MOBILE_SESSION_IDLE_DAYS), String(MOBILE_SESSION_ABSOLUTE_DAYS)]
  )).rows[0];
  if (!row || !tokensMatch(row.token_hash, hash)) return null;
  return { ownerId: row.owner_id, token };
}

export async function revokeSession(token: string) {
  if (token.length === 0 || token.length > 512) return false;
  return !!(await query("DELETE FROM auth_sessions WHERE token_hash = $1", [sessionHash(token)])).rowCount;
}
