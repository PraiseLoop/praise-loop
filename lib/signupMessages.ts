// The one refusal message for the pilot's invite-only gate. Kept separate from
// lib/signupPolicy.ts so client components can import it without pulling node:crypto
// into the browser bundle.
export const INVITE_ONLY_MESSAGE = "PraiseLoop is invite-only right now. Ask us for an invite.";
