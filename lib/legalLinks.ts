// The public legal and support pages live on the static praiseloop.ca site
// (repo PraiseLoop/praiseloop.github.io), not in this app (#292). One copy means
// the privacy policy, terms and support page cannot drift apart. The app's old
// /privacy, /terms and /support paths redirect here (next.config.mjs) so links
// already handed to Meta, Google or Stripe keep working.
export const LEGAL_SITE = "https://praiseloop.ca";
export const PRIVACY_URL = `${LEGAL_SITE}/privacy/`;
export const TERMS_URL = `${LEGAL_SITE}/terms/`;
export const SUPPORT_URL = `${LEGAL_SITE}/support/`;
export const SUPPORT_EMAIL = "hello@praiseloop.ca";
