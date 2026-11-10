import { query } from "../db";

// Owner-level email preferences (#275). The weekly ready email is on by default;
// the account page exposes this one switch and the email itself links back to it.
export type EmailPreferences = { weeklyEmailEnabled: boolean };

export async function emailPreferencesFor(ownerId: string): Promise<EmailPreferences> {
  const row = (await query<{ weekly_email_enabled: boolean }>(
    "SELECT weekly_email_enabled FROM auth_users WHERE id=$1",
    [ownerId]
  )).rows[0];
  if (!row) throw new Error("Owner not found");
  return { weeklyEmailEnabled: row.weekly_email_enabled };
}

export async function setWeeklyEmailEnabled(ownerId: string, input: unknown): Promise<EmailPreferences | { error: string }> {
  if (typeof input !== "boolean") return { error: "Choose whether to send the weekly email" };
  const updated = await query("UPDATE auth_users SET weekly_email_enabled=$2 WHERE id=$1", [ownerId, input]);
  if (!updated.rowCount) throw new Error("Owner not found");
  return { weeklyEmailEnabled: input };
}
