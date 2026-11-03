// One small structured logger for the web app and the worker (docs/development.md, "Logging").
//
// Two modes. Production (`APP_ENV` unset or anything but dev) is quiet: warnings, errors and
// notable activity. Development (`APP_ENV=dev`, or `LOG_LEVEL=debug`) is verbose: every API
// request, every posting decision, every failed step with its cause. `LOG_LEVEL` overrides either.
//
// Logs never carry credentials or content. Fields are scrubbed by name (tokens, secrets, OAuth
// code/state, captions, quotes, emails, bodies...) and any long token-like string is replaced, so a
// careless call site still cannot leak. Log ids, states, statuses and error codes, not text.

export type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
type Env = Record<string, string | undefined>;

export function logLevel(env: Env = process.env): Level {
  const explicit = (env.LOG_LEVEL ?? "").trim().toLowerCase();
  if (explicit in order) return explicit as Level;
  const mode = (env.APP_ENV ?? "").trim().toLowerCase();
  return mode === "dev" || mode === "development" ? "debug" : "info";
}
export function isDevLogging(env: Env = process.env) { return logLevel(env) === "debug"; }

const SENSITIVE_KEY = /(^|_|-)(token|secret|password|authorization|cookie|verifier|caption|quote|text|email|body|credential|apikey|key|code|state|cipher|hash)(_|-|$)|^(code|state)$|(token|secret|password|verifier|authorization|cookie|caption|quote|email|credential|apikey)/i;
const TOKEN_LIKE = /[A-Za-z0-9_\-+/=]{32,}/g;

export function scrub(value: string, limit = 200): string {
  return value.replace(TOKEN_LIKE, "[redacted]").slice(0, limit);
}

export type Fields = Record<string, unknown>;
export function safeFields(fields: Fields): Record<string, string | number | boolean | null | (string | number | boolean | null)[]> {
  const out: Record<string, string | number | boolean | null | (string | number | boolean | null)[]> = {};
  const primitive = (v: unknown) => typeof v === "string" ? scrub(v) : typeof v === "number" || typeof v === "boolean" || v === null ? v : undefined;
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEY.test(key)) { out[key] = "[redacted]"; continue; }
    const one = primitive(value);
    if (one !== undefined) { out[key] = one; continue; }
    if (Array.isArray(value)) { out[key] = value.slice(0, 20).map((v) => primitive(v) ?? "[object]"); continue; }
    if (value !== undefined) out[key] = "[object]";
  }
  return out;
}

/** Name and short code of an error always; its message only in development, scrubbed. */
export function errorFields(error: unknown, env: Env = process.env): Fields {
  if (!(error instanceof Error)) return { errorName: typeof error };
  const code = (error as { code?: unknown }).code;
  const fields: Fields = { errorName: error.name };
  if (typeof code === "string" || typeof code === "number") fields.errorCode = String(code).slice(0, 40);
  if (isDevLogging(env)) fields.errorMessage = scrub(error.message);
  return fields;
}

export function logAt(level: Level, event: string, fields: Fields = {}, env: Env = process.env, write?: (line: string, level: Level) => void) {
  if (order[level] < order[logLevel(env)]) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...safeFields(fields) });
  if (write) { write(line, level); return; }
  (order[level] >= order.warn ? console.error : console.log)(line);
}

export const log = {
  debug: (event: string, fields?: Fields) => logAt("debug", event, fields),
  info: (event: string, fields?: Fields) => logAt("info", event, fields),
  warn: (event: string, fields?: Fields) => logAt("warn", event, fields),
  error: (event: string, fields?: Fields) => logAt("error", event, fields)
};

/** A periodic tick is a debug line when nothing happened and an info line when something did. */
export function logTick(event: string, result: Fields) {
  const active = Object.values(result).some((v) => typeof v === "number" && v > 0);
  logAt(active ? "info" : "debug", event, result);
}
