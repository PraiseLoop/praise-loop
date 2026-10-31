import { createHash, randomUUID } from "node:crypto";
import type { Adapter, AdapterUser, AdapterSession, AdapterAccount } from "next-auth/adapters";
import { query, transaction } from "./db";
export const sessionHash = (token: string) => createHash("sha256").update(token).digest("hex");
const user = async (sql: string, values: unknown[]) => (await query<AdapterUser>(sql, values)).rows[0] ?? null;

// NextAuth's built-in Microsoft provider id is `azure-ad`; auth_accounts stores
// the canonical `microsoft` name shared with the phone exchange and linking policy.
// The provider profile id is already `${tid}:${sub}`, so only the name differs.
const providerKey = (provider: string) => provider === "azure-ad" ? "microsoft" : provider;

export const authAdapter: Adapter = {
  createUser: async (u: Omit<AdapterUser, "id">) => (await user('INSERT INTO auth_users(id,name,email,"emailVerified",image) VALUES($1,$2,$3,$4,$5) RETURNING *', [randomUUID(), u.name, u.email, u.emailVerified, null]))!,
  getUser: id => user("SELECT * FROM auth_users WHERE id=$1", [id]),
  getUserByEmail: email => user("SELECT * FROM auth_users WHERE email=$1", [email]),
  getUserByAccount: a => user("SELECT u.* FROM auth_users u JOIN auth_accounts a ON a.owner_id=u.id WHERE a.provider=$1 AND a.provider_account_id=$2", [providerKey(a.provider), a.providerAccountId]),
  // A name the owner set (#149) outranks the provider's; a missing one is still filled at sign-in.
  updateUser: async u => (await user(`UPDATE auth_users SET name=CASE WHEN name_source='owner' THEN name ELSE coalesce($2,name) END,email=coalesce($3,email),"emailVerified"=coalesce($4,"emailVerified") WHERE id=$1 RETURNING *`, [u.id,u.name,u.email,u.emailVerified]))!,
  deleteUser: async id => { await query("DELETE FROM auth_users WHERE id=$1", [id]); },
  // Authentication requires only provider identity. Provider access/refresh tokens are discarded.
  // The policy checks live here as well as in lib/authLinking.ts so a future caller
  // cannot attach a second subject for one provider to the same owner.
  linkAccount: async (a: AdapterAccount) => {
    await transaction(async () => {
      await query("SELECT id FROM auth_users WHERE id=$1 FOR UPDATE", [a.userId]);
      const existing = (await query<{ provider_account_id: string }>("SELECT provider_account_id FROM auth_accounts WHERE owner_id=$1 AND provider=$2", [a.userId, providerKey(a.provider)])).rows;
      if (existing.some(row => row.provider_account_id !== a.providerAccountId)) throw new Error("Sign-in method already linked");
      await query(
        `INSERT INTO auth_accounts(provider,provider_account_id,owner_id,created_at,last_used_at)
         VALUES($1,$2,$3,now(),now()) ON CONFLICT(provider,provider_account_id) DO NOTHING`,
        [providerKey(a.provider), a.providerAccountId, a.userId]
      );
    });
  },
  unlinkAccount: async (a: AdapterAccount) => { await query("DELETE FROM auth_accounts WHERE provider=$1 AND provider_account_id=$2", [providerKey(a.provider), a.providerAccountId]); },
  createSession: async s => { await query("INSERT INTO auth_sessions(token_hash,owner_id,expires,kind) VALUES($1,$2,$3,'web')", [sessionHash(s.sessionToken),s.userId,s.expires]); return s; },
  getSessionAndUser: async token => {
    const row = (await query<{ owner_id: string; expires: Date }>("SELECT owner_id,expires FROM auth_sessions WHERE token_hash=$1 AND expires>now()", [sessionHash(token)])).rows[0];
    if (!row) return null;
    const u = await user("SELECT * FROM auth_users WHERE id=$1", [row.owner_id]);
    return u ? { user: u, session: { sessionToken: token, userId: u.id, expires: row.expires } } : null;
  },
  updateSession: async s => {
    const row = (await query<{ owner_id: string; expires: Date }>("UPDATE auth_sessions SET expires=coalesce($2,expires) WHERE token_hash=$1 RETURNING owner_id,expires", [sessionHash(s.sessionToken),s.expires])).rows[0];
    return row ? { sessionToken: s.sessionToken, userId: row.owner_id, expires: row.expires } as AdapterSession : null;
  },
  deleteSession: async token => { await query("DELETE FROM auth_sessions WHERE token_hash=$1", [sessionHash(token)]); }
};
