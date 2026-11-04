import { query } from "../db";
import { entitlementsFor, setOwnerPlan, type Entitlements } from "./entitlements";

// Self-service pilot upgrades: an owner whose verified email is listed in
// SELF_SERVICE_UPGRADE_EMAILS may move themselves to Pro from the plan page.
// An empty or missing list allows nobody, so a deployment that does not opt in
// keeps plan changes operator-only.
export const SELF_SERVICE_UPGRADE_ENV = "SELF_SERVICE_UPGRADE_EMAILS";

export type SelfServiceUpgradeStatus = {
  eligible: boolean;
  entitlements: Entitlements;
  email: string | null;
};

/** Splits the comma-separated allowlist, ignoring spaces, blanks and case. */
export function selfServiceUpgradeEmails(raw = process.env[SELF_SERVICE_UPGRADE_ENV]): string[] {
  return (raw ?? "")
    .split(/[,\s]+/)
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
}

export function isSelfServiceUpgradeEmail(email: string | null | undefined, raw = process.env[SELF_SERVICE_UPGRADE_ENV]): boolean {
  const normalized = email?.trim().toLowerCase();
  return !!normalized && selfServiceUpgradeEmails(raw).includes(normalized);
}

async function ownerEmail(ownerId: string): Promise<string | null> {
  return (await query<{ email: string | null }>("SELECT email FROM auth_users WHERE id=$1", [ownerId])).rows[0]?.email ?? null;
}

export async function selfServiceUpgradeStatus(ownerId: string): Promise<SelfServiceUpgradeStatus> {
  const [email, entitlements] = await Promise.all([ownerEmail(ownerId), entitlementsFor(ownerId)]);
  return { eligible: isSelfServiceUpgradeEmail(email), entitlements, email };
}

/**
 * Upgrades an allowlisted owner to an open-ended manual Pro plan. Returns the
 * status either way; callers must check `eligible` before treating it as done.
 * Repeating the request is harmless and does not append another audit event.
 */
export async function selfServiceUpgrade(ownerId: string): Promise<SelfServiceUpgradeStatus & { changed: boolean }> {
  const status = await selfServiceUpgradeStatus(ownerId);
  if (!status.eligible || status.entitlements.plan !== "free") return { ...status, changed: false };
  const entitlements = await setOwnerPlan(ownerId, "pro", {
    actor: status.email ?? "owner",
    reason: "Self-service pilot upgrade"
  });
  return { ...status, entitlements, changed: true };
}
