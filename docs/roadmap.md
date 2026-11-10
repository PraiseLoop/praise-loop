# Roadmap: what is built, what is next

This is the file to read when someone asks "what's next?". It is a snapshot, not a
promise: the GitHub issues are the source of truth for scope and acceptance criteria,
and this file says which ones to take, in what order, and what is waiting on the owner.
**Update it in the same PR that finishes or reshapes an item** (see the last section).

Last updated: 2026-11-09. Trackers: #225 (billing and the paid pilot), #99 (mobile plan).

## Where we are

Built and on `master`:

- **Core pipeline:** review import (CSV, Apify fetch, Google Takeout file), quote selection,
  weekly generation with quotas, rendered images, approval queue, draft lifecycle.
- **Accounts:** Google, email-code, Microsoft sign-in; mobile bearer sessions; account
  deletion; invite-only sign-up gate (`SIGNUP_MODE`, `INVITED_EMAILS`, #195).
- **Billing:** plans, entitlements, Stripe checkout, webhook and portal (test mode works
  end to end on dev), Business tier, paid automatic posting.
- **Posting:** Buffer (draft mode only so far) and direct Instagram/Facebook: connect
  backend, worker publishing with a resumable Instagram flow and a JPEG variant, token-aware
  needs-reconnect marking, and the setup UI on `/connections`. Onboarding no longer requires a
  posting connection.
- **Phone app:** Expo scaffold, config gate, push registration server side.
- **Dev environment:** Dockhand stacks, Stripe CLI forwarder, supervised draft-mode test
  guide in [development.md](development.md).

## Next, in order

Take the first item that is not blocked. Each is one PR per issue (see CONTRIBUTING.md).

1. **#234 remaining slices** (direct Instagram/Facebook publishing):
   - Remove Buffer from onboarding copy and the setup pages, then decide whether to remove
     Buffer altogether. Buffer stays working until that decision.
   - Live connect and publish test on the owner's own accounts. **Blocked** on the owner
     (Meta app, Business Verification, App Review). Mark as not run until then.
2. **#29 real scheduler** and **#46 Google Business Profile sync:** blocked on owner access
   (#91). Do not start without the owner confirming access exists.
3. **Mobile app, in this order:** #85 sign-in, #86 weekly approval queue, then #87 share
   sheet, #89 notifications (app side). They depend on #91 (store accounts) for real device
   testing, and on #90 (pilot hosting) for the pilot.
4. **#92 Sign in with Apple:** after #91. Invite codes for Apple (so an invited person with a
   private-relay address can join) are the follow-up recorded in [decisions.md](decisions.md).
5. **#95 store subscriptions:** before a public App Store release, not before the pilot.
6. **#98 move production to a VPS** and **#96 AI review replies:** post-MVP.

## Owner tasks (agents do not do these)

- **#222** Stripe account, CAD product and tax setup (Business price stays unset until then).
- **#91** App Store and Google Play accounts, Business Profile API access, privacy policy,
  test distribution. **#78** Google OAuth for owner sign-in.
- **Meta:** create the Meta app, Business Verification, App Review. Gate for the #234 live test.
- **#233 verification:** run a real Google Takeout export on an owned Business Profile and
  upload it. The parser was built against a *guessed* file format (documented in
  [integrations.md](integrations.md)); the issue stays open until a real file imports. Do not
  announce the feature before this.
- **Deployment of the invite gate:** `SIGNUP_MODE=invite` and `INVITED_EMAILS=...` must be set
  on every environment that should be gated (dev stack and production). The default is
  `open`, so nothing is gated until they are set. Redeploy with an image pull after each
  merge to `master`; migrations run on start (latest at time of writing: `029`).
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
