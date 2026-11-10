import { createHash } from "node:crypto";
import { log } from "./log";

// Breached-password check (#286) through Have I Been Pwned's k-anonymity range
// API. Only the first five hex characters of the SHA-1 leave the server; the
// remaining 35 are compared locally. A lookup that is unavailable, slow or
// misconfigured fails open: the password rules still apply and the attempt is
// allowed. No new dependency: Node's crypto and the global fetch do the work.

export const BREACHED_PASSWORD_MESSAGE = "This password has appeared in a data breach. Choose a different one.";
export const BREACH_CHECK_TIMEOUT_MS = 2000;
export const BREACH_RANGE_URL = "https://api.pwnedpasswords.com/range/";
const USER_AGENT = "PraiseLoop";
// A range response is a few tens of kilobytes. Cap it so a broken or hostile
// endpoint cannot make the server buffer an unbounded body.
const MAX_RANGE_BYTES = 512 * 1024;

export type PasswordBreachResult = "clear" | "breached" | "disabled" | "unavailable";

/** `off`/`false`/`0`/`no` disable it; `on`/`true`/`1`/`yes` enable it. Unset follows production. */
export function passwordBreachCheckEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = (env.PASSWORD_BREACH_CHECK ?? "").trim().toLowerCase();
  if (["off", "false", "0", "no"].includes(value)) return false;
  if (["on", "true", "1", "yes"].includes(value)) return true;
  return env.NODE_ENV === "production";
}

export type BreachCheckOptions = {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
};

// Tests inject a fake fetcher. The default stays the global fetch, so no test
// and no development process reaches the real API unless its switch is on.
let injectedFetcher: typeof fetch | null = null;

/** Test-only seam: pass null to restore the real fetch. */
export function setPasswordBreachFetcherForTests(fetcher: typeof fetch | null) {
  injectedFetcher = fetcher;
}

function logUnavailable(fields: { status?: number; reason?: string }) {
  // Never the password, the hash, the prefix or the response body.
  log.warn("password_breach_check_unavailable", fields);
}

/** Read at most MAX_RANGE_BYTES; null means the body was too large. */
async function readBounded(response: Response): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RANGE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Check one password. `breached` is the only result that must reject the
 * password; `disabled` and `unavailable` are the documented fail-open cases.
 */
export async function checkPasswordBreach(
  password: string,
  options: BreachCheckOptions = {}
): Promise<PasswordBreachResult> {
  if (!passwordBreachCheckEnabled(options.env)) return "disabled";

  const sha1 = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? BREACH_CHECK_TIMEOUT_MS);

  try {
    const fetcher = options.fetcher ?? injectedFetcher ?? fetch;
    const response = await fetcher(`${BREACH_RANGE_URL}${prefix}`, {
      headers: { "Add-Padding": "true", "User-Agent": USER_AGENT },
      redirect: "error",
      signal: controller.signal
    });
    if (!response.ok) {
      logUnavailable({ status: response.status });
      return "unavailable";
    }
    const body = await readBounded(response);
    if (body === null) {
      logUnavailable({ reason: "response_too_large" });
      return "unavailable";
    }
    // One `SUFFIX:COUNT` per line. Add-Padding returns filler entries with a
    // zero count; only a matching suffix with a positive count is a breach.
    for (const line of body.split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const candidate = line.slice(0, colon).trim().toUpperCase();
      if (candidate !== suffix) continue;
      const count = Number.parseInt(line.slice(colon + 1).trim(), 10);
      if (Number.isFinite(count) && count > 0) return "breached";
    }
    return "clear";
  } catch (error) {
    logUnavailable({ reason: error instanceof Error ? error.name : "unknown" });
    return "unavailable";
  } finally {
    clearTimeout(timeout);
  }
}
