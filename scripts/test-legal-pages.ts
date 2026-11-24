import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LEGAL_SITE, PRIVACY_URL, SUPPORT_EMAIL, SUPPORT_URL, TERMS_URL } from "../lib/legalLinks";

// The privacy policy, terms and support page live on the praiseloop.ca website,
// not in the app (#292), so there is one copy to keep true. This suite guards that
// the app does not grow a second copy again, that every entry point links to the
// website, and that the app's old paths redirect there so URLs already given to
// Meta, Google and Stripe keep working. The browser suite checks the redirects live.
const root = join(__dirname, "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");

assert.equal(LEGAL_SITE, "https://praiseloop.ca");
assert.equal(PRIVACY_URL, "https://praiseloop.ca/privacy/");
assert.equal(TERMS_URL, "https://praiseloop.ca/terms/");
assert.equal(SUPPORT_URL, "https://praiseloop.ca/support/");
assert.equal(SUPPORT_EMAIL, "hello@praiseloop.ca");

// No in-app copy.
for (const page of ["privacy", "terms", "support"]) {
  assert.equal(existsSync(join(root, "app", page)), false, `app/${page} must not come back; the page lives on praiseloop.ca`);
}
assert.equal(existsSync(join(root, "app/ui/LegalPage.tsx")), false, "the in-app legal page chrome is gone");

// Old app paths redirect to the website, temporarily so the move is reversible.
const config = read("next.config.mjs");
assert.match(config, /redirects\(\)/);
assert.match(config, /const legalSite = "https:\/\/praiseloop\.ca"/, "next.config.mjs and lib/legalLinks.ts name the same site");
assert.match(config, /\["privacy", "terms", "support"\]/);
assert.match(config, /destination: `\$\{legalSite\}\/\$\{page\}\/`/);
assert.match(config, /permanent: false/);

// Every entry point links to the website copy.
const landing = read("app/page.tsx");
assert.match(landing, /By continuing you agree/);
for (const file of ["app/page.tsx", "app/plans/page.tsx", "app/account/page.tsx"]) {
  const text = read(file);
  for (const name of ["PRIVACY_URL", "TERMS_URL", "SUPPORT_URL"]) {
    assert.ok(text.includes(`href={${name}}`), `${file} links to ${name}`);
  }
  assert.doesNotMatch(text, /href="\/(privacy|terms|support)"/, `${file} must not link to the removed in-app pages`);
}

// The old contact address is gone from everything owners see.
for (const file of ["app/page.tsx", "app/plans/page.tsx", "app/account/page.tsx", "lib/signInAlerts.ts"]) {
  assert.doesNotMatch(read(file), /admin@praiseloop\.ca/, `${file} uses the support address`);
}

// No analytics or advertising tracker slipped into the public pages or the shell.
for (const file of ["app/page.tsx", "app/plans/page.tsx", "app/account/page.tsx", "app/AppShell.tsx"]) {
  assert.doesNotMatch(read(file), /gtag|googletagmanager|posthog|mixpanel|hotjar|plausible|fathom|fbq\(/i, `${file} must not load a tracker`);
}

console.log("Legal pages test passed: one copy on praiseloop.ca, links and redirects point there");
