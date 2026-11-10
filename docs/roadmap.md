# Roadmap: what is built, what is next

This is the file to read when someone asks "what's next?". It is a snapshot, not a
promise: the GitHub issues are the source of truth for scope and acceptance criteria,
and this file says which ones to take, in what order, and what is waiting on the owner.
**Update it in the same PR that finishes or reshapes an item** (see the last section).

Last updated: 2026-11-10. Trackers: #225 (billing and the paid pilot), #271 (owner
approvals, order and costs), #99 (native app, parked).

**Current strategy: validate on the web first, for $0** (decided 2026-11-10, see
[decisions.md](decisions.md) and [mobile-plan.md](mobile-plan.md)). Pilot owners use the web
app on their phones. Nothing that costs money (Apple, Google Play) or only serves the native app
is worked on until the web pilot shows owners use and pay for PraiseLoop.

## Where we are

Built and on `master`:

- **Core pipeline:** review import (CSV, Apify fetch, Google Takeout file), quote selection,
  weekly generation with quotas, rendered images, approval queue, draft lifecycle.
- **Accounts:** Google, email-code, Microsoft sign-in; Sign in with Apple on the phone and
  the web (web needs owner keys, #268); mobile bearer sessions; account deletion; invite-only
  sign-up gate (`SIGNUP_MODE`, `INVITED_EMAILS`, #195); a best-effort new-sign-in alert email
  with a per-owner/per-method rate limit (#260). A "sign out of all devices" action is **not**
  built (follow-up from #260).
- **Billing:** plans, entitlements, Stripe checkout, webhook and portal (test mode works
  end to end on dev), Business tier, paid automatic posting.
- **Posting:** Buffer (draft mode only so far) and direct Instagram/Facebook: connect
  backend, worker publishing with a resumable Instagram flow and a JPEG variant, token-aware
  needs-reconnect marking, and the setup UI on `/connections`. Onboarding no longer requires a
  posting connection.
- **Phone app (native, parked):** sign-in (Google, email code, Microsoft, Apple), weekly
  queue, share-sheet posting, push registration, profile. Built and tested with mocks; never run
  on a device. Parked under the web-first strategy. Queue and draft
  screens have React Native Testing Library component tests (#86).
- **Dev environment:** Dockhand stacks, Stripe CLI forwarder, supervised draft-mode test
  guide in [development.md](development.md).

## Next, in order

Take the first item that is not blocked. Each is one PR per issue (see CONTRIBUTING.md).

1. **Web-first validation** (the pilot runs on these):
   - #273 installable web app (manifest, icons, Add to Home Screen hint)
   - #274 post approved drafts from the phone browser through the share sheet
   - #275 weekly "your posts are ready" email (replaces push during validation)
   - #276 every owner screen works at phone width
2. **In flight from the 2026-11-09 batch:** #159 email and password sign-in (approved by
   the owner 2026-11-09; start after #260 merges because both change sign-in).
3. **#234 remaining:** decide whether to remove Buffer **after** the Meta live test passes.
   Until then Buffer is the only automatic posting route and stays fully available (plan and
   account copy is already provider-neutral, #258). The live
   connect and publish test is **blocked** on #263 (Meta verification and App Review).
4. **#29 real scheduler** and **#46 Google Business Profile sync:** blocked on owner access
   (#264). Do not start without the owner confirming access exists.
5. **Parked until the web pilot is validated:** the native app's device checks and store
   release (#85, #86, #87, #89 device runs; #270), #95 store subscriptions, and every paid
   approval (#265 Apple, #266 Google Play). The native code stays on `master` and keeps passing
   CI; don't add native-only features.
6. **#98 move production to a VPS** and **#96 AI review replies:** post-MVP.

## Owner tasks (agents do not do these)

The full ordered list with steps and costs is **#271**. In short:

- **Now (free, needed for the web pilot):** #262 privacy, terms and support pages; #78 last
  Google sign-in check; #90 production hosting; the invite-gate env below.
- **Optional during validation (free, slow):** #263 Meta verification and App Review (gate
  for the #234 live test), #264 Google Business Profile API access, #222 Stripe account, CAD
  product and tax setup (Business price stays unset until then).
- **Parked until validated:** #261 individual/organization and D-U-N-S, #265 Apple ($99 USD
  a year), #266 Google Play ($25 USD once), #267 push credentials, #268 Sign in with Apple
  setup, #270 store listings and testing, #269 Microsoft publisher verification.
- **#233 verification:** run a real Google Takeout export on an owned Business Profile and
  upload it. The parser was built against a *guessed* file format (documented in
  [integrations.md](integrations.md)); the issue stays open until a real file imports. Do not
  announce the feature before this.
- **Deployment of the invite gate:** `SIGNUP_MODE=invite` and `INVITED_EMAILS=...` must be set
  on every environment that should be gated (dev stack and production). The default is
  `open`, so nothing is gated until they are set. Redeploy with an image pull after each
  merge to `master`; migrations run on start (latest at time of writing: `030`).
- **Housekeeping on the dev stack:** delete the old Stripe dashboard webhook endpoint for
  `dev.praiseloop.ca` (it causes 403s; the CLI forwarder replaces it), and regenerate any
  Dockhand webhook secret that was ever pasted into a chat.
- **Recheck on dev:** onboarding step 3 Back and Save & exit (#246 root cause was not
  reproduced; tell an agent if they still fail).

## Hard rules for whoever picks the next item

- Nothing auto-posts. No live provider call (Meta, Buffer live mode, Google) without the
  owner's say-so; fakes in tests.
- No secrets in the repo or in chat; synthetic data only (`@example.invalid`).
- Merge only when asked; the owner has said "merge when CI is green" per batch, so ask again
  for a new batch.
- For delegated builds (OpenCode) check: did it finish, does `npm run test:browser` pass (it is
  not part of `npm test`), and does the `package.json` test chain conflict after earlier merges.

## Keeping this file current

When a PR finishes an item here, change this file in that PR: move the item out of "Next",
add anything new it unblocked or left behind (a follow-up, an owner task, a deploy step),
and bump the date. If an item only exists in a chat or a PR description it will be lost, so
add it here or open an issue and link it. Also keep the tracker checklists on #225 and #99
roughly in step; they are coarser than this file.
