# Design overview

**Read this first.** It is the map of how PraiseLoop works and why, written for people and agents
who are about to change it. It summarises and links; the detailed, authoritative text lives in the
other docs. When you change behaviour, update the detailed doc and the matching line here.

Last reviewed: 2026-11-05 (Stripe checkout, webhook and portal, #223; direct Meta publishing, #234; invite-only sign-up, #195; Google Takeout review import, #233).

| Doc | What it is the source of truth for |
| --- | --- |
| [product.md](product.md) | What we are building, for whom, MVP scope and non-goals |
| [architecture.md](architecture.md) | Stack, module boundaries, data-flow rules, security rules |
| [auth.md](auth.md) | Every sign-in method, sessions, linking policy, account deletion |
| [features.md](features.md) | One section per shipped feature (what it does, tests, rollback) |
| [decisions.md](decisions.md) | Dated log of decisions and why (add one for anything architectural) |
| [mobile-plan.md](mobile-plan.md) | Why the product is mobile-first, phases, plans and pricing |
| [billing.md](billing.md) | The billing and tiers investigation, subscription data model, Stripe checkout/webhook/portal and order of work |
| [integrations.md](integrations.md) | Email, Buffer, direct Meta publishing and Google Business Profile feasibility and status |
| [development.md](development.md) | Running it locally, env variables, tests, hosting, backups |
| [android-release.md](android-release.md) | Building the Android APK on a tag for Obtainium |
| [pilot.md](pilot.md) | The paid-pilot plan and how observations are recorded |
| `CLAUDE.md`, `CONTRIBUTING.md` | Working rules for agents and contributors |

## 1. What the product is

PraiseLoop turns a local business's existing customer reviews into branded social posts. Each
week it picks the best review quotes, writes captions, renders a quote-card image in the business's
brand, and puts the drafts in front of the owner for approval. Nothing is ever posted without the
owner's approval. For the MVP the owner posts from their phone through the system share sheet; a
real scheduler integration is a later paid feature.

The owner is the only user type. One owner can have several businesses (limited by plan), and each
business has reviews, a brand, drafts and a weekly target.

## 2. System map

```text
 Owner's phone (Expo app, mobile/)      Owner's browser (Next.js pages, app/)
            │  bearer session                   │  cookie session
            └──────────────┬────────────────────┘
                           ▼
             Next.js API routes  (app/api/**, every one wrapped in ownerRoute)
                           │  lib/services/**  (domain logic)
                           ▼
                      Postgres  ◄──────────── Worker (worker/index.ts)
              (system of record, outbox)       BullMQ over Redis delivers generation jobs;
                                               Postgres decides what is allowed and done
                           │
        shared media volume: rendered PNGs, served only via /api/media/<name>
```

- **Web app** (`app/`): Next.js (App Router) UI and the API. Pages: landing/sign-in, onboarding,
  approval ("This week"), schedule, brand, reviews/import, quotes, plan and profile (`/account`),
  public `/plans`.
- **API** (`app/api/**`): the only way any client writes data. No client talks to Postgres, the AI
  provider, Google, Resend or Expo directly.
- **Domain logic** (`lib/`, `lib/services/`): everything with rules lives here, not in route files
  or components, so the web, the phone API, the worker and the tests share one implementation.
- **Worker** (`worker/index.ts`): generates captions and renders images in the background. Redis/BullMQ
  only *delivers* jobs; Postgres (the `generation_jobs` outbox, weekly periods, renewable leases) is
  the authority, so a lost Redis message or a restart cannot double-spend or lose work.
- **Phone app** (`mobile/`, its own package, Expo SDK 58 + Expo Router): sign-in, weekly queue, draft
  detail (edit, approve, archive, new version, share/save), profile. It uses only the HTTP API.
- **Hosting**: Docker Compose. The pilot runs on a home server behind a Cloudflare Tunnel (see
  `docker-compose.pilot.yml`, `ops/`, [development.md](development.md#pilot-hosting)); managers that
  take one compose file (Dockhand) use `docker-compose.standalone.yml`, which must stay in step with
  the two real files; a small VPS is planned for paying customers (#98).

## 3. Core domain

### Pipeline

reviews (CSV import, `source='manual'`; Google Takeout import, `source='google_takeout'`; Google sync is stubbed; the removable Apify stopgap writes `source='apify_google'`) → `quoteSelector` ranks candidate
quotes → `lib/services/generation.ts` reserves the week's quota (`generation_periods`) and enqueues
`generation_jobs` → worker writes caption + rendered PNG into `draft_posts` → owner approves →
owner shares from the phone and confirms "I posted it" (`shared`).

- Weekly generation is per business, in the business's timezone (`lib/timezone.ts`), and capped by
  the owner's plan (`postsPerWeek`) and a per-owner daily AI-call limit
  (`OWNER_GENERATION_DAILY_LIMIT`, `chargeGeneration` in `lib/authorization.ts`).
- Rendering (`lib/services/imageRenderer.ts`, sharp) is deterministic: same inputs give the same
  PNG. Filenames contain the draft id and a content digest. Images live on the shared media volume
  and are served **only** through `/api/media/<name>` with an ownership check, never from `public/`.
- Captions come from OpenAI or OpenRouter (`lib/services/captions.ts`; OpenAI wins if both keys are
  set; the OpenRouter model is always an explicit setting). A stored *brand voice* (learned from the
  owner's website, Pro only) is added to the prompt when present; otherwise the business's tone
  setting is used.

### Draft lifecycle

Statuses: `draft`, `approved`, `shared` (owner-reported, never shown as verified), `scheduled`,
`published` (both reserved for a real scheduler, #29), `failed`, `archived`.

All owner changes go through `draftMutation` in `lib/services/draftLifecycle.ts`: an optimistic
`version` check (409 when stale), blocked while generation is active or provider scheduling exists,
and every transition writes an append-only `draft_events` row (a database trigger records the actor
and reason). The posting worker uses `providerDraftTransition` from the same module, so its
scheduled → published/failed moves follow the same lock, expected-status and version rules; the
trigger appends the event with actor `worker`. "Make a new version" clears the caption and image and
re-queues generation. Scheduling fails closed. Nothing auto-posts.

### Data model (Postgres; migrations in `db/migrations/NNN_name.sql`, forward-only)

| Area | Tables |
| --- | --- |
| Owners and sign-in | `auth_users`, `auth_accounts` (provider + provider account id → owner), `auth_sessions` (web and mobile, hashed token), `email_sign_in_codes` |
| Business content | `businesses` (brand colours/tone/voice, timezone, weekly target), `reviews`, `draft_posts`, `draft_events` |
| Generation | `generation_periods`, `generation_jobs`, `posting_slot_claims` |
| Plans and usage | `owner_plans`, `owner_plan_events`, `owner_subscriptions`, `billing_events`, `owner_usage` |
| Phone | `device_push_tokens`, `push_deliveries` |
| Integrations (stubbed) | `google_connections`, `apify_review_places`, `apify_review_runs` |

Rules: migrations are additive and data-preserving; parallel PRs collide on the number, so renumber
the later one when rebasing (renumbering an applied file is safe: the runner matches the name after
the number). A schema change needs an issue and a migration. `lib/db.ts` `query()` joins an active
`transaction()` automatically (AsyncLocalStorage), so a `query` inside a transaction callback is
transactional.

## 4. Identity, sessions and authorization

- **Identity = provider + stable subject**, never an email by itself. Providers: `google`, `email`
  (one-time code), `apple`, `microsoft`. Microsoft's subject is `<tid>:<oid>` (`sub` differs per app
  registration, so it must not be used). One owner can have several methods (`auth_accounts`).
- **Linking policy** lives in one place, `lib/authLinking.ts` (`signInWithIdentity`,
  `linkIdentityToOwner`, `unlinkMethod`). A sign-in may *find an existing owner by email* only when
  the provider guarantees the address is verified (Google, our own email codes). Apple and Microsoft
  never link by email; they create their own owner or are linked from a signed-in session. An owner
  already linked to a *different* subject for the same provider is rejected. The last method can't be
  unlinked. Owners are never merged automatically. Decided and accepted: an email code can sign in
  to an existing Google owner with the same verified address (risk: a reassigned mailbox). Before
  billing (#221) the owner kept that path unchanged and added a fresh-code step-up for sensitive
  steps: the billing portal and plan changes call `requireRecentStepUp`, which needs a code sent to
  the address on the signed-in owner's row within ten minutes (or, for owners with no address, a
  session under ten minutes old). It pauses the action; it does not protect against whoever holds
  the mailbox. See [auth.md](auth.md) and [decisions.md](decisions.md).
- **Pilot sign-up gate** (#195): `SIGNUP_MODE` is `open` (default) or `invite`, and `INVITED_EMAILS`
  is a comma/whitespace allow-list compared case-insensitively. The gate lives in
  `lib/signupPolicy.ts` and is consulted by `signInWithIdentity` only when it would create a new
  owner, so returning identities, existing owners and linking a method to a signed-in owner are
  never blocked. An invalid mode fails closed to `invite` with one warning. A refusal on the phone
  is `403 {error:"invite_only"}`; on the web it returns to `/?error=invite_only`; the email request
  route does not reveal invitation or ownership. Apple's private-relay or missing address must
  itself be invited, and invite codes for Apple are the follow-up. No schema change.
- **Sessions**: web uses NextAuth with revocable database sessions (cookie, 8 hours); the phone uses
  hashed bearer tokens in the same `auth_sessions` table (`kind='mobile'`), stored in the keychain.
  Any 401 on the phone clears the token and returns to sign-in.
- **Every route under `app/api` must be wrapped in `ownerRoute`** (`lib/authorization.ts`): it
  resolves the session, checks ownership of the business or draft, applies CSRF/origin rules for
  cookies and upload limits. `scripts/test-authorization.ts` calls every exported handler anonymously
  and expects 401, so a route is public only if explicitly allow-listed there (mobile config, the
  sign-in exchanges, the dev routes). Routes that are owner-wide rather than business-scoped are in
  `OWNER_WIDE_PATHS`.
- **Plans and entitlements** (`lib/services/entitlements.ts`): one effective plan per owner
  (`free`/`pro`/`business`), enforced on the server; clients read `GET /api/entitlements` and never
  unlock anything themselves. The manual grant stays in `owner_plans`, provider subscriptions live in
  `owner_subscriptions`, and the effective plan is the highest active grant in `PLAN_ORDER` (#219).
  Every change appends to `owner_plan_events`; a provider event only ever writes the subscription
  tables. Free: 1 post/week, the Classic quote-card design, watermark, 1 business, no automatic posting. Pro: 5 posts/week, no
  watermark, brand voice, automatic posting through Buffer, all four quote-card designs, 1 business;
  review sync and AI replies are planned and are not sold until the server enforces them (#218). Business: Pro's features plus 5 businesses. Expired Pro or
  Business falls back to Free without deleting data, so automatic posting is refused and queued
  posts fail closed, and a saved Pro design stays saved but new images render the Classic design.
  After any downgrade only the oldest
  businesses within the limit generate, and the rest are paused until an upgrade (#217). Plan
  changes are operator grants, or a verified Stripe webhook from a checkout or the customer portal
  (#223); there is no self-service upgrade outside payment. The fake billing provider can walk a
  subscription locally but is refused in production (#219); Stripe web billing (#225) is built and
  store subscriptions (#95) are not. Deleting an account cancels every live provider subscription
  first, and a failed cancel leaves the account and sessions intact (#220). The design is in
  [billing.md](billing.md).
- **Dev sign-in** (`MOBILE_DEV_AUTH=1`, never in production): demo owners (Pro, Business, Free, email-only) on
  the phone and the web landing page, backed by `lib/devAuth.ts` and the dev seeder.

## 5. Clients

### Web
Server-rendered shell (`app/AppShell.tsx`) holding the session, businesses and profile in context.
Sign-in options: Google, Microsoft (when configured), email code, dev demo owners. Profile menu with
name editing, plan and usage page, sign-in methods list (link/unlink), delete account.

### Phone (`mobile/`)
Expo Router screens: `sign-in`, `queue`, `draft/[id]`, `profile`. Design rules that matter:
- Native modules (Google, Apple, Microsoft auth session, notifications, media library) are
  `require`d **lazily inside try/catch**, so Expo Go and Jest still start. Expo Go cannot contain
  these modules, so those buttons are hidden there; email-code and demo sign-in work everywhere.
- The app talks only to the API, which must stay additive: installed apps can't be upgraded on
  demand. `GET /api/mobile/config` carries `minimumVersion` for a forced-update screen.
- Public settings (`EXPO_PUBLIC_*`) are read when Expo starts, from *its own* environment.
- Sharing: download the PNG through the media route to the cache, copy the caption, open the share
  sheet, then ask "Did you post it?" and mark `shared`. Save to Photos is optional (add-only).
- Push: the worker sends "posts ready" (Expo push over `fetch`, recorded in `push_deliveries`); the
  app registers its token, refreshes on launch, unregisters on sign-out, and deep-links to a queue.
  Registration, the toggle and sign-out run through one serialized controller with a pending-cleanup
  record (see [features.md](features.md#phone-notifications-89)).
- Builds: development builds and Android APKs through EAS ([android-release.md](android-release.md)).

## 6. Integrations and external services

| Service | Use | Status |
| --- | --- | --- |
| Postgres, Redis | data, job delivery | live |
| OpenAI / OpenRouter | captions, brand voice | built, used with fakes in tests; no live run in CI |
| Resend | sign-in codes (`lib/email.ts`, fake outbox in dev/tests) | **live and verified** (sender `noreply@praiseloop.ca`) |
| Zoho Mail | a human mailbox for `admin@praiseloop.ca` (vendor and service sign-ups, replies) | **live**; MX/SPF/DKIM for the root domain are Zoho's, Resend sends from the `send`/`rsend` subdomains and `resend._domainkey`; the root domain may have only one SPF record |
| Cloudflare Tunnel | reaches the home server; the `praiseloop-dev` tunnel serves the dev environment at `dev.praiseloop.ca` (all paths to `http://praiseloop-web:3000`, 404 for any other host) and runs as its own cloudflared stack on the shared `edge` Docker network; the app stack (`docker-compose.standalone.yml`, for Dockhand) deliberately does not contain it | tunnel, DNS and routing created; the tunnel's public hostname must point at `praiseloop-web:3000` once its stack is up. A Cloudflare firewall rule `dev_home_only` blocks every request to that host that is not from the home IP, except `/api/mobile/*` (the phone's bearer-token API). If the home IP changes the web side locks out until the rule is edited. `NEXTAUTH_URL` is `https://dev.praiseloop.ca`; `app.praiseloop.ca` is reserved for production and not set up |
| Expo push | "posts ready" notifications | built; needs EAS project id, APNs/FCM, a device test |
| Google OAuth (web) | sign-in | **live and verified** |
| Google native, Apple, Microsoft | phone sign-in; Microsoft also on web | built, tested with local keys only, never run live |
| Buffer | automatic posting for Pro and Business owners with a Business/Creator Instagram or a Facebook Page (#29, #216) | **feasibility spike done 2026-11-01**: live API key works, an app client exists; adapter and encrypted credentials built against mocks only; **Connect backend built (#29 part 1)**: OAuth, encrypted tokens, channel selection; **web Connect screen built (#29 part 2)**: connect/reconnect/disconnect and one channel per business, posting still off; **automatic posting is now paid (#216)**: Free and expired plans are refused on every write path and the worker fails a queued post closed; **worker submission, media-URL policy and the off/draft/live gate built (#29 part 3)**; phone UI **not built**; never run live; see below |
| Direct Meta publishing | replacement for Buffer (#234) | feasibility checked 2026-11-05; stub and fake adapter built behind the existing `SchedulerAdapter`; OAuth connect/disconnect, encrypted Page tokens and one target per business built; **worker publishing, the JPEG variant and the `/connections` setup screen built and tested with a fake client**; live Graph client and the owner-approved live connect/publish test **not built/run**; app review and business verification are owner tasks |
| Google Business Profile | review sync (#46) | stubbed client; live client fails closed until access is approved |
| Apify | owner's own Google reviews, removable stopgap (#232) | client proven with one live run; full flow tested with the fake adapter only; hidden without `APIFY_TOKEN`; Google can block scraping at any time |

### Buffer (#29): findings and decisions, 2026-11-01

Detail and sources are in the comment on #29 and in [integrations.md](integrations.md).

- **Model.** Each owner has their own free Buffer account, connects their Instagram/Facebook inside
  Buffer, then connects Buffer to PraiseLoop with OAuth (an *app client*, PKCE). We never front
  everyone's channels on one Buffer account of ours: the API Terms forbid reselling access.
  A personal API key is only for tests against our own account. Who is billed for connected channels is
  inferred (the owner) but not stated in Buffer's docs; confirm with Buffer support.
- **Instagram.** A Professional (Business/Creator) channel gets automatic posting. A Personal one is
  notification-based only (the owner finishes the post in Instagram), so it gains nothing over the
  share sheet and must never be shown as published. `createPost` takes `schedulingType`
  (`automatic` | `notification`) per post.
- **Schedule lives in PraiseLoop.** The worker submits an approved post at its due time with
  `mode: shareNow`; Buffer's own queue is not used. This keeps schedule, cancel and reschedule in our
  code and keeps an image URL public for minutes, not days. The trade-off is that a worker outage delays
  or misses a post, so it needs the existing claims, bounded retries and a visible failed state.
  The adapter now matches (`shareNow`; #29 part 3).
- **Media.** Buffer has no upload; it fetches a public, direct HTTPS URL that must stay reachable until
  publication (no signed or expiring URLs). Decision: unguessable per-draft URLs, enabled only while a
  post is awaiting submission or publication, revoked afterwards, and scoped to approved drafts of the
  owning business. Private media stays behind `/api/media`. Never make draft filenames public.
- **Reconciliation.** No webhooks found: poll post status (`draft`, `needs_approval`, `scheduled`,
  `sending`, `sent`, `error`). `deletePost` and `editPost` exist. Any timeout after submission is
  ambiguous and must not be retried blindly.
- **Callback.** `https://dev.praiseloop.ca/api/buffer/callback` (dev, through the `praiseloop-dev`
  tunnel) and a production URL; Buffer rejects `http://localhost`. The callback needs both a server-stored,
  single-use, 10-minute `state` and the browser's own session, and the two must name the same owner
  (otherwise a victim could be tricked into attaching their Buffer account to an attacker's account).
  The web app and the callback share one host, so the session cookie is present.
- **Risks.** A brand-new Instagram account was suspended soon after creation and connection to a
  scheduler, so test with an established Business account and the owner's agreement, never a throwaway.
  Owners need a second (free) account and a one-time connect step. Free Buffer allows 10 scheduled posts
  and 1,000 API requests per channel per month. Any externally visible test post needs the maintainer's
  approval and the connected account owner's.

### Direct Meta publishing (#234): feasibility, 2026-11-05

The owner wants Buffer gone, so #234 replaces it with direct Instagram and Facebook Page publishing
through Facebook Login for Business. The gate passes but remains owner-blocked on a Meta app,
Business Verification and App Review. The shared `SchedulerAdapter` is the provider seam: a
`MetaSchedulerAdapter` and a fake adapter exist, the live client fails closed, and the OAuth
connect/disconnect backend, encrypted Page tokens and one target per business are built. Worker
publishing is built in the shared provider worker (`bufferPosting.ts`): the gate is still
`BUFFER_POSTING_MODE`, the provider is fixed on the claim when the owner schedules (Meta wins over
Buffer for a business with both), plan, ownership and target state are re-checked under the claim
lock, and Instagram's create-container → commit-id → publish flow resumes from the container id
instead of double-posting. The deterministic JPEG variant lives in `imageRenderer.ts` and is served
by the tokenized public route as `.jpg`. The `/connections` screen shows the Meta section beside
Buffer, fails closed to "not available yet" without app credentials, and reuses the existing target
routes; onboarding links to it optionally and never requires Buffer or Meta. The live Graph client
and the owner-approved live connect/publish test are not built/run. The dated findings, permissions,
token lifetimes, media rules, rate limits and sources are
in [integrations.md](integrations.md#direct-instagram-and-facebook-publishing-234--checked-2026-11-05).
Two findings shape the implementation: Instagram accepts only a public **JPEG** (the renderer writes
PNG, so a JPEG variant is needed), and Meta's docs disagree on whether the Instagram container
endpoints take the Page token or the User token, to be settled by the owner-approved live test.

## 7. Feature status

| Area | State | Issues |
| --- | --- | --- |
| Weekly generation, approval, slots, branding, CSV import, onboarding | shipped | #9, #24–#28, #30, #43–#45 |
| Plans/entitlements, plan page, public plans page | shipped; paid web plans through Stripe checkout | #94, #133, #134, #223 |
| Subscription tables, provider interface, fake checkout, cancel on deletion | built; no real provider event in tests beyond fixtures | #219, #220 |
| Stripe web checkout, webhook and customer portal | built; Stripe test-mode run **not run** (webhook secret not configured) | #223 |
| Email-code, Google, linked methods, profile (web + phone), delete account | shipped | #149–#151, #156, #157, #93 |
| Invite-only sign-up (pilot gate) | shipped; production sets `SIGNUP_MODE=invite` | #195 |
| Phone queue, detail, share sheet, Save to Photos, new version | shipped; device runs pending | #86, #87 |
| Demo owner picker, dev seeder | shipped | #129, #154 |
| Brand voice from a website (Pro) | shipped | #97 |
| Microsoft sign-in | shipped; never run live | #158 |
| Sign in with Apple | phone + server shipped; **web not built** | #92 |
| Native Google sign-in, push notifications | shipped; **need a development build and a device** | #85, #89 |
| Android APK release pipeline | merged; not yet run | #190 |
| Real scheduler through Buffer | Paid (Pro and Business) automatic posting; Connect + screen built; worker posting, image links, cancel and the off/draft/live gate built (#29 part 3); **never run live**; status display and `unknown` resolution not built | #29, #216 |
| Direct Instagram/Facebook publishing | Worker publishing, provider choice, idempotent container resume, JPEG variant, owner status, Connect backend and the `/connections` setup screen built; provider-neutral posting banner and optional onboarding link built; **live client not built and the live connect/publish test not run** | #234, #244 |
| Google review sync, AI review replies | blocked on access/policy | #46, #96 |
| Apify Google reviews stopgap | built; client proven with one live run, full flow not yet run live; hidden without `APIFY_TOKEN` | #232 |
| Google Takeout review import | built; assumed format **unverified**, needs a real-export check before announcing | #233 |
| Business tier | planned, see [billing.md](billing.md) | #222, #225 |
| Store subscriptions, VPS, pilot hosting, store accounts | not started / owner tasks | #95, #98, #90, #91 |
| Email + password | needs explicit owner approval first | #159 |

Open work and blockers are tracked in GitHub issues; this table is a snapshot.

## 8. Cross-cutting rules (what reviewers will check)

1. **One implementation per rule.** Sign-in linking, plan limits, the draft lifecycle and media
   deletion each live in one module; add to it rather than copying.
2. **Enforce on the server, on every write path.** A UI gate is not a gate. Check entitlements on
   *each* endpoint that writes the gated thing (e.g. brand voice: learn, manual save), and decide what
   happens to existing data after a downgrade (keep the ability to *remove* it).
3. **Fail closed.** Missing config makes a feature unavailable (hidden button, 401, clear error), never
   a crash or a silent fallback. Live provider clients stay closed until access is approved.
4. **Untrusted input is bounded everywhere.** For anything fetched from or sent by a stranger:
   resolve and verify, then connect to the verified address; bound size, redirects and time
   *including DNS*; parse in linear time (no regex that scans ahead from every character); treat
   the content as data in prompts; never log it.
5. **Secrets and privacy.** No secrets in the repo or logs; sanitized error codes; tests use
   synthetic data (`@example.invalid`). Account deletion removes everything and keeps nothing.
6. **Idempotent and retry-safe background work.** Outbox rows, leases and unique keys, so a restart
   or a duplicate delivery changes nothing.
7. **Never auto-post.** Approval is explicit; sharing is owner-reported.
8. **Document decisions.** New dependency, provider or architectural change: add an entry to
   [decisions.md](decisions.md) with the reason and, for external services, dated sources.

### Lessons from review (mistakes that were caught more than once)

- *Shared files.* Rendered images can be referenced by more than one row/owner and older versions
  stay on disk. Deleting data must remove only files nothing else references, sweep superseded
  versions, and cope with work still in flight (a render that finishes after the draft is gone).
- *Per-app identifiers.* A provider's `sub` can differ per client id; pick the identifier that is
  stable across your clients (`oid` for Microsoft) before you build linking on it.
- *Races in client state.* Async responses must be tied to the entity that started them (switching
  business mid-request); keep per-entity state; don't reload a whole form to refresh one field;
  serialize operations that touch the same server record (push register/unregister).
- *Cleanup that can fail.* If an unregister/cleanup can fail offline, persist the intent and retry,
  and make the retry work when a different owner is signed in.
- *Tool behaviour claims.* Check what a CLI or library actually does before writing docs about it
  (e.g. `eas init` cannot write a project id into a TypeScript config).
- *Environment reach.* Expo only sees its own environment; GitHub Actions variables don't reach
  EAS cloud builds; compose services only get what the compose file passes.

## 9. How to change things

- **New API route**: file under `app/api/...`, export handlers wrapped in `ownerRoute`, put logic in
  `lib/services/`, add it to `OWNER_WIDE_PATHS` if it isn't business-scoped, and extend
  `scripts/test-authorization.ts` only if it must be public. Keep phone-facing changes additive.
- **New table/column**: a numbered migration, an issue, tests, and a check of the dev seeder
  (`scripts/dev-seed.ts`, `scripts/seed/`, `sample-data/`; `scripts/test-dev-seed.ts` fails if the
  seeder no longer runs).
- **New sign-in provider**: verifier in `lib/<provider>IdToken.ts` modelled on Apple/Microsoft
  (RS256 only, issuer, audience from env, local-key tests), a route under `app/api/mobile/session/`,
  go through `signInWithIdentity`, decide explicitly whether its email may link, allow-list the
  public route in the authorization test.
- **New plan limit**: add to `entitlements.ts` for both plans, the display helpers
  (`lib/plansDisplay.ts`), the tests, and gate every write path.
- **New phone screen/module**: lazy-require any native module, keep logic in small pure modules
  with jest tests, handle 401 through the session provider, and keep the screen working without the
  module.
- **New env variable**: `.env.example`, both compose files (web/mobile service as needed),
  `docs/development.md`, and fail closed when unset.
- **Tests**: plain `assert` scripts in `scripts/test-*.ts`, appended to the `test` chain in
  `package.json`; phone tests are jest under `mobile/__tests__`. Database suites **skip silently
  unless `TEST_DATABASE_URL` is set** (generation-queue also needs `TEST_REDIS_URL`) — set them.
  Run `npm run lint && npm run typecheck && npm test`, and `cd mobile && npm run typecheck && npm run lint && npm test`.

## 10. Working agreements

- One PR per issue, `Closes #n` (or `Refs #n` for partial work), tests required, no dependency
  upgrades unless asked, squash merge is disabled (`gh pr merge --rebase`), linear history.
- The `master` ruleset requires **all review threads resolved**. Automated Codex review leaves
  threads; answer each with what changed (or why not) and resolve them before merging.
- Work happens in a git worktree on its own branch, never in the main checkout.
- Never merge, tag or release unless asked. Never print or commit secrets.

## 11. Known gaps and decisions still open

- **Owner setup not done**: Microsoft Entra app, Apple developer account and keys, Expo/EAS and
  Firebase for push, Google Business Profile API access, hosting/domain for the pilot (#90, #91).
- **Apple-only owners** can't set up a business: the web has no Apple sign-in and the phone has no
  setup flow. They must link Google first. A phone-to-web session handoff (or web Apple sign-in) is
  the proper fix.
- **Store subscriptions** (#95) and a VPS (#98) are not started; paid web plans come from Stripe
  checkout (#223) and Business pricing is still open (#222).
- **Replies to Google reviews** (#96) need a decision on the write API before any code posts.
- **Manual checks never run on hardware**: native Google/Apple/Microsoft sign-in, push, Save to
  Photos and the Instagram/Facebook share behaviour (#85–#89, #92).
- **Buffer (#29)** has its Connect backend built (#29 part 1): OAuth with PKCE, encrypted access and
  refresh tokens, and one selected Instagram/Facebook channel per business. The web connections
  screen is built (#29 part 2). Posting is built behind `BUFFER_POSTING_MODE` (default off, #29 part 3) and
  is a paid feature (#216): the server refuses Free and expired plans at connect, channel selection,
  slot confirmation and just before the worker sends, and a queued post fails closed when a plan lapses.
  There is no phone UI and no live post has been made. Two questions still need
  Buffer support: who is billed for
  channels an app connects, and whether multi-customer commercial use fits the API Terms (only partly
  readable; a person should read them). No live test post has been made.
- **Google sign-in on the phone** needs a development build, not Expo Go (native module), plus an
  Android-type OAuth client with the signing key's SHA-1; the `EXPO_PUBLIC_*` values are already passed
  through compose.
- **Email + password** (#159) reverses the "no password database" stance and needs explicit approval.
