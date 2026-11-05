# Billing and tiers

The investigation behind PraiseLoop's billing plan, carried out on 2026-11-04. The
subscription tables, provider interface, account-deletion cancellation, Stripe checkout,
webhook and customer portal are built (#219, #220, #223). Tracking issue: #225.

## Decisions so far

| Question | Answer | Status |
|---|---|---|
| First payment path | Stripe web checkout | Decided by the owner |
| First customers arrive through | The web, not the iOS app | Decided by the owner |
| Tiers | Free, Pro and Business | Decided by the owner |
| Buffer posting | Paid plans only: called automatic posting | Decided by the owner |
| Pro price | CA$29.99 a month plus tax | Decided and published (#223) |
| Billing period | Monthly only, to start | Decided by the owner |
| Business price | Not decided | Open, #222 |
| Business limits | 5 businesses, 5 posts a week per business | Decided (owner delegated the choice) |
| Taxes, refund terms | Not decided | Open, #222 |

The Pro price is recorded in [decisions.md](decisions.md) and `PLAN_PRICING`, so `/plans`
publishes it. Checkout is the only way to get a paid web plan; Business has no price and
no button until #222 is settled.

## What already exists

- **Plans:** `free`, `pro` and `business`, one row per owner in `owner_plans`, with a source and an
  expiry. `lib/services/entitlements.ts` holds the limits, and expired Pro or Business falls back to
  Free without deleting data.
- **Downgrades:** an owner keeps every business, but only the oldest ones within the plan's business
  limit generate (ordered by `created_at` then `id`). The rest are paused and resume automatically
  after an upgrade. The web shows the pause with a link to the plans page; the phone only explains it,
  with no upgrade prompt or link (see the Apple rules below). Existing drafts stay visible and can
  still be approved (#217).
- **Subscriptions (#219):** `owner_subscriptions` holds one row per provider subscription, and
  `billing_events` records each provider event once with a unique `(provider, event_id)`. The manual
  `owner_plans` row and every active subscription are separate grants; the owner reads the highest
  active plan and the source names the grant that won. Expired manual Pro with an active Business
  subscription reads Business, and a lapsed subscription does not remove an active manual grant.
  Statuses count through `subscriptionIsActive`; `past_due` keeps the plan for a short grace period.
- **Provider interface (#219, #223):** `lib/integrations/billing.ts` defines the provider shape, and a
  fake adapter walks checkout, renewal, failed payment and cancellation through the same
  `applyBillingEvent` path the real webhook uses. Account deletion only needs a canceller, so
  `billingCanceller()` selects the development fake when `BILLING_PROVIDER=fake` and Stripe when
  `STRIPE_SECRET_KEY` is set otherwise;
  `billingProvider()` still exposes the fake's event methods only in development. `cancel` ends
  billing at the provider immediately and is safe to call again; a missing subscription is success.
  `BILLING_PROVIDER=fake` selects the fake only in a development process; a production build refuses
  it. `POST /api/dev/billing` is the local walkthrough and answers 404 without `MOBILE_DEV_AUTH`.
- **Stripe checkout, webhook and portal (#223):** `POST /api/billing/checkout` creates a Checkout
  session with the price chosen from config, Stripe Tax on and the owner ids in metadata;
  `POST /api/billing/webhook` verifies the raw body, re-reads the subscription and applies it; and
  `POST /api/billing/portal` opens Stripe's customer portal. The routes are described below.
- **Account deletion (#220, #223):** before deleting any local data, the owner's
  `owner_subscriptions` rows that can still bill are cancelled through the provider. A failed
  cancel returns `503`, deletes nothing and keeps the sessions, so a retry is safe after a
  partial cancel. Repeat cancels and a subscription already missing at Stripe are success.
  Store subscriptions cannot be cancelled by us and keep the existing warning.
  An owner with no subscriptions needs no provider and makes no network call. The cancellation
  runs before the database transaction; a subscription created in the gap between the two steps
  is a known, out-of-scope race. A provider event for a deleted owner is acknowledged with
  `ignored: true` and writes nothing; if Stripe says it can still bill, the webhook cancels it.
- **Audit:** every plan change appends to `owner_plan_events`. Provider events never write
  `owner_plans`.
- **Display:** `GET /api/entitlements` is read-only, and `/account`, `/plans` and the phone show what it returns.
- **Automatic posting:** the paid limit `automaticPosting` is in `PLAN_LIMITS`
  (`false` on Free, `true` on Pro and Business) and is enforced on the server when
  connecting Buffer, choosing a channel, confirming a post for a slot, and in the
  worker before sending. Approval is still required, and nothing auto-posts.
- **Step-up before sensitive actions (#221, #223):** `requireRecentStepUp` in `lib/stepUp.ts` checks
  that the current session confirmed a code sent to the owner's own address within ten minutes. The
  two owner routes under `/api/account/step-up/` send and verify it, and
  `app/ui/StepUpCodeForm.tsx` is the reusable web form. The sign-in path is unchanged and handles
  the reassigned-mailbox risk with this pause, not with stronger protection. Checkout, the portal
  and any plan change call the helper before acting; `BillingActions` on `/account` mounts the form.
- **Issues:** #94, #133 and #134 are closed. #95 covers App Store and Google Play purchases only.
  Web checkout, more tiers and the billing data model are #213/#219–#225; #223 now builds the Stripe
  checkout, webhook and portal.

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
entitlement regions wasn't checked, so confirm how this applies before any store submission.
Google Play's rules weren't checked either.

## Design

1. **Keep payment sources separate (#219, built).** One `owner_plans` row can't hold several sources, so a
   store "expired" event could wipe out an active Stripe plan or a manual grant.
   - `owner_plans` stays for manual grants, and webhooks never write to it.
   - `owner_subscriptions` gets one row per provider subscription.
   - `billing_events` has a unique event ID per provider, so duplicates are ignored.
   - The owner gets the highest plan that's currently active.
2. **Use one provider interface (#219, built).** Stripe, a fake adapter and later the stores sit behind it.
   `CONTRIBUTING.md` requires the stub and a recorded decision first. The fake is selected by
   `BILLING_PROVIDER=fake`, refused in production, and walks checkout, renewal, failed payment and
   cancellation locally through `/api/dev/billing` without a network call.
3. **Upgrade only from the verified webhook (#223, built).** The server picks the Stripe price from a
   plan key, and the checkout success redirect grants nothing. Each event re-reads the subscription
   from Stripe, so out-of-order delivery doesn't matter. Cancelling and card changes go through
   Stripe's customer portal.
4. **Register the webhook as public (#223, built).** It verifies the signature over the raw body and
   is allow-listed in `scripts/test-authorization.ts`. Unknown owners change nothing; a deleted
   owner's still-billable subscription is cancelled so it cannot keep charging.
5. **Keep limits in `PLAN_LIMITS`.** Stripe price IDs map to plans in config, so a later annual price
   shares the same limits.

## Checkout, webhook and portal (#223)

- **Checkout:** `POST /api/billing/checkout` is owner-wide and added to `OWNER_WIDE_PATHS`. The body
  is only `{ plan: "pro" | "business" }`; the server chooses `STRIPE_PRICE_PRO` or
  `STRIPE_PRICE_BUSINESS`, so a client cannot ask for a price. `requireRecentStepUp` runs before any
  provider call. A missing price is `400`, an owner with a Stripe subscription that can still bill is
  `409 subscription_exists` (use the portal), and missing Stripe config, `STRIPE_WEBHOOK_SECRET` or
  `NEXTAUTH_URL` is `503`. Checkout refuses to sell without a verified webhook, because otherwise a
  payment could complete and no plan would ever be granted.
  The session uses `mode=subscription`, one line item at quantity 1, `client_reference_id` and
  subscription metadata for the owner and plan, the owner's verified email when there is one,
  `automatic_tax[enabled]=true`, `billing_address_collection=auto`, and the success/cancel URLs
  `/account?checkout=success` and `/plans?checkout=cancelled`. It returns `{ url }`; the client
  redirects. Nothing is granted here.
- **Success page:** `/account` shows a short “confirming” notice and reloads the plan a few times.
  The redirect itself grants nothing; only the webhook changes the plan.
- **Webhook:** `app/api/billing/webhook/route.ts` is public by design and calls
  `handleStripeWebhook(rawBody, signature)`. It answers `503` without `STRIPE_WEBHOOK_SECRET`, `400`
  on a bad signature or malformed JSON, and verifies the signature before parsing. Handled types:
  `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.paid`,
  `invoice.payment_failed`, `invoice.payment_succeeded` and `charge.refunded`. A refund is
  acknowledged and never cancels a subscription by itself.
- **Re-read, then apply:** the handler resolves the subscription id, fetches the subscription from
  Stripe again and never trusts the event's status or price. The owner comes from subscription
  metadata, then the checkout session's `client_reference_id`/metadata, then an existing
  `owner_subscriptions` row. If no owner or no plan can be resolved, it acknowledges with
  `ignored: true` and writes nothing (and does not cancel). Duplicate, stale and applied events all
  return `200`; `billing_events` keeps each event once.
- **Late checkout:** if `applyBillingEvent` returns `ignored` because the owner is gone and Stripe says
  the subscription can still bill, the handler cancels it at Stripe. A missing or already-cancelled
  subscription is success; a cancellation failure returns `500` so Stripe retries and the event is not
  lost. This stops a checkout that finishes just after account deletion from charging with no account
  behind it.
- **Portal:** `POST /api/billing/portal` is owner-wide, step-up protected, and looks up the newest
  `owner_subscriptions` row with `provider='stripe'` and a stored `customer_id`. No row is `400`
  `no_subscription`; missing config is `503`. It returns the Stripe portal URL for card changes and
  cancellation.
- **Customer id:** migration 027 adds nullable `customer_id` to `owner_subscriptions`. An event that
  omits it keeps the stored value through `COALESCE`, so older or partial events cannot wipe it.
- **Price mapping and tax:** price ids live only in `STRIPE_PRICE_PRO`/`STRIPE_PRICE_BUSINESS` and
  map back to plans; a later annual price shares the same limits. Stripe Tax is enabled at checkout,
  so the tax shows there where the owner is registered. Business has no price until #222.
- **Grace period:** `PAST_DUE_GRACE_PERIOD_MS` in `lib/services/subscriptions.ts` is three days. A
  `past_due` subscription keeps the plan inside that window and reads Free afterwards; nothing is
  deleted, so a successful retry restores it. There is no second constant.
- **Repeat cancels:** account deletion only sends rows whose status is not `canceled` or
  `incomplete_expired`, and Stripe's canceller treats a `404`/`resource_missing` as success. A retry
  after a partial failure therefore cannot fail on an already-ended subscription.
- **Stripe test mode:** a run with a test card has **not been run**. The webhook secret is not
  configured, and checkout needs the owner's Stripe product and price ids. The fixtures in
  `scripts/test-stripe-billing.ts` cover the code path; the live test-mode run is still an owner task.

## Tiers

| | Free | Pro | Business |
|---|---|---|---|
| Posts per week, per business | 1 | 5 | 5 |
| Businesses | 1 | 1 | 5 |
| Watermark | Yes | No | No |
| Brand voice | No | Yes | Yes |
| Automatic posting (through Buffer) | No | Yes | Yes |
| Review sync, AI replies (once built) | No | Yes | Yes |

This moves the multi-business limit from Pro to Business. The app isn't in production, so no live
owners need moving. Approval stays required on every plan, and nothing auto-posts.

The paid feature and its `PLAN_LIMITS` entry are called **automatic posting**
(`automaticPosting`), not Buffer posting, so the plan does not change when direct
publishing (#234) replaces Buffer. Buffer is only the first provider it applies to.
Free owners keep the phone share sheet and image download. The server refuses a Free
or expired plan when connecting Buffer, choosing a channel, confirming a post for a
slot, and again in the worker immediately before it sends. A post already queued when
a plan lapses is not sent and not resubmitted: it ends `failed` with the reason
`plan_required`, and the owner sees why on the approval card and schedule.

## Problems found

| Problem | Where | Issue |
|---|---|---|
| Any plan except `free` or `pro` makes installed phone apps throw, so this fix ships first | `mobile/src/api/entitlements.ts` | #214 |
| The phone's limits type is missing `brandVoice` | `mobile/src/api/entitlements.ts` | #214 |
| `free` and `pro` were hardcoded in checks, types, scripts and display helpers; the Business tier replaces that (#215) | Migration 012, `entitlements.ts`, `set-plan.ts`, display helpers | #215 |
| Review sync and AI replies have nothing enforcing them, because the features don't exist yet | `PLAN_LIMITS` | #218 |
| Free owners can post through Buffer | `lib/services/bufferPosting.ts`, `app/api/buffer/` | #216 |
| The business limit is only checked at creation, so a lapsed owner keeps every business generating; #217 pauses the extra businesses and resumes them on upgrade | `lib/services/generation.ts` | #217 |
| Deleting an account would not cancel a Stripe subscription, so a deleted owner could keep being charged; now cancelled first, and a failed cancel blocks deletion | `lib/services/accountDeletion.ts` | #220 |
| Email-code sign-in to an existing Google owner is flagged for review before billing, because of reassigned mailboxes | [design.md](design.md) | #221: reviewed; sign-in kept as is, with a fresh-code step-up before the portal and plan changes |

## Changing a plan for testing

**Locally:**

```sh
npm run plan:set -- owner@example.com pro --reason "testing"
```

The Pro, Business and Free demo owners also work with `MOBILE_DEV_AUTH=1`.

**In a production image:** `npm run plan:set` fails because `ts-node` is a dev dependency and the
images leave it out. Run the compiled script in the worker instead, because the web image doesn't have it:

```sh
docker compose exec worker node dist-worker/scripts/set-plan.js owner@example.com pro --reason "testing"
```

Run it from the folder with the stack's compose file, or use `docker exec <worker-container> node ...`.
The owner ran this on their stack on 2026-11-04 and it worked. The change applies on the next request.
`--expires YYYY-MM-DD` tests a lapse, and `free` downgrades.

**Once billing exists:** test purchases through the fake adapter locally (#219) and through Stripe
test mode with test cards (#223). Set `BILLING_PROVIDER=fake` and `MOBILE_DEV_AUTH=1`, then use
`POST /api/dev/billing` as described in [development.md](development.md#fake-billing-in-development).
For real checkout, set `STRIPE_SECRET_KEY`, `STRIPE_PRICE_PRO` and `STRIPE_WEBHOOK_SECRET` and forward
events with `stripe listen`; see the Stripe test-mode note in [development.md](development.md).

**Self-service upgrades:** removed by #223 before real payments. The route, service and
`SELF_SERVICE_UPGRADE_EMAILS` config are gone because they unlocked Pro with no payment. Plans change
only through an operator grant or a verified provider event.

## Order of work

1. #214 Phone app tolerates unknown plans
2. #215 Business tier
3. #216 Buffer posting becomes paid
4. #217 Rule for extra businesses after a downgrade
5. #218 Only sell limits with something behind them
6. #219 Subscription tables, provider interface and fake adapter
7. #220 Cancel the subscription on account deletion (built)
8. #221 Review email-code sign-in
9. #222 Owner: Stripe account, product and tax setup
10. #223 Stripe checkout, webhook and portal (built)
11. #95 Store subscriptions, before public App Store release

## Sources

Fetched 2026-11-04. Recheck them before relying on the figures.

- [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Stripe Canada pricing](https://stripe.com/en-ca/pricing)
- [Stripe Billing pricing](https://stripe.com/en-ca/billing/pricing)
- [Stripe Tax pricing](https://stripe.com/en-ca/tax/pricing)
- [RevenueCat pricing](https://www.revenuecat.com/pricing/)
