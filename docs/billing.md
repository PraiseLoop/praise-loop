# Billing and tiers

The investigation behind PraiseLoop's billing plan, carried out on 2026-11-04. **None of the
billing described here is built yet.** What exists today is in [design.md](design.md) and
[features.md](features.md). Tracking issue: #225.

## Decisions so far

| Question | Answer | Status |
|---|---|---|
| First payment path | Stripe web checkout | Decided by the owner |
| First customers arrive through | The web, not the iOS app | Decided by the owner |
| Tiers | Free, Pro and Business | Decided by the owner |
| Buffer posting | Paid plans only | Decided by the owner |
| Pro price | CA$29.99 a month plus tax | Working price, formally recorded in #223 |
| Billing period | Monthly only, to start | Decided by the owner |
| Business price, exact business limit | Not decided | Open, #222 and #215 |
| Taxes, refund terms | Not decided | Open, #222 |

The price is not in [decisions.md](decisions.md) yet on purpose. `scripts/test-plans.ts` requires
`PLAN_PRICING` to be set in the same change that records a price, which publishes it on `/plans`.
Nobody can buy until #223 ships, so that PR records the price and publishes it together.

## What already exists

- **Plans:** `free` and `pro`, one row per owner in `owner_plans`, with a source and an expiry.
  `lib/services/entitlements.ts` holds the limits, and expired Pro falls back to Free without deleting data.
- **Audit:** every change appends to `owner_plan_events`.
- **Display:** `GET /api/entitlements` is read-only, and `/account`, `/plans` and the phone show what it returns.
- **Issues:** #94, #133 and #134 are closed. #95 covers App Store and Google Play purchases only, and
  says "No web checkout yet". Nothing covered web checkout, more tiers or a billing data model until
  this investigation.

## Why Stripe first

**Cost, on an example CA$29 charge:**

| Stripe fee | Rate | Amount |
|---|---|---|
| Domestic card | 2.9% + CA$0.30 | CA$1.14 |
| Billing, pay as you go | 0.7% | CA$0.20 |
| Tax, no-code integration | 0.5% where registered | CA$0.15 |
| **Total** | | **About CA$1.49, or 5%** |

The same charge costs about CA$4.35 at the roughly 15% store rate in
[mobile-plan.md](mobile-plan.md). That rate wasn't rechecked. International cards add 0.8%, and
currency conversion adds 2%.

**Timing:** the store accounts (#91) are still an open owner task, and the web app can take payments now.

**RevenueCat:** add it with #95 for the stores, writing to the same tables. It's free up to $2,500 a
month in tracked revenue, then 1%. The page didn't settle whether the 1% applies to all revenue or
only the excess, or whether web revenue counts, so check both before choosing it.

### What Stripe doesn't solve: Apple

From Apple's App Review Guidelines (page reports last updated 2026-10-16):

- **3.1.3(b):** an app may give access to subscriptions bought on the web "provided those items are
  also available as in-app purchases within the app". **So Stripe alone doesn't cover the App Store
  release, and #95 is still needed before it.**
- **3.1.1(a):** outside the US storefront and regions with Apple's link entitlement, apps "may not
  include buttons, external links, or other calls to action" pointing to other ways to pay.
- **3.1.3(f):** the exemption for free companion apps names only VoIP, cloud storage, email and web
  hosting. PraiseLoop isn't one of them.

Until #95 ships, the phone app shows plan status only, with no upgrade prompt or link. The list of
entitlement regions wasn't checked, so confirm how this applies before any store submission. Google
Play's rules weren't checked either.

## Design

1. **Keep payment sources separate (#219).** One `owner_plans` row can't hold several sources, so a
   store "expired" event could wipe out an active Stripe plan or a manual grant.
   - `owner_plans` stays for manual grants, and webhooks never write to it.
   - `owner_subscriptions` gets one row per provider subscription.
   - `billing_events` has a unique event ID per provider, so duplicates are ignored.
   - The owner gets the highest plan that's currently active.
2. **Use one provider interface (#219).** Stripe, a fake adapter and later the stores sit behind it.
   `CONTRIBUTING.md` requires the stub and a recorded decision first.
3. **Upgrade only from the verified webhook (#223).** The server picks the Stripe price from a plan
   key, and the checkout success redirect grants nothing. Each event re-reads the subscription from
   Stripe, so out-of-order delivery doesn't matter. Cancelling and card changes go through Stripe's
   customer portal.
4. **Register the webhook as public (#223).** It needs signature checking on the raw body and an
   allow-list entry in `scripts/test-authorization.ts`. Unknown owners change nothing.
5. **Keep limits in `PLAN_LIMITS`.** Stripe price IDs map to plans in config, so a later annual price
   shares the same limits.

## Tiers

| | Free | Pro | Business |
|---|---|---|---|
| Posts per week, per business | 1 | 5 | 5 or more |
| Businesses | 1 | 1 | 3–10 |
| Watermark | Yes | No | No |
| Brand voice | No | Yes | Yes |
| Posting through Buffer | No | Yes | Yes |
| Review sync, AI replies (once built) | No | Yes | Yes |

This moves the multi-business limit from Pro to Business. The app isn't in production, so no live
owners need moving. Approval stays required on every plan, and nothing auto-posts.

## Problems found

| Problem | Where | Issue |
|---|---|---|
| Any plan except `free` or `pro` makes installed phone apps throw, so this fix ships first | `mobile/src/api/entitlements.ts` | #214 |
| The phone's limits type is missing `brandVoice` | `mobile/src/api/entitlements.ts` | #214 |
| `free` and `pro` are hardcoded in checks, types, scripts and display helpers | Migration 012, `entitlements.ts`, `set-plan.ts`, display helpers | #215 |
| Review sync, AI replies and templates have nothing enforcing them, because the features don't exist yet | `PLAN_LIMITS` | #218 |
| Free owners can post through Buffer | `lib/services/bufferPosting.ts`, `app/api/buffer/` | #216 |
| The business limit is only checked at creation, so a lapsed owner keeps every business generating | `lib/services/generation.ts` | #217 |
| Deleting an account wouldn't cancel a Stripe subscription, so a deleted owner could keep being charged | `lib/services/accountDeletion.ts` | #220 |
| Email-code sign-in to an existing Google owner is flagged for review before billing, because of reassigned mailboxes | [design.md](design.md) | #221 |

## Changing a plan for testing

**Locally:**

```sh
npm run plan:set -- owner@example.com pro --reason "testing"
```

The Pro and Free demo owners also work with `MOBILE_DEV_AUTH=1`.

**In a production image:** `npm run plan:set` fails because `ts-node` is a dev dependency and the
images leave it out. Run the compiled script in the worker instead, because the web image doesn't have it:

```sh
docker compose exec worker node dist-worker/scripts/set-plan.js owner@example.com pro --reason "testing"
```

Run it from the folder with the stack's compose file, or use `docker exec <worker-container> node ...`.
The owner ran this on their stack on 2026-11-04 and it worked. The change applies on the next request.
`--expires YYYY-MM-DD` tests a lapse, and `free` downgrades.

**Once billing exists:** test purchases through the fake adapter locally (#219) and through Stripe
test mode with test cards (#223).

**Self-service upgrades:** PR #224, requested by the owner for testing, adds a separate route that
lets owners on the `SELF_SERVICE_UPGRADE_EMAILS` allowlist upgrade themselves to Pro. It's off unless
configured, and `/api/entitlements` stays read-only. It's a testing aid, not part of the paid design:
its grants are manual ones that webhooks don't touch, #215 needs to include it, and #223 removes it
before real payments, because it unlocks Pro without paying.

## Order of work

1. #214 Phone app tolerates unknown plans
2. #215 Business tier
3. #216 Buffer posting becomes paid
4. #217 Rule for extra businesses after a downgrade
5. #218 Only sell limits with something behind them
6. #219 Subscription tables, provider interface and fake adapter
7. #220 Cancel the subscription on account deletion
8. #221 Review email-code sign-in
9. #222 Owner: Stripe account, product and tax setup
10. #223 Stripe checkout, webhook and portal
11. #95 Store subscriptions, before public App Store release

## Sources

Fetched 2026-11-04. Recheck them before relying on the figures.

- [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Stripe Canada pricing](https://stripe.com/en-ca/pricing)
- [Stripe Billing pricing](https://stripe.com/en-ca/billing/pricing)
- [Stripe Tax pricing](https://stripe.com/en-ca/tax/pricing)
- [RevenueCat pricing](https://www.revenuecat.com/pricing/)
