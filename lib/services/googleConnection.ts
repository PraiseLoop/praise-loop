import { createHash, randomBytes } from "node:crypto";
import { query, transaction } from "../db";
import {
  googleAuthorizeUrl,
  googleBusinessClient,
  googleBusinessConfig,
  GoogleApiError,
  type GoogleBusinessClient,
  type GoogleLocation,
  type GoogleReviewsClient
} from "../integrations/googleBusiness";
import {
  connect,
  decryptToken,
  disconnect,
  encryptToken,
  googleReviewSyncEnabled,
  liveClient
} from "../integrations/googleReviews";
import { log } from "../log";
import { entitlementsFor } from "./entitlements";

// Google Business Profile connect (#46 part 2). The callback does not create a
// connection until the owner has chosen one of the returned locations; the grant
// between those two steps holds only an encrypted refresh token and the display
// data Google returned. The live REST client is injected in tests, never called here.
const STATE_TTL_MS = 10 * 60 * 1000;
const GRANT_TTL_MS = 15 * 60 * 1000;
const LOCATION_NAME = /^accounts\/[^/]+\/locations\/[^/]+$/;

type Env = Record<string, string | undefined>;
export type GoogleDeps = { client?: GoogleBusinessClient; now?: () => number; env?: Env };
export type GoogleOutcome =
  | "connected" | "pick_location" | "no_locations" | "denied" | "expired"
  | "failed" | "not_configured" | "plan_required" | "missing_scope";
export type GoogleConnectionErrorCode =
  | "not_configured" | "plan_required" | "expired" | "failed"
  | "not_found" | "invalid_location" | "missing_scope";
export type GoogleConnectionStatus = "none" | "active" | "revoked" | "disconnected";

export class GoogleConnectionError extends Error {
  constructor(readonly code: GoogleConnectionErrorCode, readonly status = 400) {
    super(code);
    this.name = "GoogleConnectionError";
  }
}

export type GoogleConnectionView = {
  enabled: boolean;
  planAllows: boolean;
  status: GoogleConnectionStatus;
  locationTitle: string | null;
  lastSyncAt: string | null;
  lastSyncCount: number;
  lastErrorCode: string | null;
  pending: { locations: GoogleLocation[] } | null;
};

export type GoogleConnectResult = {
  ownerId: string;
  businessId: number;
  outcome: "connected" | "pick_location" | "no_locations";
  locations: number;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * The flag, OAuth credentials and a valid encryption key must all be present.
 * The key check is here rather than in `googleReviewSyncEnabled` so the flag
 * stays a pure expression of GOOGLE_REVIEW_SYNC and the OAuth config.
 */
function config(env: Env = process.env) {
  if (!googleReviewSyncEnabled(env)) return null;
  try {
    if (Buffer.from(env.GOOGLE_TOKEN_KEY ?? "", "base64").length !== 32) return null;
  } catch {
    return null;
  }
  return googleBusinessConfig(env)!;
}

function clock(deps: GoogleDeps) { return (deps.now ?? Date.now)(); }

function connectFailed(step: string, error?: unknown) {
  const fields: Record<string, unknown> = { step };
  if (error instanceof GoogleApiError) {
    // A short sanitized code and numeric status only; never provider text, a token or a code.
    fields.googleStatus = error.status;
    fields.googleCode = error.code;
  }
  log.warn("google_connect_failed", fields);
}

async function requireReviewSync(ownerId: string): Promise<void> {
  if (!(await entitlementsFor(ownerId)).limits.reviewSync) {
    throw new GoogleConnectionError("plan_required", 403);
  }
}

function businessClient(cfg: NonNullable<ReturnType<typeof config>>, deps: GoogleDeps) {
  return deps.client ?? googleBusinessClient({ config: cfg });
}

/** Sanitize what the client returns before it reaches a row or a browser. */
function displayLocations(value: unknown): GoogleLocation[] {
  if (!Array.isArray(value)) return [];
  const result: GoogleLocation[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.name !== "string" || !LOCATION_NAME.test(row.name)) continue;
    result.push({
      name: row.name,
      title: typeof row.title === "string" && row.title ? row.title : row.name,
      address: typeof row.address === "string" && row.address ? row.address : null
    });
  }
  return result;
}

/** Create a single-use state bound to the owner AND business, and return the consent URL. */
export async function startGoogleConnect(ownerId: string, businessId: number, deps: GoogleDeps = {}): Promise<string> {
  const cfg = config(deps.env);
  if (!cfg || !Number.isSafeInteger(businessId) || businessId <= 0) throw new GoogleConnectionError("not_configured", 503);
  await requireReviewSync(ownerId);
  const own = await query("SELECT 1 FROM businesses WHERE id=$1 AND owner_id=$2", [businessId, ownerId]);
  if (!own.rowCount) throw new GoogleConnectionError("not_found", 404);

  await query("DELETE FROM google_oauth_states WHERE expires_at <= now()");
  const state = randomBytes(32).toString("base64url");
  await query(
    `INSERT INTO google_oauth_states(state_hash,owner_id,business_id,expires_at)
     VALUES($1,$2,$3,$4)`,
    [sha256(state), ownerId, businessId, new Date(clock(deps) + STATE_TTL_MS)]
  );
  return googleAuthorizeUrl(cfg, state);
}

/**
 * Consume the state with the signed-in owner, exchange the code, then either
 * connect a single location or hold the grant for the owner's choice. A different
 * owner consumes nothing. No token, code or state is logged or returned.
 */
export async function completeGoogleConnect(
  input: { state?: unknown; code?: unknown; ownerId?: string },
  deps: GoogleDeps = {}
): Promise<GoogleConnectResult> {
  const cfg = config(deps.env);
  if (!cfg) throw new GoogleConnectionError("not_configured", 503);
  const state = typeof input.state === "string" ? input.state : "";
  const code = typeof input.code === "string" ? input.code : "";
  const ownerId = typeof input.ownerId === "string" ? input.ownerId : "";
  if (!state || !code || !ownerId) {
    connectFailed("no_code_or_owner");
    throw new GoogleConnectionError("failed", 400);
  }

  const consumed = await query<{ owner_id: string; business_id: string }>(
    `DELETE FROM google_oauth_states
     WHERE state_hash=$1 AND expires_at > now() AND owner_id=$2
     RETURNING owner_id, business_id`,
    [sha256(state), ownerId]
  );
  const row = consumed.rows[0];
  if (!row) {
    connectFailed("state_expired_or_other");
    throw new GoogleConnectionError("expired", 400);
  }
  const businessId = Number(row.business_id);
  if (!Number.isSafeInteger(businessId) || businessId <= 0) {
    connectFailed("bad_state_business");
    throw new GoogleConnectionError("failed", 400);
  }
  await requireReviewSync(row.owner_id);

  const client = businessClient(cfg, deps);
  let tokens: { refreshToken: string; accessToken: string };
  let locations: GoogleLocation[];
  try {
    tokens = await client.exchangeCode(code);
    locations = displayLocations(await client.listLocations(tokens.accessToken));
  } catch (error) {
    if (error instanceof GoogleApiError && error.code === "missing_scope") {
      connectFailed("missing_scope", error);
      throw new GoogleConnectionError("missing_scope", 400);
    }
    connectFailed("provider_exchange", error);
    throw new GoogleConnectionError("failed", 502);
  }

  if (!locations.length) {
    // Leave any previous connection alone: an empty list can mean a missing
    // permission, and wiping a working connection would be worse.
    // Nothing will use this grant, so hand it back to Google rather than leave it live.
    try { await client.revoke(tokens.refreshToken); } catch { /* best-effort; nothing was stored */ }
    log.info("google_connect_no_locations", { businessId });
    return { ownerId: row.owner_id, businessId, outcome: "no_locations", locations: 0 };
  }

  if (locations.length === 1) {
    const only = locations[0];
    const id = await connect(row.owner_id, businessId, only.name, tokens.refreshToken, only.title);
    if (!id) throw new GoogleConnectionError("not_found", 404);
    await query("DELETE FROM google_pending_grants WHERE owner_id=$1 AND business_id=$2", [row.owner_id, businessId]);
    log.info("google_connected", { businessId, locations: 1 });
    return { ownerId: row.owner_id, businessId, outcome: "connected", locations: 1 };
  }

  await query(
    `INSERT INTO google_pending_grants(owner_id,business_id,encrypted_refresh_token,locations,expires_at)
     VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(business_id) DO UPDATE SET owner_id=EXCLUDED.owner_id,
       encrypted_refresh_token=EXCLUDED.encrypted_refresh_token, locations=EXCLUDED.locations,
       expires_at=EXCLUDED.expires_at, created_at=now()`,
    [
      row.owner_id,
      businessId,
      encryptToken(tokens.refreshToken, row.owner_id, businessId),
      JSON.stringify(locations),
      new Date(clock(deps) + GRANT_TTL_MS)
    ]
  );
  log.info("google_connect_location_required", { businessId, locations: locations.length });
  return { ownerId: row.owner_id, businessId, outcome: "pick_location", locations: locations.length };
}

/** The owner's status and locations (display data only), never a token. */
export async function getGoogleConnection(
  ownerId: string,
  businessId: number,
  deps: GoogleDeps = {}
): Promise<GoogleConnectionView> {
  const empty: GoogleConnectionView = {
    enabled: false, planAllows: false, status: "none", locationTitle: null,
    lastSyncAt: null, lastSyncCount: 0, lastErrorCode: null, pending: null
  };
  if (!googleReviewSyncEnabled(deps.env) || !Number.isSafeInteger(businessId) || businessId <= 0) return empty;
  const planAllows = (await entitlementsFor(ownerId)).limits.reviewSync;
  await query("DELETE FROM google_pending_grants WHERE expires_at <= now()");

  const connection = (await query<{
    status: GoogleConnectionStatus;
    location_title: string | null;
    last_sync_at: Date | null;
    last_sync_count: number;
    last_error_code: string | null;
  }>(
    `SELECT status,location_title,last_sync_at,last_sync_count,last_error_code
     FROM google_connections WHERE business_id=$1 AND owner_id=$2`,
    [businessId, ownerId]
  )).rows[0];
  const status: GoogleConnectionStatus = connection && ["active", "revoked", "disconnected"].includes(connection.status)
    ? connection.status
    : "none";

  const pending = (await query<{ locations: unknown }>(
    `SELECT locations FROM google_pending_grants
     WHERE business_id=$1 AND owner_id=$2 AND expires_at > now()`,
    [businessId, ownerId]
  )).rows[0];
  const locations = pending ? displayLocations(pending.locations) : [];

  return {
    enabled: true,
    planAllows,
    status,
    locationTitle: connection?.location_title ?? null,
    lastSyncAt: connection?.last_sync_at ? new Date(connection.last_sync_at).toISOString() : null,
    lastSyncCount: connection ? Number(connection.last_sync_count ?? 0) : 0,
    lastErrorCode: connection?.last_error_code ?? null,
    pending: locations.length ? { locations } : null
  };
}

/** Choose one of the locations from the pending grant; a client-supplied name alone is never trusted. */
export async function chooseGoogleLocation(
  ownerId: string,
  businessId: number,
  location: unknown,
  deps: GoogleDeps = {}
): Promise<GoogleConnectionView> {
  const cfg = config(deps.env);
  if (!cfg || !Number.isSafeInteger(businessId) || businessId <= 0) throw new GoogleConnectionError("not_configured", 503);
  await requireReviewSync(ownerId);
  if (typeof location !== "string" || !LOCATION_NAME.test(location)) {
    throw new GoogleConnectionError("invalid_location", 400);
  }

  await transaction(async () => {
    const pending = (await query<{ id: string; encrypted_refresh_token: string; locations: unknown }>(
      `SELECT id,encrypted_refresh_token,locations FROM google_pending_grants
       WHERE business_id=$1 AND owner_id=$2 AND expires_at > now() FOR UPDATE`,
      [businessId, ownerId]
    )).rows[0];
    if (!pending) throw new GoogleConnectionError("expired", 400);
    const chosen = displayLocations(pending.locations).find(row => row.name === location);
    if (!chosen) throw new GoogleConnectionError("invalid_location", 400);

    let refreshToken: string;
    try {
      refreshToken = decryptToken(pending.encrypted_refresh_token, ownerId, businessId);
    } catch {
      // A rotated key cannot open the grant; ask the owner to reconnect.
      connectFailed("pending_token_undecryptable");
      throw new GoogleConnectionError("failed", 400);
    }
    const id = await connect(ownerId, businessId, chosen.name, refreshToken, chosen.title);
    if (!id) throw new GoogleConnectionError("not_found", 404);
    await query("DELETE FROM google_pending_grants WHERE id=$1", [pending.id]);
  });

  log.info("google_location_selected", { businessId, locations: 1 });
  return getGoogleConnection(ownerId, businessId, deps);
}

function noRevokeClient(): GoogleReviewsClient {
  // Only used when the flag was turned off after connecting: drop the local
  // credential, with no provider call and nothing to log.
  return {
    async refreshAccessToken() { throw new Error("google_business_not_configured"); },
    async listReviews() { throw new Error("google_business_not_configured"); },
    async revoke() { /* the token is already removed locally */ }
  };
}

/** Always allowed, even when the flag is off or the business is no longer connected. */
export async function disconnectGoogle(ownerId: string, businessId: number, deps: GoogleDeps = {}): Promise<boolean> {
  if (!Number.isSafeInteger(businessId) || businessId <= 0) throw new GoogleConnectionError("not_found", 404);
  await query("DELETE FROM google_pending_grants WHERE owner_id=$1 AND business_id=$2", [ownerId, businessId]);
  let client: GoogleReviewsClient;
  if (deps.client) client = deps.client;
  else {
    try { client = liveClient(); }
    catch { client = noRevokeClient(); }
  }
  return disconnect(client, ownerId, businessId);
}
