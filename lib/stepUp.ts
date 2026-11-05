import { NextResponse } from "next/server";
import { sessionHash } from "./auth-adapter";
import { currentSession } from "./authorization";
import { query } from "./db";
import { requestEmailCode, verifyStepUpCode } from "./emailAuth";

// Fresh-code check for sensitive steps (#221). An email code sign-in can reach an
// existing Google owner, so before billing or plan changes we ask for a code sent
// to the address already on the owner, even though the session is valid. This is
// a pause before a sensitive step, not strong protection: whoever holds the
// mailbox can receive the same code.
export const STEP_UP_TTL_MS = 10 * 60 * 1000;

export type StepUpSession = { owner: string; kind: "web" | "mobile"; token: string };

type StepUpState = { email: string | null; created_at: Date; step_up_at: Date | null };

function reply(status: number, body: object) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

// The address comes only from the owner row, never from the caller. New sessions
// start with no step_up_at, and deleting the session (sign-out) deletes it too.
async function stepUpState(session: StepUpSession): Promise<StepUpState | null> {
  return (await query<StepUpState>(
    `SELECT u.email, s.created_at, s.step_up_at
     FROM auth_sessions s JOIN auth_users u ON u.id = s.owner_id
     WHERE s.token_hash = $1 AND s.owner_id = $2`,
    [sessionHash(session.token), session.owner]
  )).rows[0] ?? null;
}

function sessionIsRecent(state: StepUpState, now: number) {
  return state.created_at.getTime() > now - STEP_UP_TTL_MS;
}

// One line in a route:
//   const denied = await requireRecentStepUp(); if (denied) return denied;
// Email owners need a step-up on this exact session within the last ten minutes.
// Owners with no address (Apple, Microsoft) cannot receive a code, so they pass
// only while the session itself is under ten minutes old; otherwise sign in again.
export async function requireRecentStepUp(session: StepUpSession | null = currentSession()): Promise<Response | null> {
  if (!session) return reply(401, { error: "Sign in to continue" });
  const state = await stepUpState(session);
  if (!state) return reply(401, { error: "Sign in to continue" });
  if (state.email) {
    const fresh = state.step_up_at !== null && state.step_up_at.getTime() > Date.now() - STEP_UP_TTL_MS;
    return fresh ? null : reply(403, { error: "step_up_required" });
  }
  return sessionIsRecent(state, Date.now()) ? null : reply(403, { error: "sign_in_again" });
}

export type StepUpRequestResult = "sent" | "throttled" | "recent_sign_in" | "sign_in_again";

// Throws EmailSignInNotConfiguredError when the email transport or secret is
// missing, so the route can answer 503 like sign-in does.
export async function requestStepUp(session: StepUpSession, ip: string, now = Date.now()): Promise<StepUpRequestResult> {
  const state = await stepUpState(session);
  if (!state) return "sign_in_again";
  if (!state.email) return sessionIsRecent(state, now) ? "recent_sign_in" : "sign_in_again";
  // Reuses the sign-in generator, hashing, expiry, attempt limits and throttles.
  return requestEmailCode(state.email, ip, now, "step_up");
}

export type StepUpVerifyResult = "verified" | "invalid" | "sign_in_again" | "session_missing";

export async function verifyStepUp(session: StepUpSession, code: string, now = Date.now()): Promise<StepUpVerifyResult> {
  const state = await stepUpState(session);
  if (!state) return "session_missing";
  if (!state.email) return "sign_in_again";
  if (!await verifyStepUpCode(state.email, code, now)) return "invalid";
  // Only this session is marked. A code is single use, and another open session
  // of the same owner stays without a step-up.
  const marked = await query(
    "UPDATE auth_sessions SET step_up_at=$3 WHERE token_hash=$1 AND owner_id=$2",
    [sessionHash(session.token), session.owner, new Date(now)]
  );
  return marked.rowCount ? "verified" : "session_missing";
}
