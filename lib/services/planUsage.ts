import { query } from "../db";
import { validTimezone } from "../timezone";
import { businessAllowance, entitlementsFor, type Entitlements } from "./entitlements";
import { generationWeek } from "./generation";
import type { EntitlementsWithUsage, WeeklyUsage } from "../planDisplay";

function addDays(day: string, days: number) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function offsetMs(at: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at);
  const get = (type: string) => Number(parts.find(p => p.type === type)!.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(at.getTime() / 1000) * 1000;
}

// The UTC instant at which `day` 00:00 happens in `timezone`. The offset is read at the
// guess and again at the corrected time so a daylight-saving change cannot skew it.
export function localMidnight(day: string, timezone: string) {
  const naive = Date.parse(`${day}T00:00:00Z`);
  const first = naive - offsetMs(new Date(naive), timezone);
  return new Date(naive - offsetMs(new Date(first), timezone));
}

export function weeklyUsage(
  business: { id: number | string; name: string; timezone: string; weekly_target: number },
  allocated: number,
  entitlements: Entitlements,
  now = new Date(),
  paused = false
): WeeklyUsage {
  const timezone = validTimezone(business.timezone) ? business.timezone : "UTC";
  const weekStart = generationWeek(now, timezone);
  const resetsOn = addDays(weekStart, 7);
  const target = Math.min(business.weekly_target, entitlements.limits.postsPerWeek);
  return {
    businessId: Number(business.id),
    name: business.name,
    timezone,
    weekStart,
    resetsOn,
    resetsAt: localMidnight(resetsOn, timezone).toISOString(),
    allocated,
    target,
    weeklyTarget: business.weekly_target,
    quotaMet: allocated >= target,
    paused
  };
}

export async function entitlementsWithUsage(ownerId: string, now = new Date()): Promise<EntitlementsWithUsage> {
  const entitlements = await entitlementsFor(ownerId, query, now);
  const allowance = await businessAllowance(ownerId, entitlements.limits.businesses);
  const paused = new Set(allowance.paused);
  const businesses = (await query("SELECT id,name,timezone,weekly_target FROM businesses WHERE owner_id=$1 ORDER BY id", [ownerId])).rows as { id: number; name: string; timezone: string; weekly_target: number }[];
  const usage: WeeklyUsage[] = [];
  for (const business of businesses) {
    const timezone = validTimezone(business.timezone) ? business.timezone : "UTC";
    const period = (await query("SELECT allocated FROM generation_periods WHERE business_id=$1 AND period_start=$2", [business.id, generationWeek(now, timezone)])).rows[0];
    usage.push(weeklyUsage(business, Number(period?.allocated ?? 0), entitlements, now, paused.has(Number(business.id))));
  }
  return { ...entitlements, usage };
}
