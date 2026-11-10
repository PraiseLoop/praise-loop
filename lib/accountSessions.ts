import { sessionHash } from "./auth-adapter";
import { query } from "./db";

// Sign out of all other devices (#285). Every web and phone session belongs to
// one owner in auth_sessions, so one delete covers both kinds. The current
// session's token is hashed here and compared in SQL; the raw token never
// reaches a log line or the response.
export async function revokeOtherSessions(ownerId: string, currentToken: string): Promise<number> {
  const result = await query(
    "DELETE FROM auth_sessions WHERE owner_id=$1 AND token_hash<>$2",
    [ownerId, sessionHash(currentToken)]
  );
  return result.rowCount ?? 0;
}
