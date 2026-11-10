import { query, transaction } from "../db";

export type PushMessage = { to: string; title: string; body: string; data: Record<string, unknown> };
export type PushTicket = { status: "ok"; id: string } | { status: "error"; error: string };
export type PushReceipt = { status: "ok" } | { status: "error"; error: string };
export type PushTransport = {
  send(messages: PushMessage[]): Promise<PushTicket[]>;
  receipts(ids: string[]): Promise<Record<string, PushReceipt>>;
};

export const PUSH_TOKEN_PATTERN = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$/;
const MAX_ATTEMPTS = 3, BATCH = 100, RECEIPT_DELAY_MINUTES = 15, RECEIPT_GIVE_UP_HOURS = 24;

// Plain fetch against Expo's push API: bounded by a timeout, no SDK dependency.
export function expoTransport(timeoutMs = 10000): PushTransport {
  const base = "https://exp.host/--/api/v2/push";
  async function call(path: string, body: unknown) {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
    if (process.env.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
    const res = await fetch(`${base}/${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`expo_http_${res.status}`);
    return (await res.json()).data;
  }
  return {
    async send(messages) {
      const data = await call("send", messages);
      if (!Array.isArray(data) || data.length !== messages.length) throw new Error("expo_bad_response");
      return data.map((t: any) => t?.status === "ok" && typeof t.id === "string" ? { status: "ok", id: t.id } : { status: "error", error: String(t?.details?.error ?? "unknown") });
    },
    async receipts(ids) {
      const data = await call("getReceipts", { ids }) ?? {};
      return Object.fromEntries(Object.entries<any>(data).map(([id, r]) => [id, r?.status === "ok" ? { status: "ok" } : { status: "error", error: String(r?.details?.error ?? "unknown") }]));
    },
  };
}

// One definition of a finished weekly batch: at least one reviewable draft and no
// job still pending, retrying or running. Push and the weekly email (#275) share
// it so the two notifications never disagree about when "posts are ready".
export type ReadyPeriod = {
  business_id: string;
  /** `YYYY-MM-DD`, so callers and SQL parameters never depend on the process timezone. */
  period_start: string;
  count: number;
  owner_id: string;
  name: string;
};

export async function readyPeriods(now = new Date()): Promise<ReadyPeriod[]> {
  return (await query<ReadyPeriod>(`SELECT p.business_id, to_char(p.period_start, 'YYYY-MM-DD') AS period_start, c.n AS count,
      b.owner_id, b.name
    FROM generation_periods p
    JOIN businesses b ON b.id = p.business_id AND b.owner_id IS NOT NULL
    CROSS JOIN LATERAL (SELECT count(*)::int n FROM generation_jobs j JOIN draft_posts d ON d.id = j.draft_id
      WHERE j.business_id = p.business_id AND j.period_start = p.period_start AND j.state = 'complete' AND d.status = 'draft') c
    WHERE p.period_start >= $1::date - 14 AND p.allocated > 0 AND c.n > 0
      AND (p.allocated >= p.target OR p.reason = 'reviews_exhausted')
      AND NOT EXISTS (SELECT 1 FROM generation_jobs j WHERE j.business_id = p.business_id AND j.period_start = p.period_start AND j.state IN ('pending','retry','running'))`, [now])).rows;
}

// One delivery row per device per business-period; ON CONFLICT makes re-runs and restarts no-ops.
export async function enqueuePostsReady(now = new Date()) {
  const ready = await readyPeriods(now);
  if (!ready.length) return 0;
  const res = await query(`INSERT INTO push_deliveries(business_id, period_start, token, count)
    SELECT r.business_id, r.period_start, t.token, r.count
    FROM unnest($1::bigint[], $2::date[], $3::int[]) AS r(business_id, period_start, count)
    JOIN device_push_tokens t ON t.owner_id = (SELECT b.owner_id FROM businesses b WHERE b.id = r.business_id)
    ON CONFLICT DO NOTHING`,
    [ready.map(r => r.business_id), ready.map(r => r.period_start), ready.map(r => r.count)]);
  return res.rowCount ?? 0;
}

const removeToken = (token: string) => query("DELETE FROM device_push_tokens WHERE token = $1", [token]);

export async function sendPending(transport: PushTransport, now = new Date()) {
  // Only devices still registered to the business's owner are claimed: a token that moved to another
  // owner (shared device) must not receive the previous owner's queued notifications.
  // Claiming bumps attempts and pushes next_at out, so a crash mid-send is retried
  // later (bounded) instead of immediately and never loops forever.
  const claimed = (await query(`UPDATE push_deliveries d SET attempts = attempts + 1, next_at = $1::timestamptz + interval '5 minutes'
    WHERE d.id IN (SELECT d2.id FROM push_deliveries d2 WHERE d2.state IN ('pending','retry') AND d2.next_at <= $1 AND d2.attempts < $2
      AND EXISTS (SELECT 1 FROM device_push_tokens t JOIN businesses b ON b.id = d2.business_id WHERE t.token = d2.token AND t.owner_id = b.owner_id) ORDER BY d2.id LIMIT $3 FOR UPDATE SKIP LOCKED)
    RETURNING d.id, d.token, d.count, d.attempts, d.business_id`, [now, MAX_ATTEMPTS, BATCH])).rows;
  if (!claimed.length) return { sent: 0, failed: 0 };
  const names = (await query("SELECT id, name FROM businesses WHERE id = ANY($1)", [claimed.map(r => r.business_id)])).rows;
  const name = new Map(names.map(r => [String(r.id), String(r.name)]));
  // Only a count, the business name and a deep link: never review text or captions.
  const messages = claimed.map(r => ({ to: r.token, title: name.get(String(r.business_id)) ?? "Praise Loop",
    body: `${r.count} ${r.count === 1 ? "post is" : "posts are"} ready to review.`,
    data: { count: r.count, businessId: Number(r.business_id), url: `praiseloop://queue?businessId=${r.business_id}` } }));
  let tickets: PushTicket[] | null = null;
  try { tickets = await transport.send(messages); } catch { console.error("push_send_failed"); }
  let sent = 0, failed = 0;
  for (const [i, row] of claimed.entries()) {
    const ticket = tickets?.[i];
    if (ticket?.status === "ok") {
      sent++;
      await query("UPDATE push_deliveries SET state='sent', ticket_id=$2, sent_at=$3, error_code=NULL WHERE id=$1", [row.id, ticket.id, now]);
    } else if (ticket?.error === "DeviceNotRegistered") {
      failed++;
      await removeToken(row.token);
      await query("UPDATE push_deliveries SET state='invalid_token', error_code='DeviceNotRegistered' WHERE id=$1", [row.id]);
    } else {
      failed++;
      const code = ticket ? ticket.error.slice(0, 64) : "provider_error";
      await query("UPDATE push_deliveries SET state=CASE WHEN attempts>=$2 THEN 'failed' ELSE 'retry' END, error_code=$3, next_at=$4::timestamptz+(60*power(2,attempts-1))*interval '1 second' WHERE id=$1", [row.id, MAX_ATTEMPTS, code, now]);
    }
  }
  return { sent, failed };
}

export async function checkReceipts(transport: PushTransport, now = new Date()) {
  await query(`UPDATE push_deliveries SET state='delivered', error_code='receipt_expired' WHERE state='sent' AND sent_at < $1::timestamptz - ($2 || ' hours')::interval`, [now, String(RECEIPT_GIVE_UP_HOURS)]);
  const due = (await query(`SELECT id, token, ticket_id FROM push_deliveries WHERE state='sent' AND ticket_id IS NOT NULL
    AND sent_at <= $1::timestamptz - ($2 || ' minutes')::interval ORDER BY id LIMIT $3`, [now, String(RECEIPT_DELAY_MINUTES), BATCH])).rows;
  if (!due.length) return { removed: 0 };
  let receipts: Record<string, PushReceipt>;
  try { receipts = await transport.receipts(due.map(r => r.ticket_id)); } catch { console.error("push_receipts_failed"); return { removed: 0 }; }
  let removed = 0;
  for (const row of due) {
    const receipt = receipts[row.ticket_id];
    if (!receipt) continue;
    if (receipt.status === "ok") await query("UPDATE push_deliveries SET state='delivered' WHERE id=$1", [row.id]);
    else if (receipt.error === "DeviceNotRegistered") {
      removed++;
      await transaction(async c => {
        await c.query("DELETE FROM device_push_tokens WHERE token=$1", [row.token]);
        await c.query("UPDATE push_deliveries SET state='invalid_token', error_code='DeviceNotRegistered' WHERE id=$1", [row.id]);
      });
    } else await query("UPDATE push_deliveries SET state='failed', error_code=$2 WHERE id=$1", [row.id, receipt.error.slice(0, 64)]);
  }
  return { removed };
}

export async function pushTick(transport: PushTransport = expoTransport(), now = new Date()) {
  const enqueued = await enqueuePostsReady(now);
  return { enqueued, ...await sendPending(transport, now), ...await checkReceipts(transport, now) };
}
