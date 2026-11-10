import { createHash, randomBytes } from "node:crypto";
import { query, transaction } from "../db";
import {
  metaAuthorizeUrl,
  metaGraphClient,
  metaGraphConfig,
  MetaGraphError,
  type MetaPageAccount
} from "../integrations/metaGraph";
import { decryptCredential, encryptCredential, loadKey } from "../integrations/credentials";
import { log } from "../log";
import { entitlementsFor } from "./entitlements";

// Direct Meta connect (#234): Facebook Login for Business, a single-use state
// bound to the signed-in owner, and the long-lived Page tokens the callback
// receives. The long-lived User token is used only during the callback and is
// never stored. Publishing is not wired to the worker in this slice.
const STATE_TTL_MS = 10 * 60 * 1000;

type Deps = { fetchImpl?: typeof fetch; now?: () => number };
type Env = Record<string, string | undefined>;

export type MetaOutcome = "connected" | "no_pages" | "denied" | "expired" | "failed" | "not_configured" | "plan_required";
export type MetaTargetKind = "instagram" | "facebook";
export type MetaErrorCode =
  | "not_configured"
  | "plan_required"
  | "expired"
  | "failed"
  | "not_connected"
  | "needs_reconnect"
  | "not_found"
  | "invalid_target"
  | "instagram_unavailable"
  | "page_cannot_publish";

export class MetaConnectionError extends Error {
  constructor(readonly code: MetaErrorCode, readonly status = 400) {
    super(code);
    this.name = "MetaConnectionError";
  }
}

export type MetaPageView = {
  /** Local key used by a business and by the connect screen. */
  id: number;
  pageId: string;
  name: string;
  instagramBusinessAccountId: string | null;
  tasks: string[];
  status: "active" | "needs_reconnect";
};

export type MetaConnectionView = {
  configured: boolean;
  connected: boolean;
  status: "active" | "needs_reconnect" | null;
  pages: MetaPageView[];
};

export type MetaSelectedTarget = { target: MetaTargetKind; page: MetaPageView };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const pageAad = (ownerId: string, pageId: string) => `meta:page:${ownerId}:${pageId}`;

// The connect routes fail closed when the app credentials, redirect base or
// encryption key are missing. Never expose which one in the error.
function config(env: Env = process.env): ReturnType<typeof metaGraphConfig> {
  try { loadKey(env.CREDENTIAL_ENCRYPTION_KEY); } catch { return null; }
  return metaGraphConfig(env);
}

export function metaConfigured(env: Env = process.env): boolean {
  return config(env) !== null;
}

function connectFailed(step: string, error?: unknown) {
  const fields: Record<string, unknown> = { step };
  if (error instanceof MetaGraphError) {
    fields.httpStatus = error.status;
    fields.metaCode = error.code;
  }
  // Only the step, HTTP status and a short Graph code; never a token, code, state or URL.
  log.warn("meta_connect_failed", fields);
}

async function requireAutomaticPosting(ownerId: string): Promise<void> {
  if (!(await entitlementsFor(ownerId)).limits.automaticPosting) {
    throw new MetaConnectionError("plan_required", 403);
  }
}

/** Create the single-use state and return the Facebook Login URL. */
export async function startMetaConnect(ownerId: string, deps: Deps = {}): Promise<string> {
  const cfg = config();
  if (!cfg) throw new MetaConnectionError("not_configured", 503);
  await requireAutomaticPosting(ownerId);

  const now = (deps.now ?? Date.now)();
  await query("DELETE FROM meta_oauth_states WHERE expires_at <= now()");
  const state = randomBytes(32).toString("base64url");
  await query(
    "INSERT INTO meta_oauth_states(state_hash,owner_id,expires_at) VALUES($1,$2,$3)",
    [sha256(state), ownerId, new Date(now + STATE_TTL_MS)]
  );
  return metaAuthorizeUrl(cfg, state);
}

/**
 * Consume the state once, exchange the code for a long-lived User token, read the
 * owner's Pages and store their encrypted Page tokens. `ownerId` binds completion
 * to the browser's session; a different owner consumes nothing.
 */
export async function completeMetaConnect(
  input: { state?: unknown; code?: unknown; ownerId?: string },
  deps: Deps = {}
): Promise<{ ownerId: string; outcome: "connected" | "no_pages"; pages: number }> {
  const cfg = config();
  if (!cfg) throw new MetaConnectionError("not_configured", 503);

  const state = typeof input.state === "string" ? input.state : "";
  const code = typeof input.code === "string" ? input.code : "";
  const ownerId = typeof input.ownerId === "string" ? input.ownerId : "";
  // Completion is always bound to the browser's owner. Without it, a state alone
  // could attach an account to whoever presented the callback URL.
  if (!state || !code || !ownerId) {
    connectFailed("missing_state_code_or_owner");
    throw new MetaConnectionError("failed", 400);
  }

  const consumed = await query<{ owner_id: string }>(
    `DELETE FROM meta_oauth_states
     WHERE state_hash=$1 AND expires_at > now() AND owner_id=$2
     RETURNING owner_id`,
    [sha256(state), ownerId]
  );
  const row = consumed.rows[0];
  if (!row) {
    connectFailed("state_unknown_expired_or_other_owner");
    throw new MetaConnectionError("expired", 400);
  }
  await requireAutomaticPosting(row.owner_id);

  const client = metaGraphClient({ config: cfg, fetchImpl: deps.fetchImpl });
  let accounts: MetaPageAccount[];
  try {
    const shortLived = await client.exchangeCode(code);
    const longLived = await client.exchangeLongLived(shortLived);
    accounts = await client.listAccounts(longLived);
  } catch (error) {
    connectFailed("provider_exchange", error);
    throw new MetaConnectionError("failed", 502);
  }

  if (!accounts.length) {
    // Leave any previous connection untouched: an empty list can also mean the
    // owner declined pages_show_list, and silently deleting a working connection
    // would be worse than asking them to try again.
    log.info("meta_connect_no_pages");
    return { ownerId: row.owner_id, outcome: "no_pages", pages: 0 };
  }

  await transaction(async () => {
    const connection = (await query<{ id: string }>(
      `INSERT INTO meta_connections(owner_id,status) VALUES($1,'active')
       ON CONFLICT(owner_id) DO UPDATE SET status='active', updated_at=now()
       RETURNING id`,
      [row.owner_id]
    )).rows[0];
    const connectionId = connection.id;

    // A reconnect removes Pages the user no longer manages. The foreign key
    // cascades those Page's business selections away with them.
    await query(
      "DELETE FROM meta_pages WHERE connection_id=$1 AND NOT (page_id = ANY($2::text[]))",
      [connectionId, accounts.map(account => account.pageId)]
    );

    for (const account of accounts) {
      // If the Page's linked Instagram account changed, an existing Instagram
      // target would silently start publishing to a different account. Drop it.
      await query(
        `DELETE FROM business_meta_targets t
         USING meta_pages p
         WHERE t.meta_page_id=p.id AND p.connection_id=$1 AND p.page_id=$2
           AND t.target='instagram'
           AND $3::text IS DISTINCT FROM p.instagram_business_account_id`,
        [connectionId, account.pageId, account.instagramBusinessAccountId]
      );
      await query(
        `INSERT INTO meta_pages(connection_id,page_id,name,encrypted_page_token,instagram_business_account_id,tasks,status)
         VALUES($1,$2,$3,$4,$5,$6,'active')
         ON CONFLICT(connection_id,page_id) DO UPDATE SET
           name=EXCLUDED.name,
           encrypted_page_token=EXCLUDED.encrypted_page_token,
           instagram_business_account_id=EXCLUDED.instagram_business_account_id,
           tasks=EXCLUDED.tasks,
           status='active',
           updated_at=now()`,
        [
          connectionId,
          account.pageId,
          account.name,
          encryptCredential(account.accessToken, pageAad(row.owner_id, account.pageId)),
          account.instagramBusinessAccountId,
          account.tasks
        ]
      );
    }
  });

  log.info("meta_connected", { pages: accounts.length });
  return { ownerId: row.owner_id, outcome: "connected", pages: accounts.length };
}

/** The owner's connection and Pages without any token. */
export async function getMetaConnection(ownerId: string): Promise<MetaConnectionView> {
  const configured = metaConfigured();
  if (!configured) return { configured: false, connected: false, status: null, pages: [] };
  const connection = (await query<{ id: string; status: "active" | "needs_reconnect" }>(
    "SELECT id,status FROM meta_connections WHERE owner_id=$1",
    [ownerId]
  )).rows[0];
  if (!connection) return { configured: true, connected: false, status: null, pages: [] };
  const pages = (await query<{
    id: string;
    page_id: string;
    name: string;
    instagram_business_account_id: string | null;
    tasks: string[];
    status: "active" | "needs_reconnect";
  }>(
    `SELECT id,page_id,name,instagram_business_account_id,tasks,status
     FROM meta_pages WHERE connection_id=$1 ORDER BY name, page_id`,
    [connection.id]
  )).rows;
  return {
    configured: true,
    connected: true,
    status: connection.status,
    pages: pages.map(page => ({
      id: Number(page.id),
      pageId: page.page_id,
      name: page.name,
      instagramBusinessAccountId: page.instagram_business_account_id,
      tasks: page.tasks ?? [],
      status: page.status
    }))
  };
}

/** The decrypted Page token for the publish slice; never returned by a view. */
export async function getMetaPageCredentials(ownerId: string, metaPageId: number): Promise<{
  pageId: string;
  name: string;
  accessToken: string;
  /**
   * The stored ciphertext for `accessToken`. Opaque to callers; the worker keeps
   * it so a later auth failure can be attributed to the token that actually failed.
   */
  encryptedPageToken: string;
  instagramBusinessAccountId: string | null;
  tasks: string[];
}> {
  if (!Number.isSafeInteger(metaPageId) || metaPageId <= 0) throw new MetaConnectionError("not_found", 404);
  const row = (await query<{
    page_id: string;
    name: string;
    encrypted_page_token: string;
    instagram_business_account_id: string | null;
    tasks: string[];
    page_status: "active" | "needs_reconnect";
    connection_status: "active" | "needs_reconnect";
  }>(
    `SELECT p.page_id,p.name,p.encrypted_page_token,p.instagram_business_account_id,p.tasks,
            p.status AS page_status, c.status AS connection_status
     FROM meta_pages p JOIN meta_connections c ON c.id=p.connection_id
     WHERE c.owner_id=$1 AND p.id=$2`,
    [ownerId, metaPageId]
  )).rows[0];
  if (!row) throw new MetaConnectionError("not_found", 404);
  if (row.page_status !== "active" || row.connection_status !== "active") {
    throw new MetaConnectionError("needs_reconnect", 409);
  }
  let accessToken: string;
  try {
    accessToken = decryptCredential(row.encrypted_page_token, pageAad(ownerId, row.page_id));
  } catch {
    // Usually CREDENTIAL_ENCRYPTION_KEY changed after the connection was stored.
    throw new MetaConnectionError("needs_reconnect", 409);
  }
  return {
    pageId: row.page_id,
    name: row.name,
    accessToken,
    encryptedPageToken: row.encrypted_page_token,
    instagramBusinessAccountId: row.instagram_business_account_id,
    tasks: row.tasks ?? []
  };
}

const CREATE_TASKS = new Set(["CREATE_CONTENT", "MANAGE", "PROFILE_PLUS_CREATE_CONTENT", "PROFILE_PLUS_FULL_CONTROL"]);

function pageView(row: {
  id: string; page_id: string; name: string;
  instagram_business_account_id: string | null; tasks: string[]; status: "active" | "needs_reconnect";
}): MetaPageView {
  return {
    id: Number(row.id),
    pageId: row.page_id,
    name: row.name,
    instagramBusinessAccountId: row.instagram_business_account_id,
    tasks: row.tasks ?? [],
    status: row.status
  };
}

/**
 * Select one target for a business: its linked Instagram account or the Facebook
 * Page. Another owner's business or Page is a 404; an unusable target is a 400.
 */
export async function selectMetaTarget(
  ownerId: string,
  businessId: number,
  metaPageId: number,
  target: MetaTargetKind
): Promise<MetaSelectedTarget> {
  if (!Number.isSafeInteger(businessId) || businessId <= 0) throw new MetaConnectionError("not_found", 404);
  if (!Number.isSafeInteger(metaPageId) || metaPageId <= 0) throw new MetaConnectionError("not_found", 404);
  if (target !== "instagram" && target !== "facebook") throw new MetaConnectionError("invalid_target", 400);

  return transaction(async () => {
    const owned = await query("SELECT 1 FROM businesses WHERE id=$1 AND owner_id=$2", [businessId, ownerId]);
    if (!owned.rowCount) throw new MetaConnectionError("not_found", 404);

    const page = (await query<{
      id: string; page_id: string; name: string;
      instagram_business_account_id: string | null; tasks: string[];
      status: "active" | "needs_reconnect"; connection_status: "active" | "needs_reconnect";
    }>(
      `SELECT p.id,p.page_id,p.name,p.instagram_business_account_id,p.tasks,p.status,
              c.status AS connection_status
       FROM meta_pages p JOIN meta_connections c ON c.id=p.connection_id
       WHERE c.owner_id=$1 AND p.id=$2 FOR UPDATE OF p`,
      [ownerId, metaPageId]
    )).rows[0];
    if (!page) throw new MetaConnectionError("not_found", 404);
    if (page.status !== "active" || page.connection_status !== "active") {
      throw new MetaConnectionError("needs_reconnect", 409);
    }
    if (!page.tasks.some(task => CREATE_TASKS.has(task))) {
      throw new MetaConnectionError("page_cannot_publish", 400);
    }
    if (target === "instagram" && !page.instagram_business_account_id) {
      throw new MetaConnectionError("instagram_unavailable", 400);
    }

    await query(
      `INSERT INTO business_meta_targets(business_id,meta_page_id,target)
       VALUES($1,$2,$3)
       ON CONFLICT(business_id) DO UPDATE SET
         meta_page_id=EXCLUDED.meta_page_id,
         target=EXCLUDED.target,
         updated_at=now()`,
      [businessId, metaPageId, target]
    );
    return { target, page: pageView(page) };
  });
}

export async function getSelectedMetaTarget(ownerId: string, businessId: number): Promise<MetaSelectedTarget | null> {
  if (!Number.isSafeInteger(businessId) || businessId <= 0) return null;
  const row = (await query<{
    target: MetaTargetKind; id: string; page_id: string; name: string;
    instagram_business_account_id: string | null; tasks: string[];
    status: "active" | "needs_reconnect";
  }>(
    `SELECT t.target,p.id,p.page_id,p.name,p.instagram_business_account_id,p.tasks,p.status
     FROM business_meta_targets t
     JOIN meta_pages p ON p.id=t.meta_page_id
     JOIN meta_connections c ON c.id=p.connection_id
     WHERE t.business_id=$1 AND c.owner_id=$2`,
    [businessId, ownerId]
  )).rows[0];
  return row ? { target: row.target, page: pageView(row) } : null;
}

export async function clearMetaTarget(ownerId: string, businessId: number): Promise<boolean> {
  if (!Number.isSafeInteger(businessId) || businessId <= 0) throw new MetaConnectionError("not_found", 404);
  const owned = await query("SELECT 1 FROM businesses WHERE id=$1 AND owner_id=$2", [businessId, ownerId]);
  if (!owned.rowCount) throw new MetaConnectionError("not_found", 404);
  const removed = await query("DELETE FROM business_meta_targets WHERE business_id=$1", [businessId]);
  return !!removed.rowCount;
}

/** Drop the connection and cascade its Pages and business selections. */
export async function disconnectMeta(ownerId: string): Promise<boolean> {
  const removed = await query("DELETE FROM meta_connections WHERE owner_id=$1", [ownerId]);
  return !!removed.rowCount;
}

/**
 * Mark a Page for reconnect only if it still holds the token that failed. A
 * reconnect between the failed request and this update leaves the new token alone.
 */
export async function markMetaPageNeedsReconnect(
  ownerId: string,
  metaPageId: number,
  failedCiphertext: string
): Promise<boolean> {
  const updated = await query(
    `UPDATE meta_pages p SET status='needs_reconnect', updated_at=now()
     FROM meta_connections c
     WHERE p.connection_id=c.id AND c.owner_id=$1 AND p.id=$2 AND p.encrypted_page_token=$3`,
    [ownerId, metaPageId, failedCiphertext]
  );
  return !!updated.rowCount;
}
