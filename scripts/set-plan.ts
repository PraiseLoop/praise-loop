import { query, pool } from "../lib/db";
import { PLAN_LIMITS, setOwnerPlan, type Plan } from "../lib/services/entitlements";

const usage = `Usage:
  npm run plan:set -- OWNER_ID_OR_EMAIL PLAN [--expires YYYY-MM-DD] [--reason "..."]
  npm run plan:set -- --business BUSINESS_ID PLAN [--expires YYYY-MM-DD]
  npm run plan:set -- --email OWNER_EMAIL PLAN

PLAN is one of free, pro or business. --business resolves its owner through the existing claim.
Every change appends an owner_plan_events audit row.`;

async function main() {
  const args = process.argv.slice(2);
  let owner: string | null = null;
  let business: string | null = null;
  let plan: Plan | null = null;
  let expires: string | null = null;
  let reason = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--business") business = args[++i] ?? null;
    else if (arg === "--email" || arg === "--owner") owner = args[++i] ?? null;
    else if (arg === "--expires") expires = args[++i] ?? null;
    else if (arg === "--reason") reason = args[++i] ?? "";
    else if (Object.hasOwn(PLAN_LIMITS, arg)) plan = arg as Plan;
    else if (!owner && arg) owner = arg;
    else throw new Error(usage);
  }

  if (!plan || (!owner && !business)) throw new Error(usage);

  if (business) {
    const id = Number(business);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Use a valid numeric business id");
    const row = (await query<{ owner_id: string | null }>("SELECT owner_id FROM businesses WHERE id=$1", [id])).rows[0];
    if (!row?.owner_id) throw new Error("Business not found or not claimed by an owner");
    owner = row.owner_id;
  }

  const found = (await query<{ id: string; email: string | null }>(
    "SELECT id,email FROM auth_users WHERE id=$1 OR email=$1 LIMIT 1",
    [owner]
  )).rows[0];
  if (!found) throw new Error("Owner not found; pass an auth user id, an email, or --business");

  const entitlements = await setOwnerPlan(found.id, plan, { expiresAt: expires, reason: reason.trim() || undefined });
  console.log(JSON.stringify({ owner: found.id, email: found.email, ...entitlements }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Plan update failed");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
