/**
 * Transactional email behind a small transport interface (#155).
 *
 * There are two transports: `fake`, which records messages in an in-memory
 * outbox and logs them (for tests and the dev stack, and never talks to a
 * network), and `resend`, a plain `fetch` call to Resend's send endpoint.
 * Nothing is sent in tests or in a non-production process unless Resend is
 * explicitly configured. In production, a missing setting fails closed with
 * `EmailError` (`email_unavailable`) instead of crashing at import time.
 *
 * Sign-in code callers must answer identically whether or not an address has
 * an account; this module never looks accounts up and its errors never include
 * the recipient. See docs/decisions.md (2026-10-30) and docs/integrations.md.
 */

export type EmailTransportName = "fake" | "resend";
export type EmailErrorCode =
  | "email_unavailable"
  | "email_invalid"
  | "email_throttled"
  | "email_auth"
  | "email_sender"
  | "email_provider"
  | "email_timeout";

export class EmailError extends Error {
  constructor(
    public readonly code: EmailErrorCode,
    message: string,
    public readonly retryAfterMs = 0,
  ) {
    super(message);
    this.name = "EmailError";
  }
}

export type EmailMessage = { to: string; subject: string; text: string };
export type EmailEnvelope = EmailMessage & { from: string };
export type EmailDelivery = { transport: EmailTransportName; accepted: boolean; id?: string };

export interface EmailTransport {
  readonly name: EmailTransportName;
  /** Default sender for this transport; a `sendEmail` call may override it. */
  readonly from: string;
  send(envelope: EmailEnvelope, options?: { idempotencyKey?: string }): Promise<EmailDelivery>;
}

/** Local/dev sender when `EMAIL_FROM` is unset. Never used by the real transport. */
export const DEV_EMAIL_FROM = "Praise Loop <no-reply@praiseloop.invalid>";
const RESEND_ENDPOINT = "https://api.resend.com/emails";
const MAX_SUBJECT = 200;
const MAX_TEXT = 20_000;

const ADDRESS = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

function invalid(detail: string): EmailError {
  return new EmailError("email_invalid", `email_invalid: ${detail}`);
}

function unavailable(detail: string): EmailError {
  return new EmailError("email_unavailable", `email_unavailable: ${detail}`);
}

/** Accepts `name@example.com` or `Name <name@example.com>`, rejecting header injection. */
function assertSender(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) throw unavailable("EMAIL_FROM is empty or contains a line break");
  const match = /^(?:[^<>]*<([^<>]+)>|([^<>]+))$/.exec(trimmed);
  const address = match?.[1] ?? match?.[2];
  if (!address || !ADDRESS.test(address.trim())) {
    throw unavailable("EMAIL_FROM must be an email address, optionally as `Name <address>`");
  }
  return trimmed;
}

function assertRecipient(value: unknown): string {
  if (typeof value !== "string") throw invalid("recipient must be a single email address");
  const trimmed = value.trim();
  // One bare address only: no display name, comma list, or extra header.
  if (!trimmed || trimmed.length > 254 || !ADDRESS.test(trimmed)) {
    throw invalid("recipient must be a single bare email address");
  }
  return trimmed;
}

function normalise(message: EmailMessage, from: string): EmailEnvelope {
  const subject = typeof message.subject === "string" ? message.subject.trim() : "";
  const text = typeof message.text === "string" ? message.text : "";
  if (!subject) throw invalid("subject is required");
  if (subject.length > MAX_SUBJECT) throw invalid(`subject must be at most ${MAX_SUBJECT} characters`);
  if (/[\r\n]/.test(subject)) throw invalid("subject must be a single line");
  if (!text.trim()) throw invalid("text is required");
  if (text.length > MAX_TEXT) throw invalid(`text must be at most ${MAX_TEXT} characters`);
  return { from: assertSender(from), to: assertRecipient(message.to), subject, text };
}

// --- Fake transport -------------------------------------------------------

export type OutboxEntry = EmailEnvelope & { sentAt: string };
const outbox: OutboxEntry[] = [];
const OUTBOX_LIMIT = 100;

/** Messages recorded by the fake transport in this process, newest last. */
export function emailOutbox(): readonly OutboxEntry[] {
  return [...outbox];
}

export function clearEmailOutbox(): void {
  outbox.length = 0;
}

export type FakeEmailOptions = {
  from?: string;
  logger?: (line: string) => void;
  now?: () => Date;
};

/**
 * Records messages and logs them for a developer to read. It never performs
 * network I/O and is never selected by default in a production process.
 */
export function fakeEmailTransport(options: FakeEmailOptions = {}): EmailTransport {
  const from = assertSender(options.from ?? DEV_EMAIL_FROM);
  const logger = options.logger ?? ((line: string) => console.info(line));
  const now = options.now ?? (() => new Date());
  let sequence = 0;
  return {
    name: "fake",
    from,
    async send(envelope) {
      const entry: OutboxEntry = { ...envelope, sentAt: now().toISOString() };
      outbox.push(entry);
      if (outbox.length > OUTBOX_LIMIT) outbox.shift();
      // The body is the "outbox" in development, so the sign-in code is visible
      // here. Only the fake transport logs it, and it never runs in production.
      logger(`email_outbox ${JSON.stringify(entry)}`);
      return { transport: "fake", accepted: true, id: `fake-${++sequence}` };
    },
  };
}

// --- Resend transport -----------------------------------------------------

export type ResendOptions = {
  apiKey: string;
  from: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  endpoint?: string;
};

export function resendTransport(options: ResendOptions): EmailTransport {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw unavailable("RESEND_API_KEY is missing");
  const from = assertSender(options.from);
  const call = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const endpoint = options.endpoint ?? RESEND_ENDPOINT;

  return {
    name: "resend",
    from,
    async send(envelope, sendOptions = {}) {
      const headers: Record<string, string> = {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      };
      if (sendOptions.idempotencyKey) headers["idempotency-key"] = sendOptions.idempotencyKey;
      let response: Response;
      try {
        response = await call(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ from: envelope.from, to: [envelope.to], subject: envelope.subject, text: envelope.text }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // Never surface the provider/network detail, and never log the message.
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
          throw new EmailError("email_timeout", "email_timeout: the email provider did not answer in time");
        }
        throw new EmailError("email_provider", "email_provider: the email provider could not be reached");
      }
      if (!response.ok) {
        if (response.status === 401) {
          throw new EmailError("email_auth", "email_auth: the email provider rejected the API key");
        }
        // Resend answers 403 when the sender is refused, for example an unverified EMAIL_FROM domain.
        if (response.status === 403) {
          // A 403 can also mean the key itself is inactive or suspended. Only the provider's error name
          // is read; the message and body are never kept.
          const name = await response.json().then((body: { name?: unknown } | null) => body?.name, () => undefined);
          if (name === "restricted_api_key" || name === "suspended_api_key" || name === "invalid_api_key") {
            throw new EmailError("email_auth", "email_auth: the email provider rejected the API key");
          }
          throw new EmailError("email_sender", "email_sender: the email provider refused the sender; check that the EMAIL_FROM domain is verified");
        }
        if (response.status === 429) {
          throw new EmailError("email_throttled", "email_throttled: the email provider rate limited the request", retryAfterMs(response.headers.get("retry-after")));
        }
        if (response.status === 400 || response.status === 422) {
          throw invalid("the email provider rejected the message");
        }
        throw new EmailError("email_provider", `email_provider: the email provider answered ${response.status}`);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new EmailError("email_provider", "email_provider: unreadable response from the email provider");
      }
      const id = (body as { id?: unknown } | null)?.id;
      if (typeof id !== "string" || !id) throw new EmailError("email_provider", "email_provider: the email provider returned no message id");
      return { transport: "resend", accepted: true, id };
    },
  };
}

function retryAfterMs(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 3_600_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(Math.max(date - Date.now(), 0), 3_600_000) : 0;
}

// --- Configuration --------------------------------------------------------

export function resolveEmailTransportName(env: NodeJS.ProcessEnv = process.env): EmailTransportName {
  // Compose passes unset variables as empty strings, so blank must mean "default".
  const configured = env.EMAIL_TRANSPORT?.trim().toLowerCase() || undefined;
  if (configured && configured !== "fake" && configured !== "resend") {
    throw unavailable("EMAIL_TRANSPORT must be `fake` or `resend`");
  }
  const name = (configured as EmailTransportName | undefined) ?? (env.NODE_ENV === "production" ? "resend" : "fake");
  if (name === "fake" && env.NODE_ENV === "production") {
    throw unavailable("the fake email transport is not allowed in production");
  }
  return name;
}

/** The transport selected by the environment. Throws a clear `EmailError`, never at import time. */
export function getEmailTransport(env: NodeJS.ProcessEnv = process.env): EmailTransport {
  const name = resolveEmailTransportName(env);
  if (name === "fake") return fakeEmailTransport({ from: env.EMAIL_FROM?.trim() || DEV_EMAIL_FROM });
  const from = env.EMAIL_FROM?.trim();
  const apiKey = env.RESEND_API_KEY?.trim();
  const missing = [!from && "EMAIL_FROM", !apiKey && "RESEND_API_KEY"].filter(Boolean).join(" and ");
  if (missing) throw unavailable(`set ${missing} to send real email, or EMAIL_TRANSPORT=fake outside production`);
  return resendTransport({ from: from as string, apiKey: apiKey as string });
}

// --- Throttle -------------------------------------------------------------

export type EmailThrottlePolicy = {
  perRecipient: number;
  perSender: number;
  windowMs: number;
  /** Bound on remembered recipients on a long-lived process (default 10,000). */
  maxRecipientKeys?: number;
};

/** Per-process default: enough for a few sign-in attempts, not a spam cannon. */
export const DEFAULT_EMAIL_THROTTLE: EmailThrottlePolicy = {
  perRecipient: 5,
  perSender: 100,
  windowMs: 60 * 60 * 1000,
  maxRecipientKeys: 10_000,
};

/**
 * Sliding-window throttle per recipient and per sender. It is process-local:
 * the web and worker each enforce their own budget, which is documented in
 * docs/integrations.md. Tests inject a clock.
 */
export class EmailThrottle {
  private readonly hits = new Map<string, number[]>();
  private readonly maxRecipientKeys: number;

  constructor(
    private readonly policy: EmailThrottlePolicy = DEFAULT_EMAIL_THROTTLE,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.maxRecipientKeys = policy.maxRecipientKeys ?? 10_000;
  }

  take(recipient: string, sender: string): void {
    const now = this.now();
    const cutoff = now - this.policy.windowMs;
    const recipientKey = `to:${recipient}`;
    const senderKey = `from:${sender}`;
    const recipientHits = this.recent(recipientKey, cutoff);
    const senderHits = this.recent(senderKey, cutoff);
    if (recipientHits.length >= this.policy.perRecipient) {
      throw new EmailError("email_throttled", "email_throttled: too many messages to this recipient", this.retryAfter(recipientHits, now));
    }
    if (senderHits.length >= this.policy.perSender) {
      throw new EmailError("email_throttled", "email_throttled: the sender's hourly email budget is used up", this.retryAfter(senderHits, now));
    }
    recipientHits.push(now);
    senderHits.push(now);
    this.hits.set(recipientKey, recipientHits);
    this.hits.set(senderKey, senderHits);
    this.evict(cutoff, recipientKey);
  }

  /** Recent hits for a key; expired entries are removed instead of retained. */
  private recent(key: string, cutoff: number): number[] {
    const hits = (this.hits.get(key) ?? []).filter((at) => at > cutoff);
    if (!hits.length) this.hits.delete(key);
    return hits;
  }

  /**
   * Drop expired recipients when the map is large, then the oldest remaining
   * recipients if still over the cap. Sender keys stay so the sender budget
   * cannot be reset by churn in the recipient map.
   */
  private evict(cutoff: number, keep: string): void {
    if (this.hits.size <= this.maxRecipientKeys + 1) return;
    for (const [key, hits] of this.hits) {
      if (key.startsWith("to:") && key !== keep && !hits.some((at) => at > cutoff)) this.hits.delete(key);
    }
    while (this.hits.size > this.maxRecipientKeys + 1) {
      const oldest = [...this.hits.keys()].find((key) => key.startsWith("to:") && key !== keep);
      if (!oldest) break;
      this.hits.delete(oldest);
    }
  }

  private retryAfter(hits: number[], now: number): number {
    return Math.max(hits[0] + this.policy.windowMs - now, 0);
  }
}

let processThrottle: EmailThrottle | undefined;
export function defaultEmailThrottle(): EmailThrottle {
  return (processThrottle ??= new EmailThrottle());
}

// --- Send -----------------------------------------------------------------

export type SendEmailOptions = {
  transport?: EmailTransport;
  throttle?: EmailThrottle;
  from?: string;
  idempotencyKey?: string;
};

export async function sendEmail(message: EmailMessage, options: SendEmailOptions = {}): Promise<EmailDelivery> {
  const transport = options.transport ?? getEmailTransport();
  const envelope = normalise(message, options.from ?? transport.from);
  // Case-insensitive keys so `Owner@...` cannot dodge the recipient budget.
  (options.throttle ?? defaultEmailThrottle()).take(envelope.to.toLowerCase(), envelope.from.toLowerCase());
  return transport.send(envelope, { idempotencyKey: options.idempotencyKey });
}

// --- Templates ------------------------------------------------------------

export type EmailTemplate = Pick<EmailMessage, "subject" | "text">;

/**
 * A short plain-text sign-in code. No HTML, link, image, tracking pixel or
 * review content; the code stays in the body and out of the subject line, and
 * it is only read from the fake outbox or the recipient's inbox.
 */
export function oneTimeCodeEmail(code: string, options: { minutes?: number } = {}): EmailTemplate {
  if (!/^\d{6}$/.test(code)) throw invalid("a one-time code is six digits");
  const minutes = options.minutes ?? 10;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw invalid("code lifetime is 1 to 60 minutes");
  return {
    subject: "Your Praise Loop sign-in code",
    text: [
      `Your Praise Loop sign-in code is ${code}.`,
      "",
      `It expires in ${minutes} minute${minutes === 1 ? "" : "s"} and can be used once.`,
      "If you did not ask for this code, you can ignore this message.",
    ].join("\n"),
  };
}

/**
 * A confirmation code for a sensitive step in an already signed-in session
 * (#221). It is deliberately not a sign-in code and never says what action
 * will follow, so an intercepted message reveals nothing about the owner's plan.
 */
export function stepUpCodeEmail(code: string, options: { minutes?: number } = {}): EmailTemplate {
  if (!/^\d{6}$/.test(code)) throw invalid("a one-time code is six digits");
  const minutes = options.minutes ?? 10;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw invalid("code lifetime is 1 to 60 minutes");
  return {
    subject: "Your Praise Loop confirmation code",
    text: [
      `Your Praise Loop confirmation code is ${code}.`,
      "",
      `It expires in ${minutes} minute${minutes === 1 ? "" : "s"} and can be used once.`,
      "Use it only if you started this step yourself. If you did not, you can ignore this message.",
    ].join("\n"),
  };
}

/**
 * A single-use password reset link (#159). The token is the secret; the email
 * never contains a password. A malformed URL is refused rather than emailed.
 */
export function passwordResetEmail(resetUrl: string, options: { minutes?: number } = {}): EmailTemplate {
  const minutes = options.minutes ?? 30;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw invalid("reset lifetime is 1 to 60 minutes");
  let url: URL;
  try {
    url = new URL(resetUrl);
  } catch {
    throw invalid("reset link must be a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw invalid("reset link must be http(s)");
  return {
    subject: "Reset your Praise Loop password",
    text: [
      "Someone asked to reset the password for your Praise Loop account.",
      "",
      `Open this link to choose a new password. It expires in ${minutes} minutes and can be used once:`,
      resetUrl,
      "",
      "If you did not ask for this, you can ignore this message. Your current password still works.",
    ].join("\n"),
  };
}

/**
 * The matching message for an address without a password credential (#159). It
 * is sent so the reset request costs the same work and time for every address;
 * it contains no link or token and changes nothing.
 */
export function passwordResetNoAccountEmail(): EmailTemplate {
  return {
    subject: "Reset your Praise Loop password",
    text: [
      "Someone asked to reset the password for this email address.",
      "",
      "There is no Praise Loop password account for this address, so nothing changed.",
      "If you sign in with Google, Apple, Microsoft or an email code, those methods still work.",
      "",
      "If you did not ask for this, you can ignore this message.",
    ].join("\n"),
  };
}

/**
 * Sent when repeated failed password attempts lock an account (#159). It never
 * contains a password, token or IP address; the owner resets through the
 * normal request flow if the attempts were not theirs.
 */
export function passwordLockedEmail(options: { resetUrl?: string | null; minutes: number }): EmailTemplate {
  const minutes = options.minutes;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) throw invalid("lock duration is 1 minute to 24 hours");
  const action = options.resetUrl
    ? `If this was not you, reset your password now: ${options.resetUrl}`
    : "If this was not you, use the Forgot password link on the sign-in page to reset it.";
  return {
    subject: "Praise Loop sign-in was locked after failed attempts",
    text: [
      "Someone entered the wrong password for your Praise Loop account too many times.",
      "",
      `Sign-in with that password is locked for about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      "Your account and data are unchanged.",
      "",
      action,
    ].join("\n"),
  };
}
