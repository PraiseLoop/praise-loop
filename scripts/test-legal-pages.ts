import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLAN_PRICING } from "../lib/plansDisplay";

// The owner-approved wording of the public legal pages (#262) is final, so this
// suite guards the commitments that must not quietly disappear: no placeholders,
// the real contact address, the prices from PLAN_PRICING, the 14-day backup
// window from ops/backup.sh, the provider inventory, the essential-cookie list
// and the UI paths in the support FAQ. The browser suite proves they render
// signed out; this one fails before a build when the copy drifts.
const root = join(__dirname, "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");

const pages = {
  privacy: read("app/privacy/page.tsx"),
  terms: read("app/terms/page.tsx"),
  support: read("app/support/page.tsx")
};
// Collapse JSX line breaks so a sentence that wraps in source still reads as one
// string to the assertions below.
const flat = Object.fromEntries(Object.entries(pages).map(([name, text]) => [name, text.replace(/\s+/g, " ")])) as typeof pages;
const shared = read("app/ui/LegalPage.tsx");
const allCopy = [shared, ...Object.values(pages)].join("\n");

// Final wording: no template leftovers.
for (const pattern of [/TODO/i, /\[insert/i, /lorem ipsum/i, /\bTBD\b/, /\bXXX\b/, /placeholder/i, /example\.com/i]) {
  assert.doesNotMatch(allCopy, pattern, `legal copy still contains a placeholder: ${pattern}`);
}
assert.match(shared, /LEGAL_LAST_UPDATED = "2026-11-10"/, "all three pages show the same last-updated date");
assert.match(shared, /Last updated:/, "the date is labelled");
for (const [name, page] of Object.entries(pages)) {
  assert.match(page, /title: "/, `${name} has a page title`);
  assert.match(page, /<LegalPage/, `${name} uses the shared public page chrome`);
}

// Public reachability: the shell must not put a sign-in wall in front of them and a
// signed-out 401 from /api/businesses must not bounce a visitor off the page.
const shell = read("app/AppShell.tsx");
for (const route of ["/privacy", "/terms", "/support"]) {
  assert.ok(shell.includes(`pathname === "${route}"`), `${route} is a bare route in AppShell`);
  assert.ok(read("lib/sessionExpiry.ts").includes(`"${route}"`), `${route} is a public page in sessionExpiry`);
}
assert.match(shell, /public legal and support pages/, "the bare-route reason is documented");

// Privacy policy: identity, PIPEDA contact, data inventory and providers.
for (const fact of [
  "sole proprietor", "Ontario, Canada", "PIPEDA", "admin@praiseloop.ca", "30 days", "14 days",
  "AES-256-GCM", "scrypt", "invite-only", "first five characters",
  "Stripe", "Resend", "OpenAI", "OpenRouter", "Buffer", "Meta", "Google", "Microsoft", "Apple",
  "Apify", "Cloudflare", "Expo", "Have I Been Pwned", "outside Canada",
  "next-auth.session-token", "__Secure-next-auth.session-token", "praise-business",
  "praise-install-hint-dismissed", "praise-onboarding", "do not use analytics"
]) {
  assert.ok(flat.privacy.includes(fact), `privacy policy is missing: ${fact}`);
}
// The deletion promise points at the real account-deletion behaviour.
assert.match(flat.privacy, /cancel any live web subscription/i);
assert.match(flat.privacy, /no recovery period/i);
assert.match(flat.privacy, /nightly backup/i);
const backup = read("ops/backup.sh");
assert.match(backup, /RETENTION_DAYS:-14/, "backup retention still matches the 14 days in the policy");
assert.match(flat.privacy, /up to 14 days/);

// Terms: prices from PLAN_PRICING, cancellation/refund rules, pilot disclaimer,
// acceptable use, third-party terms, liability and governing law.
assert.equal(PLAN_PRICING.pro, "CA$29.99 a month, plus tax");
for (const fact of [
  "CA$29.99 a month", "plus applicable tax", "Business pricing is not published",
  "Stripe", "Manage subscription", "end of the period", "do not refund partial periods",
  "except where the law requires it", "30 days’ notice", "18 years",
  "fake", "scrape", "as is", "uptime", "12 months", "Instagram", "Facebook", "Buffer", "Google",
  "Ontario", "federal laws of Canada"
]) {
  assert.ok(flat.terms.includes(fact), `terms are missing: ${fact}`);
}
assert.match(flat.terms, /Nothing is posted without your approval/);
assert.match(flat.terms, /fees you paid us for PraiseLoop in the 12 months/);

// Support: contact, reply target and the real UI paths for each FAQ answer.
for (const fact of [
  "admin@praiseloop.ca", "within 2 business days", "What to include",
  "This week", "Manage subscription", "Delete account", "type", "Disconnect",
  "Connections", "Emails", "Email me when my weekly posts are ready",
  "Sign out of all other devices", "Google Takeout", "invite-only"
]) {
  assert.ok(flat.support.includes(fact), `support page is missing: ${fact}`);
}

// Every entry point links to the pages.
assert.match(read("app/page.tsx"), /By continuing you agree/);
assert.match(read("app/page.tsx"), /href="\/terms"/);
assert.match(read("app/page.tsx"), /href="\/privacy"/);
assert.match(read("app/page.tsx"), /href="\/support"/);
assert.match(read("app/plans/page.tsx"), /href="\/privacy"/);
assert.match(read("app/plans/page.tsx"), /href="\/support"/);
assert.match(read("app/account/page.tsx"), /href="\/privacy"/);
assert.match(read("app/account/page.tsx"), /href="\/terms"/);
assert.match(read("app/account/page.tsx"), /href="\/support"/);

// No analytics or advertising tracker slipped into the public pages or the shell.
for (const file of ["app/page.tsx", "app/plans/page.tsx", "app/account/page.tsx", "app/AppShell.tsx", "app/ui/LegalPage.tsx"]) {
  assert.doesNotMatch(read(file), /gtag|googletagmanager|posthog|mixpanel|hotjar|plausible|fathom|fbq\(/i, `${file} must not load a tracker`);
}

console.log("Public legal pages content test passed: final wording, public routes, providers, prices and support paths");
