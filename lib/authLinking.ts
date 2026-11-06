import { randomUUID } from "node:crypto";
import { query, transaction } from "./db";
import { fillProviderName } from "./services/profile";
import { logRefusedSignup, newOwnerAllowed } from "./signupPolicy";

// The one place that decides whether a sign-in method belongs to an owner (#156).
// A method is identified by the provider plus its stable subject id, never by the
// email by itself. The email can only be used to find an *existing* owner when the
// provider guarantees that the address is verified (Google, our own email codes).
// Apple never links by email (#92): its address can be a private relay, and linking
// accounts is a separate decision. A signed-in owner may always attach another
// method because they have proved control of the existing session.
export const TRUSTED_EMAIL_PROVIDERS = new Set(["google", "email"]);

export type AuthIdentity = {
  provider: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name?: string | null;
};

export type AuthMethod = {
  provider: string;
  email: string | null;
  addedAt: string | null;
  lastUsedAt: string | null;
};

export type LinkFailure = "invalid_identity" | "provider_already_linked" | "account_taken" | "unknown_owner" | "last_method" | "not_found";
// `invite_only` is only a sign-in refusal: attaching a method to a live owner and
// an existing identity can never produce it (#195).
export type SignInFailure = LinkFailure | "invite_only";
export type LinkResult = { ok: true; methods: AuthMethod[] } | { ok: false; reason: LinkFailure };
export type SignInResult = { ok: true; ownerId: string } | { ok: false; reason: SignInFailure };

const PROVIDER = /^[a-z][a-z0-9_-]{0,39}$/;

function normalizeIdentity(identity: AuthIdentity): AuthIdentity | null {
  const email = identity.email?.trim().toLowerCase() || null;
  const subject = identity.subject.trim();
  if (!PROVIDER.test(identity.provider) || !subject || subject.length > 512 || (email && email.length > 320)) return null;
  return { ...identity, subject, email, name: identity.name?.trim() || null };
}

function trustedEmail(identity: AuthIdentity) {
  return identity.emailVerified && !!identity.email && TRUSTED_EMAIL_PROVIDERS.has(identity.provider);
}

async function lockOwner(ownerId: string) {
  return (await query<{ id: string }>("SELECT id FROM auth_users WHERE id=$1 FOR UPDATE", [ownerId])).rows[0]?.id ?? null;
}

// A name the owner already has, or one they set themselves (#149), is never replaced by a provider.
async function fillName(ownerId: string, name: string | null | undefined) {
  await fillProviderName(ownerId, name);
}

async function touchAccount(provider: string, subject: string, email: string | null) {
  await query(
    "UPDATE auth_accounts SET last_used_at=now(), email=coalesce($3,email) WHERE provider=$1 AND provider_account_id=$2",
    [provider, subject, email]
  );
}

async function accountOwner(provider: string, subject: string) {
  return (await query<{ owner_id: string }>(
    "SELECT owner_id FROM auth_accounts WHERE provider=$1 AND provider_account_id=$2",
    [provider, subject]
  )).rows[0]?.owner_id ?? null;
}

// True when this owner already has a different subject for the same provider.
async function hasOtherSubject(ownerId: string, provider: string, subject: string) {
  return (await query<{ provider_account_id: string }>(
    "SELECT provider_account_id FROM auth_accounts WHERE owner_id=$1 AND provider=$2",
    [ownerId, provider]
  )).rows.some(row => row.provider_account_id !== subject);
}

async function attachAccount(provider: string, subject: string, ownerId: string, email: string | null) {
  const inserted = (await query<{ owner_id: string }>(
    `INSERT INTO auth_accounts(provider,provider_account_id,owner_id,email,created_at,last_used_at)
     VALUES($1,$2,$3,$4,now(),now())
     ON CONFLICT(provider,provider_account_id) DO NOTHING
     RETURNING owner_id`,
    [provider, subject, ownerId, email]
  )).rows[0]?.owner_id;
  return inserted ?? accountOwner(provider, subject);
}

// A freshly created owner is removed again when a concurrent request won the
// same subject. It can have no data yet, so this loses nothing.
async function removeOrphan(ownerId: string) {
  await query(
    `DELETE FROM auth_users u
     WHERE u.id=$1
       AND NOT EXISTS (SELECT 1 FROM auth_accounts a WHERE a.owner_id=u.id)`,
    [ownerId]
  );
}

export async function listMethods(ownerId: string): Promise<AuthMethod[]> {
  const rows = (await query<{ provider: string; email: string | null; created_at: Date | null; last_used_at: Date | null }>(
    `SELECT provider,email,created_at,last_used_at
     FROM auth_accounts WHERE owner_id=$1
     ORDER BY created_at NULLS LAST, provider`,
    [ownerId]
  )).rows;
  return rows.map(row => ({
    provider: row.provider,
    email: row.email,
    addedAt: row.created_at?.toISOString() ?? null,
    lastUsedAt: row.last_used_at?.toISOString() ?? null
  }));
}

// Sign-in for every provider. `linkToOwner` is set only when the browser or app
// already has a valid session, in which case the new method is attached to that
// owner instead of finding or creating another one.
export async function signInWithIdentity(identity: AuthIdentity, options: { linkToOwner?: string } = {}): Promise<SignInResult> {
  const input = normalizeIdentity(identity);
  if (!input) return { ok: false, reason: "invalid_identity" };

  return transaction(async () => {
    const existing = await accountOwner(input.provider, input.subject);
    if (existing) {
      // The subject is already the identity, but a signed-in owner cannot take
      // over a method that belongs to another owner.
      if (options.linkToOwner && existing !== options.linkToOwner) return { ok: false, reason: "account_taken" };
      await touchAccount(input.provider, input.subject, input.email);
      await fillName(existing, input.name);
      return { ok: true, ownerId: existing };
    }

    if (options.linkToOwner) {
      const owner = await lockOwner(options.linkToOwner);
      if (!owner) return { ok: false, reason: "unknown_owner" };
      if (await hasOtherSubject(owner, input.provider, input.subject)) return { ok: false, reason: "provider_already_linked" };
      const attached = await attachAccount(input.provider, input.subject, owner, input.email);
      if (!attached || attached !== owner) return { ok: false, reason: "account_taken" };
      await fillName(owner, input.name);
      return { ok: true, ownerId: owner };
    }

    if (trustedEmail(input)) {
      // Upserting on email locks an existing owner row until commit, so two
      // subjects racing for one address are serialized (the fix from #117).
      const owner = (await query<{ id: string; inserted: boolean }>(
        `INSERT INTO auth_users(id,name,email,"emailVerified") VALUES($1,$2,$3,now())
         ON CONFLICT(email) DO UPDATE SET email=auth_users.email
         RETURNING id, (xmax=0) AS inserted`,
        [randomUUID(), input.name, input.email]
      )).rows[0];
      // A brand-new owner is refused before any method is attached. The upsert is
      // what serializes two subjects racing for one address, so the decision uses
      // its `inserted` flag, not a separate read. An existing owner (inserted =
      // false) always signs in, invited or not. Deleting the row this transaction
      // just created leaves nothing behind when the access check refuses (#195).
      if (owner.inserted && !newOwnerAllowed(input)) {
        await query("DELETE FROM auth_users WHERE id=$1", [owner.id]);
        logRefusedSignup(input);
        return { ok: false, reason: "invite_only" };
      }
      if (await hasOtherSubject(owner.id, input.provider, input.subject)) return { ok: false, reason: "provider_already_linked" };
      const attached = await attachAccount(input.provider, input.subject, owner.id, input.email);
      if (!attached) return { ok: false, reason: "account_taken" };
      if (attached !== owner.id) {
        // Another request linked this same subject to a different owner first.
        if (owner.inserted) await removeOrphan(owner.id);
        await touchAccount(input.provider, input.subject, input.email);
        await fillName(attached, input.name);
        return { ok: true, ownerId: attached };
      }
      await fillName(owner.id, input.name);
      return { ok: true, ownerId: owner.id };
    }

    // A provider whose email claim is not verified (or is not guaranteed by the
    // provider, such as Microsoft's) never links by email. It gets its own owner
    // with no login email; the provider address is kept only on the method row.
    // The invite gate still checks the address the provider reported (#195).
    if (!newOwnerAllowed(input)) {
      logRefusedSignup(input);
      return { ok: false, reason: "invite_only" };
    }
    const owner = (await query<{ id: string }>(
      `INSERT INTO auth_users(id,name,email,"emailVerified") VALUES($1,$2,NULL,NULL) RETURNING id`,
      [randomUUID(), input.name]
    )).rows[0].id;
    const attached = await attachAccount(input.provider, input.subject, owner, input.email);
    if (!attached || attached !== owner) {
      await removeOrphan(owner);
      if (!attached) return { ok: false, reason: "account_taken" };
      await touchAccount(input.provider, input.subject, input.email);
      await fillName(attached, input.name);
      return { ok: true, ownerId: attached };
    }
    await fillName(owner, input.name);
    return { ok: true, ownerId: owner };
  });
}

// Link a verified method from an already signed-in session. The session proves
// control of the owner, so the method's email does not need to match the
// owner's email; it only must not already belong to somebody else.
export async function linkIdentityToOwner(ownerId: string, identity: AuthIdentity): Promise<LinkResult> {
  const input = normalizeIdentity(identity);
  if (!input) return { ok: false, reason: "invalid_identity" };

  return transaction(async () => {
    const owner = await lockOwner(ownerId);
    if (!owner) return { ok: false, reason: "unknown_owner" };
    const existing = await accountOwner(input.provider, input.subject);
    if (existing) {
      if (existing !== owner) return { ok: false, reason: "account_taken" };
      await touchAccount(input.provider, input.subject, input.email);
      await fillName(owner, input.name);
      return { ok: true, methods: await listMethods(owner) };
    }
    if (await hasOtherSubject(owner, input.provider, input.subject)) return { ok: false, reason: "provider_already_linked" };
    const attached = await attachAccount(input.provider, input.subject, owner, input.email);
    if (!attached || attached !== owner) return { ok: false, reason: "account_taken" };
    await fillName(owner, input.name);
    return { ok: true, methods: await listMethods(owner) };
  });
}

// Remove one provider from the owner. The last method is refused: otherwise the
// owner would have no way to sign in and only an operator could recover the row.
export async function unlinkMethod(ownerId: string, provider: string): Promise<LinkResult> {
  if (!PROVIDER.test(provider)) return { ok: false, reason: "not_found" };

  return transaction(async () => {
    const owner = await lockOwner(ownerId);
    if (!owner) return { ok: false, reason: "unknown_owner" };
    const rows = (await query<{ provider: string }>("SELECT provider FROM auth_accounts WHERE owner_id=$1", [owner])).rows;
    const matching = rows.filter(row => row.provider === provider).length;
    if (!matching) return { ok: false, reason: "not_found" };
    if (rows.length - matching < 1) return { ok: false, reason: "last_method" };
    await query("DELETE FROM auth_accounts WHERE owner_id=$1 AND provider=$2", [owner, provider]);
    return { ok: true, methods: await listMethods(owner) };
  });
}
