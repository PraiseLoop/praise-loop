import { createHash, randomBytes } from "node:crypto";
import { query, transaction } from "../db";
import { decryptCredential, encryptCredential, loadKey } from "../integrations/credentials";

// Buffer OAuth connect (#29): authorization-code flow with PKCE (S256) and a
// confidential client. Refresh tokens are single use, so refreshing is serialized
// with a row lock and the replacement token is stored in the same transaction.
const AUTHORIZE_URL = "https://auth.buffer.com/auth";
const TOKEN_URL = "https://auth.buffer.com/token";
const API_URL = "https://api.buffer.com";
const SCOPES = "posts:read posts:write account:read offline_access";
const STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_SKEW_MS = 60 * 1000;
const TIMEOUT_MS = 10_000;
const ORGANIZATIONS_QUERY = "query { account { organizations { id name } } }";

export type BufferChannelService = "instagram" | "facebook";
export type BufferChannel = { id: string; name: string; service: BufferChannelService; type: string };
export type BufferOutcome = "connected" | "denied" | "expired" | "failed" | "not_configured";
export type BufferErrorCode =
  | "not_configured"
  | "expired"
  | "failed"
  | "no_organization"
  | "not_connected"
  | "needs_reconnect"
  | "not_found"
  | "invalid_channel"
  | "connection_changed";

// Short, fixed codes only: messages never carry a token, code, state, verifier,
// client secret or Buffer's error_description.
export class BufferConnectionError extends Error {
  constructor(readonly code: BufferErrorCode, readonly status = 400) {
    super(code);
    this.name = "BufferConnectionError";
  }
}

type Deps = { fetchImpl?: typeof fetch; now?: () => number };
type Config = { clientId: string; clientSecret: string; redirectUri: string };
type TokenSet = { accessToken: string; refreshToken: string; expiresIn: number; scope: string };
type ConnectionRow = {
  id: string;
  status: "active" | "needs_reconnect";
  organization_id: string;
  encrypted_access_token: string;
  encrypted_refresh_token: string;
  access_expires_at: Date;
};

// Read at request time so a restart is not needed when configuration changes.
// Missing configuration makes the connect route answer 503 and the callback
// report `not_configured`; nothing else throws a configuration detail.
function config(): Config | null {
  const clientId = process.env.BUFFER_CLIENT_ID;
  const clientSecret = process.env.BUFFER_CLIENT_SECRET;
  try {
    loadKey();
  } catch {
    return null;
  }
  const configured = process.env.BUFFER_REDIRECT_URI?.trim();
  const base = process.env.NEXTAUTH_URL?.replace(/\/+$/, "");
  const redirectUri = configured || (base ? `${base}/api/buffer/callback` : "");
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const accessAad = (ownerId: string) => `buffer:access:${ownerId}`;
const refreshAad = (ownerId: string) => `buffer:refresh:${ownerId}`;
const verifierAad = (ownerId: string) => `buffer:verifier:${ownerId}`;

function timeout() {
  return AbortSignal.timeout(TIMEOUT_MS);
}

function tokensFrom(value: unknown): TokenSet | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (typeof body.access_token !== "string" || !body.access_token) return null;
  if (typeof body.refresh_token !== "string" || !body.refresh_token) return null;
  if (typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in) || body.expires_in <= 0) return null;
  if (typeof body.scope !== "string") return null;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: body.expires_in,
    scope: body.scope
  };
}

async function tokenRequest(fetchImpl: typeof fetch, form: Record<string, string>) {
  return fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: timeout()
  });
}

async function graphql(fetchImpl: typeof fetch, accessToken: string, queryText: string) {
  return fetchImpl(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ query: queryText }),
    signal: timeout()
  });
}

async function firstOrganization(fetchImpl: typeof fetch, accessToken: string): Promise<string | null> {
  let response: Response;
  try {
    response = await graphql(fetchImpl, accessToken, ORGANIZATIONS_QUERY);
  } catch {
    throw new BufferConnectionError("failed", 502);
  }
  if (!response.ok) throw new BufferConnectionError("failed", 502);
  const body = await response.json().catch(() => null) as
    | { data?: { account?: { organizations?: { id?: unknown }[] } }; errors?: unknown[] }
    | null;
  if (!body || body.errors?.length) throw new BufferConnectionError("failed", 502);
  const organizations = body.data?.account?.organizations;
  if (!Array.isArray(organizations)) throw new BufferConnectionError("failed", 502);
  const id = organizations.find((organization) => typeof organization?.id === "string" && organization.id)?.id;
  return typeof id === "string" ? id : null;
}

// Only the access token that actually failed may flag the connection: if the owner
// reconnected (or another request refreshed) while a request using an older token was
// in flight, that stale failure says nothing about the stored credentials.
// Returns whether the connection still held the failing token and was updated.
async function markNeedsReconnect(ownerId: string, failedAccessToken: string): Promise<boolean> {
  const result = await query(
    `UPDATE buffer_connections SET status='needs_reconnect', updated_at=now()
     WHERE owner_id=$1 AND encrypted_access_token=$2`,
    [ownerId, failedAccessToken]
  );
  return !!result.rowCount;
}

/**
 * Mint a single-use state plus a PKCE verifier and return the Buffer authorize URL.
 * Only the state hash and the encrypted verifier are stored.
 */
export async function startBufferConnect(ownerId: string, deps: Deps = {}): Promise<string> {
  const cfg = config();
  if (!cfg) throw new BufferConnectionError("not_configured", 503);
  const now = (deps.now ?? Date.now)();

  await query("DELETE FROM buffer_oauth_states WHERE expires_at <= now()");
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  await query(
    `INSERT INTO buffer_oauth_states(state_hash,owner_id,encrypted_code_verifier,expires_at)
     VALUES($1,$2,$3,$4)`,
    [sha256(state), ownerId, encryptCredential(verifier, verifierAad(ownerId)), new Date(now + STATE_TTL_MS)]
  );

  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256"
  }).toString();
  return url.toString();
}

/**
 * Consume the state once, exchange the code, find the owner's organization and
 * store the encrypted tokens. `ownerId` optionally binds the completion to the
 * owner the caller expects; a mismatch consumes nothing.
 */
export async function completeBufferConnect(
  input: { state?: unknown; code?: unknown; ownerId?: string },
  deps: Deps = {}
): Promise<{ ownerId: string; outcome: "connected" }> {
  const cfg = config();
  if (!cfg) throw new BufferConnectionError("not_configured", 503);
  const state = typeof input.state === "string" ? input.state : "";
  const code = typeof input.code === "string" ? input.code : "";
  if (!state || !code) throw new BufferConnectionError("failed", 400);

  const consumed = await query<{ owner_id: string; encrypted_code_verifier: string }>(
    `DELETE FROM buffer_oauth_states
     WHERE state_hash=$1 AND expires_at > now() AND ($2::text IS NULL OR owner_id=$2)
     RETURNING owner_id, encrypted_code_verifier`,
    [sha256(state), input.ownerId ?? null]
  );
  const row = consumed.rows[0];
  if (!row) throw new BufferConnectionError("expired", 400);

  let verifier: string;
  try {
    verifier = decryptCredential(row.encrypted_code_verifier, verifierAad(row.owner_id));
  } catch {
    throw new BufferConnectionError("failed", 400);
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await tokenRequest(fetchImpl, {
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.redirectUri,
      code_verifier: verifier
    });
  } catch {
    throw new BufferConnectionError("failed", 502);
  }
  const tokens = response.ok ? tokensFrom(await response.json().catch(() => null)) : null;
  if (!tokens) throw new BufferConnectionError("failed", 400);

  const organizationId = await firstOrganization(fetchImpl, tokens.accessToken);
  if (!organizationId) throw new BufferConnectionError("no_organization", 400);

  const now = (deps.now ?? Date.now)();
  await transaction(async () => {
    // Reconnecting a different Buffer account (another organization) must not leave
    // channel selections pointing at channels the new account does not have.
    // Reconnecting the same organization keeps them. Take the connection's row lock
    // FIRST and hold it through the cleanup and the upsert: a channel selection that
    // is mid-save holds the same lock, so this waits for it to commit and then sees
    // (and removes) its row instead of racing past it.
    const existing = await query<{ id: string; organization_id: string }>(
      "SELECT id,organization_id FROM buffer_connections WHERE owner_id=$1 FOR UPDATE",
      [row.owner_id]
    );
    const previous = existing.rows[0];
    if (previous && previous.organization_id !== organizationId) {
      await query("DELETE FROM business_buffer_channels WHERE connection_id=$1", [previous.id]);
    }
    await query(
      `INSERT INTO buffer_connections(owner_id,organization_id,encrypted_access_token,encrypted_refresh_token,access_expires_at,scope,status)
       VALUES($1,$2,$3,$4,$5,$6,'active')
       ON CONFLICT(owner_id) DO UPDATE SET
         organization_id=EXCLUDED.organization_id,
         encrypted_access_token=EXCLUDED.encrypted_access_token,
         encrypted_refresh_token=EXCLUDED.encrypted_refresh_token,
         access_expires_at=EXCLUDED.access_expires_at,
         scope=EXCLUDED.scope,
         status='active',
         updated_at=now()`,
      [
        row.owner_id,
        organizationId,
        encryptCredential(tokens.accessToken, accessAad(row.owner_id)),
        encryptCredential(tokens.refreshToken, refreshAad(row.owner_id)),
        new Date(now + tokens.expiresIn * 1000),
        tokens.scope
      ]
    );
  });
  return { ownerId: row.owner_id, outcome: "connected" };
}

/**
 * A valid access token, refreshing within 60 seconds of expiry. Refreshing holds
 * the connection row lock, re-checks expiry after the lock and stores the new
 * access and refresh tokens before committing. A lost or rejected refresh marks
 * the connection `needs_reconnect` and is never retried with the old token.
 */
export async function getBufferAccessToken(ownerId: string, deps: Deps = {}): Promise<string> {
  return (await accessTokenWithVersion(ownerId, deps)).accessToken;
}

// `version` is the stored (encrypted) access token. Its random IV makes it unique per
// stored token, so a caller that later learns the token was rejected can mark the
// connection `needs_reconnect` only if it still holds this same token.
async function accessTokenWithVersion(
  ownerId: string,
  deps: Deps = {}
): Promise<{ accessToken: string; version: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const current = await query<ConnectionRow>(
    `SELECT id,status,organization_id,encrypted_access_token,encrypted_refresh_token,access_expires_at
     FROM buffer_connections WHERE owner_id=$1`,
    [ownerId]
  );
  const row = current.rows[0];
  if (!row) throw new BufferConnectionError("not_connected", 404);
  if (row.status === "needs_reconnect") throw new BufferConnectionError("needs_reconnect", 409);
  if (new Date(row.access_expires_at).getTime() > now() + REFRESH_SKEW_MS) {
    return {
      accessToken: decryptCredential(row.encrypted_access_token, accessAad(ownerId)),
      version: row.encrypted_access_token
    };
  }

  const result = await transaction(async () => {
    const locked = await query<ConnectionRow>(
      `SELECT id,status,organization_id,encrypted_access_token,encrypted_refresh_token,access_expires_at
       FROM buffer_connections WHERE owner_id=$1 FOR UPDATE`,
      [ownerId]
    );
    const connection = locked.rows[0];
    if (!connection) return { kind: "not_connected" as const };
    if (connection.status === "needs_reconnect") return { kind: "needs_reconnect" as const };
    // Another request may have refreshed while this one waited for the lock.
    if (new Date(connection.access_expires_at).getTime() > now() + REFRESH_SKEW_MS) {
      return {
        kind: "ok" as const,
        accessToken: decryptCredential(connection.encrypted_access_token, accessAad(ownerId)),
        version: connection.encrypted_access_token
      };
    }

    const cfg = config();
    if (!cfg) return { kind: "not_configured" as const };

    let tokens: TokenSet | null = null;
    try {
      const refreshToken = decryptCredential(connection.encrypted_refresh_token, refreshAad(ownerId));
      const response = await tokenRequest(fetchImpl, {
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken
      });
      tokens = response.ok ? tokensFrom(await response.json().catch(() => null)) : null;
    } catch {
      // The request may have reached Buffer; the old refresh token is unusable
      // now, so the owner must reconnect rather than us retrying with it.
      tokens = null;
    }
    if (!tokens) {
      await query(
        "UPDATE buffer_connections SET status='needs_reconnect', updated_at=now() WHERE owner_id=$1",
        [ownerId]
      );
      return { kind: "needs_reconnect" as const };
    }

    const storedAccessToken = encryptCredential(tokens.accessToken, accessAad(ownerId));
    await query(
      `UPDATE buffer_connections
       SET encrypted_access_token=$2, encrypted_refresh_token=$3, access_expires_at=$4,
           scope=$5, status='active', updated_at=now()
       WHERE owner_id=$1`,
      [
        ownerId,
        storedAccessToken,
        encryptCredential(tokens.refreshToken, refreshAad(ownerId)),
        new Date(now() + tokens.expiresIn * 1000),
        tokens.scope
      ]
    );
    return { kind: "ok" as const, accessToken: tokens.accessToken, version: storedAccessToken };
  });

  switch (result.kind) {
    case "ok":
      return { accessToken: result.accessToken, version: result.version };
    case "not_connected":
      throw new BufferConnectionError("not_connected", 404);
    case "not_configured":
      throw new BufferConnectionError("not_configured", 503);
    default:
      throw new BufferConnectionError("needs_reconnect", 409);
  }
}

/** Instagram and Facebook channels that are neither disconnected nor locked. */
export async function listBufferChannels(ownerId: string, deps: Deps = {}): Promise<BufferChannel[]> {
  return (await fetchBufferChannels(ownerId, deps)).channels;
}

// Also returns the organization the list was fetched for, so a caller that writes
// based on the list can prove the owner has not reconnected a different Buffer
// account in the meantime.
async function fetchBufferChannels(
  ownerId: string,
  deps: Deps = {}
): Promise<{ organizationId: string; channels: BufferChannel[] }> {
  const { accessToken, version } = await accessTokenWithVersion(ownerId, deps);
  const connection = await query<{ organization_id: string }>(
    "SELECT organization_id FROM buffer_connections WHERE owner_id=$1",
    [ownerId]
  );
  const organizationId = connection.rows[0]?.organization_id;
  if (!organizationId) throw new BufferConnectionError("not_connected", 404);

  const fetchImpl = deps.fetchImpl ?? fetch;
  const queryText = `query { channels(input: { organizationId: ${JSON.stringify(organizationId)} }) { id name displayName service type isDisconnected isLocked } }`;
  let response: Response;
  try {
    response = await graphql(fetchImpl, accessToken, queryText);
  } catch {
    throw new BufferConnectionError("failed", 502);
  }
  if (response.status === 401) {
    // If the owner reconnected while this request was in flight, the rejected token is
    // no longer the stored one: report the change and leave the new connection alone.
    if (await markNeedsReconnect(ownerId, version)) throw new BufferConnectionError("needs_reconnect", 409);
    throw new BufferConnectionError("connection_changed", 409);
  }
  if (!response.ok) throw new BufferConnectionError("failed", 502);
  const body = await response.json().catch(() => null) as
    | { data?: { channels?: unknown[] }; errors?: unknown[] }
    | null;
  if (!body || body.errors?.length || !Array.isArray(body.data?.channels)) {
    throw new BufferConnectionError("failed", 502);
  }

  const channels: BufferChannel[] = [];
  for (const raw of body.data.channels) {
    if (!raw || typeof raw !== "object") continue;
    const channel = raw as Record<string, unknown>;
    const service = channel.service;
    if (service !== "instagram" && service !== "facebook") continue;
    if (channel.isDisconnected === true || channel.isLocked === true) continue;
    if (typeof channel.id !== "string" || !channel.id) continue;
    const name = typeof channel.displayName === "string" && channel.displayName
      ? channel.displayName
      : typeof channel.name === "string" && channel.name
        ? channel.name
        : channel.id;
    channels.push({
      id: channel.id,
      name,
      service,
      type: typeof channel.type === "string" ? channel.type : ""
    });
  }
  return { organizationId, channels };
}

/** Drop the stored tokens; Buffer has no revoke endpoint. */
export async function disconnectBuffer(ownerId: string): Promise<boolean> {
  const result = await query("DELETE FROM buffer_connections WHERE owner_id=$1", [ownerId]);
  return !!result.rowCount;
}

export async function getSelectedBufferChannel(ownerId: string, businessId: number) {
  const result = await query<{ channel_id: string; channel_name: string; service: BufferChannelService }>(
    `SELECT c.channel_id, c.channel_name, c.service
     FROM business_buffer_channels c
     JOIN buffer_connections bc ON bc.id=c.connection_id
     WHERE c.business_id=$1 AND bc.owner_id=$2`,
    [businessId, ownerId]
  );
  const row = result.rows[0];
  return row ? { id: row.channel_id, name: row.channel_name, service: row.service } : null;
}

/**
 * Select one of the owner's fresh channels for a business. Another owner's
 * business is a 404 and nothing is written; a channel not in the fresh list is
 * a 400, so a stale or foreign channel id cannot be stored.
 */
export async function selectBufferChannel(
  ownerId: string,
  businessId: number,
  channelId: string,
  deps: Deps = {}
): Promise<BufferChannel> {
  if (!Number.isSafeInteger(businessId) || businessId <= 0) {
    throw new BufferConnectionError("not_found", 404);
  }
  const owned = await query("SELECT 1 FROM businesses WHERE id=$1 AND owner_id=$2", [businessId, ownerId]);
  if (!owned.rowCount) throw new BufferConnectionError("not_found", 404);

  const { organizationId, channels } = await fetchBufferChannels(ownerId, deps);
  const channel = channels.find((candidate) => candidate.id === channelId);
  if (!channel) throw new BufferConnectionError("invalid_channel", 400);

  // The channel list was fetched over the network, so the owner may have reconnected
  // a different Buffer account while it was in flight. Lock the connection row (a
  // reconnect updates it) and write only if it is still the organization the list
  // came from; otherwise the saved channel could belong to an account that is gone.
  const outcome = await transaction(async () => {
    const locked = await query<{ id: string; organization_id: string; status: string }>(
      "SELECT id,organization_id,status FROM buffer_connections WHERE owner_id=$1 FOR UPDATE",
      [ownerId]
    );
    const connection = locked.rows[0];
    if (!connection) return "not_connected" as const;
    if (connection.organization_id !== organizationId || connection.status !== "active") return "changed" as const;
    await query(
      `INSERT INTO business_buffer_channels(business_id,connection_id,channel_id,channel_name,service,channel_type)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(business_id) DO UPDATE SET
         connection_id=EXCLUDED.connection_id,
         channel_id=EXCLUDED.channel_id,
         channel_name=EXCLUDED.channel_name,
         service=EXCLUDED.service,
         channel_type=EXCLUDED.channel_type,
         updated_at=now()`,
      [businessId, connection.id, channel.id, channel.name, channel.service, channel.type]
    );
    return "saved" as const;
  });
  if (outcome === "not_connected") throw new BufferConnectionError("not_connected", 404);
  if (outcome === "changed") throw new BufferConnectionError("connection_changed", 409);
  return channel;
}

export async function clearBufferChannel(ownerId: string, businessId: number): Promise<boolean> {
  const result = await query(
    `DELETE FROM business_buffer_channels
     WHERE business_id=$1 AND connection_id IN (SELECT id FROM buffer_connections WHERE owner_id=$2)`,
    [businessId, ownerId]
  );
  return !!result.rowCount;
}

export type BufferConnectionSummary = {
  connected: boolean;
  status: "active" | "needs_reconnect" | null;
  channels: BufferChannel[];
};

/**
 * The connection screen's data. A channel-list failure is not an error: it
 * returns no channels and whatever status the attempt left behind.
 */
export async function getBufferConnection(ownerId: string, deps: Deps = {}): Promise<BufferConnectionSummary> {
  const current = await query<{ status: "active" | "needs_reconnect" }>(
    "SELECT status FROM buffer_connections WHERE owner_id=$1",
    [ownerId]
  );
  const row = current.rows[0];
  if (!row) return { connected: false, status: null, channels: [] };
  if (row.status !== "active") return { connected: true, status: row.status, channels: [] };

  try {
    return { connected: true, status: "active", channels: await listBufferChannels(ownerId, deps) };
  } catch {
    const updated = await query<{ status: "active" | "needs_reconnect" }>(
      "SELECT status FROM buffer_connections WHERE owner_id=$1",
      [ownerId]
    );
    return { connected: true, status: updated.rows[0]?.status ?? "needs_reconnect", channels: [] };
  }
}
