import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLAN_LIMITS, type EntitlementLimits } from "../lib/services/entitlements";
import {
  PLAN_ORDER, PLAN_PRICING, PLAN_ROWS, PLANNED_LIMITS, SHIPPED_LIMITS, UNLISTED_LIMITS, planComparison, planNotes
} from "../lib/plansDisplay";

const root = join(__dirname, "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");
const notAvailable = "Planned — not available yet";
const includesKey = (limits: readonly (keyof EntitlementLimits)[], key: keyof EntitlementLimits) => limits.includes(key);

// Every limit is deliberately classified: shipped and compared, planned and
// compared as unavailable, or unlisted until its feature exists. A new limit
// cannot become "included" without someone choosing one of these.
assert.deepEqual(
  [...SHIPPED_LIMITS, ...PLANNED_LIMITS, ...UNLISTED_LIMITS].sort(),
  Object.keys(PLAN_LIMITS.free).sort(),
  "classify every plan limit as shipped, planned or unlisted"
);
assert.ok(includesKey(UNLISTED_LIMITS, "templates"), "templates stay off the comparison until a second design exists and the limit is enforced (#218)");
assert.deepEqual(PLAN_ROWS.map(row => row.key).sort(), [...SHIPPED_LIMITS, ...PLANNED_LIMITS].sort(), "only shipped and planned limits get a comparison row");
assert.deepEqual(PLAN_ORDER, ["free", "pro"]);

const rows = planComparison(PLAN_LIMITS);
assert.deepEqual(rows.map(row => ({ label: row.label, free: row.values.free, pro: row.values.pro })), [
  { label: "Posts each week, per business", free: "1 post", pro: "5 posts" },
  { label: "Watermark on images", free: "Small PraiseLoop watermark", pro: "No watermark" },
  { label: "Automatic review sync", free: "Not included", pro: "Planned — not available yet" },
  { label: "AI review replies", free: "Not included", pro: "Planned — not available yet" },
  { label: "Brand voice", free: "Not included", pro: "Learn from your website" },
  { label: "Businesses", free: "1 business", pro: "3 businesses" }
], "a plan limit changed; update the comparison wording and this expectation together");

// A limit is only shown as available when it has a feature behind it. Planned
// limits must read as unavailable, and shipped limits must show a real value.
for (const row of rows) {
  for (const plan of PLAN_ORDER) {
    const value = row.values[plan];
    if (includesKey(PLANNED_LIMITS, row.key)) {
      assert.equal(value, PLAN_LIMITS[plan][row.key] ? notAvailable : "Not included", `${row.label} has no feature yet, so it must not read as included`);
    } else {
      assert.notEqual(value, notAvailable, `${row.label} is shipped, so it must not read as planned`);
      if (PLAN_LIMITS[plan][row.key]) assert.notEqual(value, "Not included", `${row.label} is included in this plan, so it must show its value`);
    }
  }
}

// Unshipped features stay honest: the labels and notes must not claim they work.
assert.deepEqual(planNotes(rows), [
  "Automatic review sync (Google reviews) is planned for Pro but is not available yet, so both plans start with a spreadsheet import.",
  "AI review replies are planned for Pro but are not available yet.",
  "Brand voice learns a short, editable profile from your own public website; nothing is scraped from social accounts."
]);
assert.doesNotMatch(JSON.stringify(rows), /Up to 5 templates/, "templates must not be sold until more designs exist");

// The page reads the shared limits instead of keeping its own copy.
const page = read("app/plans/page.tsx");
assert.match(page, /planComparison\(PLAN_LIMITS\)/, "the plans page must render from PLAN_LIMITS");
assert.match(page, /planNotes\(/, "the plans page must show the honesty notes");

// Prices wait for a recorded decision. When docs/decisions.md records pricing, the
// page must carry it; until then no source may print a price.
const decision = /decision:[^\n]*\b(pricing|price)\b/i.test(read("docs/decisions.md"));
const sources = ["app/plans/page.tsx", "lib/plansDisplay.ts", "app/page.tsx"].map(read);
if (decision) {
  assert.ok(PLAN_PRICING, "docs/decisions.md records pricing, so PLAN_PRICING must be set");
} else {
  assert.equal(PLAN_PRICING, null, "prices may only be published after the decision is recorded");
  for (const source of sources) {
    assert.doesNotMatch(source, /(?:[$£€]\s?\d|\bper month\b|\bbilled monthly\b)/i, "publish prices only after the decision is recorded");
  }
}

// The page must be reachable signed out (the app shell otherwise shows a sign-in wall).
assert.match(read("app/AppShell.tsx"), /pathname === "\/plans"/, "/plans must render for signed-out visitors");
// Phone width: the plan cards stack instead of forcing a fixed width.
const css = read("app/plans/plans.module.css");
assert.match(css, /minmax\(min\(100%,\s*300px\)/, "plan cards must stack on narrow screens");
assert.doesNotMatch(css, /(?<!max-)width:\s*\d{3,}px/, "the plans page must not force a desktop width");
assert.match(read("app/page.tsx"), /href="\/plans"/, "the landing page must link to the plans page");

console.log("plans page tests passed");
