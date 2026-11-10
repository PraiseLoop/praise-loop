import { query } from "./db";

// Addresses that the sign-in policy already treated as verified: the owner row's
// address, Google/email methods and a password credential's verified address.
// Apple's address is verified by Apple even when it is a private relay. Microsoft's
// address is deliberately excluded because it is not guaranteed to belong to the
// account holder. One helper so sign-in alerts (#260) and the weekly ready email
// (#275) never disagree about who is reachable.

const VERIFIED_SQL = `
  SELECT email FROM (
    SELECT DISTINCT ON (lower(email)) lower(email) AS email, priority
    FROM (
      SELECT email, 0 AS priority
      FROM auth_users
      WHERE id=$1 AND email IS NOT NULL AND "emailVerified" IS NOT NULL
      UNION ALL
      SELECT email,
             CASE provider WHEN 'google' THEN 1 WHEN 'email' THEN 2 WHEN 'apple' THEN 3 ELSE 4 END AS priority
      FROM auth_accounts
      WHERE owner_id=$1 AND email IS NOT NULL AND provider IN ('google','email','apple')
      UNION ALL
      SELECT email, 4 AS priority
      FROM password_credentials
      WHERE owner_id=$1 AND verified_at IS NOT NULL
    ) known
    WHERE email <> '' AND length(email) <= 254
    ORDER BY lower(email), priority
  ) unique_emails
  ORDER BY priority, email`;

/** Every verified address for an owner, owner-row address first. Lower-cased and de-duplicated. */
export async function verifiedOwnerEmails(ownerId: string): Promise<string[]> {
  return (await query<{ email: string }>(VERIFIED_SQL, [ownerId])).rows.map(row => row.email);
}

/** The one address a weekly notice goes to, or null when the owner has no verified address. */
export async function primaryVerifiedOwnerEmail(ownerId: string): Promise<string | null> {
  return (await verifiedOwnerEmails(ownerId))[0] ?? null;
}
