import { headers } from "next/headers";
import { query } from "./db";
import { EmailError, sendEmail, type EmailTemplate, type EmailTransport } from "./email";
import { log } from "./log";
import { verifiedOwnerEmails } from "./verifiedEmails";

// New-sign-in alerts (#260). They are best-effort: the sign-in has already
// succeeded and created its session, so nothing here may fail or delay it. The
// message carries only the method, a rough client description and the time; it
// never carries a session token, sign-in code or raw User-Agent string.

export type SignInClient = "web" | "mobile";

export type SignInAlertInput = {
  ownerId: string;
  /** Canonical provider name: google, microsoft, apple, email or dev. */
  method: string;
  client: SignInClient;
  userAgent?: string | null;
  /** Clock injection for tests; defaults to now. */
  now?: Date;
  /** Transport injection for tests; defaults to the environment's transport. */
  transport?: EmailTransport;
};

export const SIGN_IN_ALERT_WINDOW_MS = 10 * 60 * 1000;

const METHOD_LABELS: Record<string, string> = {
  google: "Google",
  microsoft: "Microsoft",
  apple: "Apple",
  email: "email code",
  dev: "demo sign-in"
};

const METHOD_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;

function safeMethod(method: string) {
  return METHOD_PATTERN.test(method) ? method : "unknown";
}

export function signInMethodLabel(method: string) {
  return METHOD_LABELS[safeMethod(method)] ?? safeMethod(method);
}

// Turn an untrusted User-Agent into a fixed, short description. Only known
// tokens are read; the raw header is never copied into the message or a log.
export function describeSignInClient(client: SignInClient, userAgent?: string | null) {
  const agent = typeof userAgent === "string" ? userAgent.slice(0, 512) : "";
  const platform = /iPhone|iPad|iPod/i.test(agent)
    ? "iPhone or iPad"
    : /Android/i.test(agent)
      ? "Android"
      : /Windows/i.test(agent)
        ? "Windows"
        : /Macintosh|Mac OS X/i.test(agent)
          ? "macOS"
          : /Linux/i.test(agent)
            ? "Linux"
            : null;
  if (client === "mobile") {
    const app = /okhttp/i.test(agent)
      ? "Android phone app"
      : /CFNetwork|Darwin/i.test(agent)
        ? "iPhone app"
        : "phone app";
    return platform ? `${app} (${platform})` : app;
  }
  const browser = /\bEdg\//i.test(agent)
    ? "Edge"
    : /\bFirefox\//i.test(agent)
      ? "Firefox"
      : /\bChrome\/|CriOS/i.test(agent)
        ? "Chrome"
        : /\bSafari\//i.test(agent)
          ? "Safari"
          : null;
  const described = [browser, platform].filter(Boolean).join(" on ");
  return described || "web browser";
}

function safeTimeZone(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9_+\-/]{1,64}$/.test(value) ? value : null;
}

export function formatSignInTime(at: Date, timeZone?: string | null) {
  const utc = `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const zone = safeTimeZone(timeZone);
  if (!zone) return utc;
  try {
    const local = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(at);
    return `${utc} (${local} ${zone})`;
  } catch {
    return utc;
  }
}

export function accountPageUrl(env: NodeJS.ProcessEnv = process.env) {
  const base = env.NEXTAUTH_URL?.trim().replace(/\/+$/, "");
  if (!base) return null;
  try {
    const url = new URL(base);
    return url.protocol === "http:" || url.protocol === "https:" ? `${url.origin}/account` : null;
  } catch {
    return null;
  }
}

export type NewSignInEmailInput = {
  method: string;
  client: SignInClient;
  userAgent?: string | null;
  at: Date;
  timeZone?: string | null;
  accountUrl?: string | null;
};

export function newSignInEmail(input: NewSignInEmailInput): EmailTemplate {
  const accountUrl = input.accountUrl && /^https?:\/\//.test(input.accountUrl) ? input.accountUrl : null;
  const action = accountUrl
    ? `sign in at ${accountUrl} and review your account, then contact us at admin@praiseloop.ca.`
    : "review your account and contact us at admin@praiseloop.ca.";
  return {
    subject: "New sign-in to your Praise Loop account",
    text: [
      "Someone signed in to your Praise Loop account.",
      "",
      `Method: ${signInMethodLabel(input.method)}`,
      `Client: ${describeSignInClient(input.client, input.userAgent)}`,
      `Time: ${formatSignInTime(input.at, input.timeZone)}`,
      "",
      "If this was you, you can ignore this message.",
      `If this was not you, ${action}`
    ].join("\n")
  };
}

// Verified addresses come from the shared helper (#260/#275), so a security alert
// and a weekly notice can never disagree about who is reachable.
async function businessTimeZone(ownerId: string) {
  const row = (await query<{ timezone: string }>(
    "SELECT timezone FROM businesses WHERE owner_id=$1 ORDER BY created_at, id LIMIT 1",
    [ownerId]
  )).rows[0];
  return row?.timezone ?? null;
}

// Reserve one alert slot per owner and method. The upsert is the rate limit:
// a concurrent or repeated sign-in finds a recent row and changes nothing.
async function reserveAlert(ownerId: string, method: string, at: Date) {
  return !!(await query(
    `INSERT INTO sign_in_alerts(owner_id,method,last_sent_at) VALUES($1,$2,$3)
     ON CONFLICT(owner_id,method) DO UPDATE SET last_sent_at=EXCLUDED.last_sent_at
     WHERE sign_in_alerts.last_sent_at <= EXCLUDED.last_sent_at - make_interval(secs => $4::double precision / 1000)
     RETURNING owner_id`,
    [ownerId, method, at, SIGN_IN_ALERT_WINDOW_MS]
  )).rowCount;
}

function failureReason(error: unknown) {
  return error instanceof EmailError ? error.code : "unexpected";
}

export async function deliverSignInAlert(input: SignInAlertInput): Promise<void> {
  const method = safeMethod(input.method);
  const at = input.now ?? new Date();
  const recipients = await verifiedOwnerEmails(input.ownerId);
  if (recipients.length === 0) {
    log.debug("sign_in_alert_skipped", { method, client: input.client, reason: "no_verified_address" });
    return;
  }
  if (!await reserveAlert(input.ownerId, method, at)) return;

  const template = newSignInEmail({
    method,
    client: input.client,
    userAgent: input.userAgent,
    at,
    timeZone: await businessTimeZone(input.ownerId),
    accountUrl: accountPageUrl()
  });
  for (const to of recipients) {
    try {
      await sendEmail({ to, ...template }, input.transport ? { transport: input.transport } : {});
    } catch (error) {
      // Sanitized: the address, headers and message are never logged.
      log.error("sign_in_alert_failed", { method, client: input.client, reason: failureReason(error) });
    }
  }
}

const pending = new Set<Promise<void>>();

/**
 * Fire a best-effort alert after the session row exists. It never throws and is
 * not awaited by the sign-in path; tests call `flushSignInAlerts()` to wait.
 */
export function notifyNewSignIn(input: SignInAlertInput): void {
  const task = deliverSignInAlert(input)
    .catch(error => log.error("sign_in_alert_failed", { method: safeMethod(input.method), client: input.client, reason: failureReason(error) }))
    .finally(() => { pending.delete(task); });
  pending.add(task);
}

export async function flushSignInAlerts(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

/** The User-Agent of the current Next.js request, or null outside a request. */
export async function callerUserAgent(): Promise<string | null> {
  try {
    return (await headers()).get("user-agent");
  } catch {
    return null;
  }
}

/** Map NextAuth's provider id to the canonical sign-in method name. */
export function canonicalSignInMethod(provider: unknown): string | null {
  if (provider === "azure-ad") return "microsoft";
  return typeof provider === "string" && METHOD_PATTERN.test(provider) ? provider : null;
}
