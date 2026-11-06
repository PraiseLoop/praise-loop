export type ApiErrorKind = "signedOut" | "conflict" | "limit" | "network" | "timeout" | "http";

const messages: Record<Exclude<ApiErrorKind, "http">, string> = {
  signedOut: "Your session ended. Sign in again.",
  conflict: "This post changed somewhere else. Refresh and try again.",
  limit: "You’ve reached today’s limit. Try again tomorrow.",
  network: "Can’t reach PraiseLoop. Check your connection and try again.",
  timeout: "PraiseLoop took too long to answer. Try again."
};

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  // The server's own words on a 409, so a caller can tell a stale version from
  // another refusal. For matching only; never shown to the owner as-is.
  readonly detail?: string;
  // The server's stable machine code (for example `invite_only`), so a screen can
  // map a refusal to its own copy without matching on a message.
  readonly code?: string;

  constructor(kind: ApiErrorKind, status?: number, message?: string, detail?: string, code?: string) {
    super(message ?? (kind === "http" ? "That didn’t work. Try again." : messages[kind]));
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.detail = detail;
    this.code = code;
  }
}

async function conflictDetail(response: Response): Promise<string | undefined> {
  try {
    const data = await response.json() as { message?: unknown; error?: unknown } | null;
    const text = typeof data?.message === "string" ? data.message : typeof data?.error === "string" ? data.error : undefined;
    return text?.slice(0, 200);
  } catch {
    return undefined;
  }
}

// The one test for "the server says this session is over", shared by every screen.
export function isSignedOut(error: unknown): boolean {
  return error instanceof ApiError && error.kind === "signedOut";
}

// For the requests a screen can live without (the plan, the profile). A failure
// becomes null so it never hides the screen's real content, but a 401 still
// rejects: the session really is over and belongs on the handleError path.
export function bestEffort<T>(request: Promise<T>): Promise<T | null> {
  return request.catch(error => {
    if (isSignedOut(error)) throw error;
    return null;
  });
}

export type ApiRequest = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
};

export type ApiClientOptions = {
  baseUrl: string;
  getToken?: () => string | null | Promise<string | null>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export function createApiClient({ baseUrl, getToken, fetchImpl = fetch, timeoutMs = 15000 }: ApiClientOptions) {
  const root = baseUrl.replace(/\/+$/, "");

  async function request<T>(path: string, { method = "GET", body, headers = {} }: ApiRequest = {}): Promise<T> {
    if (!root) throw new ApiError("network", undefined, "API_BASE_URL is not configured for this build.");
    const token = await getToken?.();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${root}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });

      if (response.status === 401) throw new ApiError("signedOut", 401);
      if (response.status === 409) throw new ApiError("conflict", 409, undefined, await conflictDetail(response));
      if (response.status === 429) throw new ApiError("limit", 429);
      if (!response.ok) {
        const data = await response.json().catch(() => null) as { error?: unknown; message?: unknown } | null;
        const code = typeof data?.error === "string" ? data.error : undefined;
        const message = typeof data?.message === "string" ? data.message : code;
        throw new ApiError("http", response.status, message, undefined, code);
      }
      if (response.status === 204) return undefined as T;
      return await response.json() as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (controller.signal.aborted) throw new ApiError("timeout");
      // Never include the request headers or token in a surfaced error.
      throw new ApiError("network");
    } finally {
      clearTimeout(timer);
    }
  }

  return { request };
}

export type ApiClient = ReturnType<typeof createApiClient>;
