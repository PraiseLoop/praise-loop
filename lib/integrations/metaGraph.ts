// Meta Graph OAuth and account lookup for direct publishing (#234). No SDK: the
// three calls are documented REST requests and injecting `fetchImpl` keeps the
// tests offline. Tokens, codes and the app secret never enter a log line or an
// error message; callers only see a short code.
export const META_SCOPES = [
  "instagram_basic",
  "instagram_content_publish",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts"
].join(",");

const DEFAULT_VERSION = "v27.0";
const TIMEOUT_MS = 15_000;
const MAX_PAGES = 5;
const PAGE_FIELDS = "id,name,access_token,instagram_business_account,tasks";

type Env = Record<string, string | undefined>;

export type MetaGraphConfig = {
  appId: string;
  appSecret: string;
  redirectUri: string;
  version: string;
  /** Optional Facebook Login for Business configuration id; when set it replaces scope. */
  configId: string | null;
};

/** A Graph response Meta refused or that did not have the documented shape. */
export class MetaGraphError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "MetaGraphError";
  }
}

function value(env: Env, key: string): string | null {
  const trimmed = env[key]?.trim();
  return trimmed || null;
}

function apiVersion(raw: string | null): string | null {
  if (!raw) return DEFAULT_VERSION;
  return /^v\d{1,3}\.\d{1,3}$/.test(raw) ? raw : null;
}

/**
 * Read at request time. Missing app credentials, an invalid version or a missing
 * redirect base returns null, so the connect route fails closed instead of
 * building a broken authorization URL.
 */
export function metaGraphConfig(env: Env = process.env): MetaGraphConfig | null {
  const appId = value(env, "META_APP_ID");
  const appSecret = value(env, "META_APP_SECRET");
  const version = apiVersion(value(env, "META_GRAPH_VERSION"));
  if (!appId || !appSecret || !version) return null;
  const base = value(env, "NEXTAUTH_URL")?.replace(/\/+$/, "");
  const redirectUri = value(env, "META_REDIRECT_URI") ?? (base ? `${base}/api/meta/callback` : null);
  if (!redirectUri) return null;
  return { appId, appSecret, redirectUri, version, configId: value(env, "META_CONFIG_ID") };
}

/** The Facebook Login dialog. A configured Login for Business configuration owns the permission list. */
export function metaAuthorizeUrl(config: MetaGraphConfig, state: string): string {
  const url = new URL(`https://www.facebook.com/${config.version}/dialog/oauth`);
  const params: Record<string, string> = {
    client_id: config.appId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    state
  };
  if (config.configId) params.config_id = config.configId;
  else params.scope = META_SCOPES;
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}

export type MetaPageAccount = {
  pageId: string;
  name: string;
  /** Long-lived Page token; only this value is stored, encrypted. */
  accessToken: string;
  instagramBusinessAccountId: string | null;
  tasks: string[];
};

export interface MetaGraphClient {
  /** Exchange the callback code for a short-lived User token. */
  exchangeCode(code: string): Promise<string>;
  /** Exchange the short-lived User token for a ~60-day token. */
  exchangeLongLived(shortToken: string): Promise<string>;
  /** Pages the user manages, with their Page tokens and linked Instagram accounts. */
  listAccounts(userToken: string): Promise<MetaPageAccount[]>;
}

type Options = { config: MetaGraphConfig; fetchImpl?: typeof fetch; timeoutMs?: number };

class RestMetaGraphClient implements MetaGraphClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: Options) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async get<T>(url: URL): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? TIMEOUT_MS)
      });
    } catch {
      throw new MetaGraphError(0, "network");
    }
    let body: unknown = null;
    try { body = await response.json(); } catch { /* reported below */ }
    if (!response.ok) {
      const error = body && typeof body === "object" ? (body as { error?: Record<string, unknown> }).error : null;
      const code = typeof error?.code === "number"
        ? String(error.code)
        : typeof error?.type === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(error.type)
          ? error.type
          : "rejected";
      throw new MetaGraphError(response.status, code);
    }
    if (!body || typeof body !== "object") throw new MetaGraphError(200, "invalid_response");
    return body as T;
  }

  private tokenUrl(): URL {
    return new URL(`https://graph.facebook.com/${this.options.config.version}/oauth/access_token`);
  }

  async exchangeCode(code: string): Promise<string> {
    const url = this.tokenUrl();
    url.search = new URLSearchParams({
      client_id: this.options.config.appId,
      client_secret: this.options.config.appSecret,
      redirect_uri: this.options.config.redirectUri,
      code
    }).toString();
    const body = await this.get<{ access_token?: unknown }>(url);
    if (typeof body.access_token !== "string" || !body.access_token) throw new MetaGraphError(200, "invalid_response");
    return body.access_token;
  }

  async exchangeLongLived(shortToken: string): Promise<string> {
    const url = this.tokenUrl();
    url.search = new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: this.options.config.appId,
      client_secret: this.options.config.appSecret,
      fb_exchange_token: shortToken
    }).toString();
    const body = await this.get<{ access_token?: unknown }>(url);
    if (typeof body.access_token !== "string" || !body.access_token) throw new MetaGraphError(200, "invalid_response");
    return body.access_token;
  }

  async listAccounts(userToken: string): Promise<MetaPageAccount[]> {
    const first = new URL(`https://graph.facebook.com/${this.options.config.version}/me/accounts`);
    first.search = new URLSearchParams({ fields: PAGE_FIELDS, limit: "100", access_token: userToken }).toString();

    const accounts: MetaPageAccount[] = [];
    const seen = new Set<string>();
    let next: URL | null = first;
    for (let page = 0; next && page < MAX_PAGES; page += 1) {
      const body: { data?: unknown; paging?: { next?: unknown } } =
        await this.get<{ data?: unknown; paging?: { next?: unknown } }>(next);
      if (!Array.isArray(body.data)) throw new MetaGraphError(200, "invalid_response");
      for (const raw of body.data) {
        if (!raw || typeof raw !== "object") continue;
        const item = raw as Record<string, unknown>;
        if (typeof item.id !== "string" || !item.id) continue;
        if (typeof item.access_token !== "string" || !item.access_token) continue;
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        const instagram = item.instagram_business_account;
        const instagramId = instagram && typeof instagram === "object" && typeof (instagram as { id?: unknown }).id === "string"
          ? (instagram as { id: string }).id
          : null;
        accounts.push({
          pageId: item.id,
          name: typeof item.name === "string" && item.name ? item.name : item.id,
          accessToken: item.access_token,
          instagramBusinessAccountId: instagramId,
          tasks: Array.isArray(item.tasks) ? item.tasks.filter((task): task is string => typeof task === "string") : []
        });
      }
      const rawNext: unknown = body.paging?.next;
      if (typeof rawNext !== "string") { next = null; break; }
      // Only follow Meta's own paging URL; a response cannot send us elsewhere.
      try {
        const candidate: URL = new URL(rawNext);
        next = candidate.protocol === "https:" && candidate.hostname === "graph.facebook.com" ? candidate : null;
      } catch {
        next = null;
      }
    }
    return accounts;
  }
}

export function metaGraphClient(options: Options): MetaGraphClient {
  return new RestMetaGraphClient(options);
}
