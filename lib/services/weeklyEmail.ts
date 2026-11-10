import { query } from "../db";
import { EmailError, getEmailTransport, sendEmail, type EmailTemplate, type EmailTransport } from "../email";
import { log } from "../log";
import { primaryVerifiedOwnerEmail } from "../verifiedEmails";
import { readyPeriods } from "./push";

// The weekly "your posts are ready" email (#275). It is the web-first replacement
// for the push notification while the native app is parked: the worker calls this
// at the same point it calls the push tick, and both read the same completed-batch
// definition (readyPeriods in ./push). Sending is best-effort: generation has
// already finished, so a transport, database or configuration problem is logged
// and swallowed, never allowed to fail the batch.

const MAX_BUSINESS_NAME = 120;

function appBaseUrl(env: NodeJS.ProcessEnv = process.env) {
  const base = env.NEXTAUTH_URL?.trim().replace(/\/+$/, "");
  if (!base) return null;
  try {
    const url = new URL(base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function approvalQueueUrl(base: string, businessId: string | number) {
  return `${base}/approval?businessId=${businessId}`;
}

export function weeklyEmailSettingsUrl(base: string) {
  return `${base}/account#weekly-email`;
}

function safeBusinessName(value: string) {
  return value.replace(/[\r\n]+/g, " ").replace(/\p{Cc}/gu, "").trim().slice(0, MAX_BUSINESS_NAME) || "your business";
}

export type WeeklyReadyEmailInput = {
  businessName: string;
  count: number;
  queueUrl: string;
  settingsUrl: string;
};

export function weeklyReadyEmail(input: WeeklyReadyEmailInput): EmailTemplate {
  const count = Number.isSafeInteger(input.count) && input.count > 0 ? input.count : 1;
  const business = safeBusinessName(input.businessName);
  const posts = count === 1 ? "1 post is" : `${count} posts are`;
  return {
    subject: `${count} ${count === 1 ? "post is" : "posts are"} ready to review for ${business}`,
    text: [
      `${posts} ready to review for ${business}.`,
      "",
      `Review and approve them: ${input.queueUrl}`,
      "",
      "You are getting this email because the weekly \"posts are ready\" email is on for your Praise Loop account.",
      `Turn it off any time: ${input.settingsUrl}`
    ].join("\n")
  };
}

function failureReason(error: unknown) {
  return error instanceof EmailError ? error.code : "unexpected";
}

export type WeeklyEmailOptions = {
  /** Tests inject a fake transport; the worker uses the configured one. */
  transport?: EmailTransport;
  now?: Date;
};

export type WeeklyEmailResult = { sent: number };

/**
 * Send at most one email per business per weekly period. The delivery row is the
 * claim, so two workers or a restart cannot send twice. A provider failure is
 * recorded as `failed` and never released: the email is best-effort, and retrying
 * forever would be noise. Returns how many messages were accepted.
 */
export async function emailTick(options: WeeklyEmailOptions = {}): Promise<WeeklyEmailResult> {
  const now = options.now ?? new Date();
  const ready = await readyPeriods(now);
  if (!ready.length) return { sent: 0 };

  const base = appBaseUrl();
  if (!base) {
    log.debug("weekly_email_skipped", { reason: "no_base_url" });
    return { sent: 0 };
  }

  let transport: EmailTransport;
  try {
    transport = options.transport ?? getEmailTransport();
  } catch (error) {
    log.error("weekly_email_failed", { reason: failureReason(error) });
    return { sent: 0 };
  }

  const enabled = new Set((await query<{ id: string }>(
    "SELECT id FROM auth_users WHERE id = ANY($1) AND weekly_email_enabled",
    [[...new Set(ready.map(row => row.owner_id))]]
  )).rows.map(row => row.id));

  let sent = 0;
  for (const row of ready) {
    if (!enabled.has(row.owner_id)) continue;
    const businessId = Number(row.business_id);
    const to = await primaryVerifiedOwnerEmail(row.owner_id);
    if (!to) {
      log.debug("weekly_email_skipped", { businessId, reason: "no_verified_address" });
      continue;
    }
    const claimed = await query(
      "INSERT INTO weekly_email_deliveries(business_id, period_start) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING business_id",
      [row.business_id, row.period_start]
    );
    if (!claimed.rowCount) continue;
    try {
      const delivery = await sendEmail(
        { to, ...weeklyReadyEmail({
          businessName: row.name,
          count: row.count,
          queueUrl: approvalQueueUrl(base, row.business_id),
          settingsUrl: weeklyEmailSettingsUrl(base)
        }) },
        { transport, idempotencyKey: `weekly-ready-${row.business_id}-${row.period_start}` }
      );
      await query(
        "UPDATE weekly_email_deliveries SET state='sent', message_id=$3 WHERE business_id=$1 AND period_start=$2",
        [row.business_id, row.period_start, delivery.id ?? null]
      );
      sent++;
      log.info("weekly_email_sent", { businessId, count: row.count });
    } catch (error) {
      // Best-effort: keep the claim (so nothing retries this period) and never log the address.
      await query(
        "UPDATE weekly_email_deliveries SET state='failed' WHERE business_id=$1 AND period_start=$2",
        [row.business_id, row.period_start]
      ).catch(() => undefined);
      log.error("weekly_email_failed", { businessId, reason: failureReason(error) });
    }
  }
  return { sent };
}
