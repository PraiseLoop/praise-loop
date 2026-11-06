import { ApiError } from "../api/client";

// The pilot's invite-only gate (#195). The API returns `invite_only` for a new
// sign-up that is not on the invite list; the screen shows the same words as the web.
export const INVITE_ONLY_MESSAGE = "PraiseLoop is invite-only right now. Ask us for an invite.";

export function isInviteOnly(error: unknown): boolean {
  return error instanceof ApiError && error.code === "invite_only";
}
