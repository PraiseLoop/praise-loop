# Decisions

Decision log to capture architecture/product calls and why they were made.

## Format

- Date: YYYY-MM-DD
- Decision: short title
- Why: rationale and constraints

---

## Log

- Date: 2026-11-05
  Decision: Publish directly to Instagram and Facebook Pages through Facebook Login for Business, first as a stub with a fake adapter (#234)
  Why: One Facebook Login for Business flow returns the Page, its Page token and the linked Instagram professional account in `GET /me/accounts`, so a single Connect step covers both targets. Meta recommends its newer Unified Login for new integrations, but Unified Login and Instagram Login do not publish to Facebook Pages and an app may not use both login types, so the Page requirement decides this. Page access tokens have no time expiry (though Meta can invalidate them), so only that token is stored, encrypted, and the long-lived User token is discarded after Connect; this avoids a 60-day refresh job. Meta's docs disagree on whether Instagram container endpoints accept the Page or User token, so the owner-approved live test will settle it rather than a vendor post. Publishing needs Advanced Access, App Review and Business Verification (Meta says a decision within about a week; verification has no published turnaround), and PPA/2FA on the Page cannot be detected through the API. Images must be publicly reachable JPEG up to 8 MB in a 4:5–1.91:1 frame; the existing tokenized `/api/public-media` link can be reused, but the renderer's PNG needs a JPEG variant. Publishing limits (50 per 24 hours, 400 containers, 4,800 × impressions API calls) are far above the 5-posts-a-week paid limit. The stub implements the existing `SchedulerAdapter`, the fake adapter is tested, and the live client fails closed with `MetaAccessNotApproved`; no OAuth route, database table or live call exists yet.

- Date: 2026-11-04
  Decision: Cancel every live provider subscription before deleting an owner's account (#220)
  Why: Deletion used to remove `owner_subscriptions` locally without telling the provider, so a deleted owner could keep being charged. `cancelOwnerSubscriptions` reads every row whose status can still bill (anything except `canceled` and `incomplete_expired`, including `past_due`, `unpaid`, `incomplete`, `paused` and cancel-at-period-end) and calls `BillingProvider.cancel(externalId)` outside the deletion transaction, before any local data is removed. The call ends billing immediately and must be idempotent, because a retry after a partial failure calls it again. If any cancel fails, or a non-store row has no adapter in this process, the route answers `503` and deletes nothing, keeping the sessions so the owner can try again. App Store and Google Play rows are skipped because only the owner can cancel them, and both confirmation screens now say so. An owner with no subscriptions never loads a provider or makes a network call. A provider event that arrives for a deleted owner is acknowledged with `ignored: true` and writes no event, subscription or plan row. The cancellation happens before the local transaction, so a subscription created in the gap between the two steps is a known race left out of scope.

- Date: 2026-11-04
  Decision: Pause generation for businesses above the plan's limit after a downgrade, keeping the oldest ones active and deleting nothing (#217)
  Why: The business limit was only checked when a business was created, so a lapsed owner kept every business generating. Now `businessAllowance` in `lib/services/entitlements.ts` orders an owner's businesses by `created_at` then `id` and marks all but the first `limits.businesses` as paused. `requestGeneration` checks it inside the same transaction and business lock that reserves the week's quota, through the effective plan from `entitlementsFor`, so an expired plan counts as Free and a paused business creates no drafts, no period and no reserved quota. Nothing is deleted: every business and its existing drafts stay visible, and existing drafts can still be approved. `GET /api/entitlements` adds an optional `paused` flag per usage entry so the web and phone can show the pause and link to the plans page. Upgrading raises the limit and resumes the paused businesses on the next request with no data change. A picker for which business stays active is a possible follow-up; the oldest-first rule is the default for now.

- Date: 2026-11-04
  Decision: Keep manual grants and provider subscriptions in separate tables and resolve the highest active plan (#219)
  Why: One `owner_plans` row held one source, so a provider's expired event could downgrade an owner with another active subscription or a manual grant. `owner_plans` stays the manual grant and provider events never write it; `owner_subscriptions` holds one row per provider subscription and `billing_events` records each provider event once on `(provider, event_id)`. `entitlementsFor` reads both and ranks active grants with `PLAN_ORDER`, so adding a tier cannot leave a hardcoded list behind. One `applyBillingEvent` path inserts the event, ignores duplicates, ignores an event older than the stored provider event time, and upserts the subscription in one transaction, appending `owner_plan_events` only when the subscription state actually changes. Statuses that grant a plan live in `subscriptionIsActive`, with a grace period for `past_due`. The provider interface and a fake adapter sit in `lib/integrations/billing.ts`; `BILLING_PROVIDER=fake` selects it only outside production and the dev-only `POST /api/dev/billing` walks checkout, renewal, failed payment and cancellation through the same path a real webhook will use. No real provider, network call or payment is included.

- Date: 2026-11-04
  Decision: Ship four quote-card designs, with Free keeping Classic and Pro/Business getting all four (#230)
  Why: The `templates` limit needs a real feature behind it, and quote-card layouts are visible Pro value that needs no outside approval. The three new designs (`quote-card-v2` Spotlight, `quote-card-v3` Split, `quote-card-v4` Framed) use the existing Sharp/Pango renderer, the existing Bricolage Grotesque font and embedded logos, so no dependency or schema change is needed. The design name stays in `businesses.brand_colors`, the same JSON as the colours and text size. `quote-card-v1` is frozen: its function is unchanged so every existing business and rendered file stays byte-identical, and content-addressed filenames mean a new design creates a new file rather than rewriting an old one. The server checks the effective plan through `entitlementsFor` when a business is created and when brand settings are saved, and it only refuses a *new* design the plan does not include. After a downgrade the saved choice stays in the row, but the renderer falls back to `quote-card-v1` for new images until the plan allows it again; existing images are untouched. Free therefore has one design and Pro/Business have four, which is the number shown on `/plans`, `/account` and the phone.

- Date: 2026-11-04
  Decision: Allow an email allowlist to upgrade itself to Pro for testing, as a narrow exception to operator-only plan changes (#227)
  Why: The owner wants to change a test account's plan without shell access to the worker. #94 keeps `/api/entitlements` read-only, so this is a separate route that is off unless `SELF_SERVICE_UPGRADE_EMAILS` is set, and every change is written to `owner_plan_events`. Matching on `auth_users.email` is safe because sign-in only stores an address there for providers that guarantee it (Google, our own email codes); Apple and Microsoft owners have no email there and cannot match. It unlocks Pro with no payment, so it is a testing aid and #223 removes it before real payments.

- Date: 2026-11-04
  Decision: Start billing with Stripe web checkout and three tiers, keeping store subscriptions for before public App Store release (#213, #225)
  Why: The owner expects the first customers on the web, the store accounts (#91) are still open, and Stripe costs about 5% on a CA$29 charge against about 15% through the stores. Stripe alone does not cover the App Store release: Apple's 3.1.3(b) allows access to web-bought subscriptions only if they are also sold as in-app purchases, so #95 stays required and the phone shows plan status with no upgrade prompt until then. One `owner_plans` row cannot hold several payment sources, so subscriptions get their own table and the owner receives the highest active plan. Plans change only from a verified webhook, and owners still cannot change their plan through `/api/entitlements`. Findings, dated sources and the order of work are in docs/billing.md. CA$29.99 a month is a working figure until #223 records it with `PLAN_PRICING`, as `scripts/test-plans.ts` requires. Nothing is built by this entry.

- Date: 2026-10-31
  Decision: Add Microsoft Entra ID sign-in on web and phone with the existing `jose` verifier and `expo-auth-session` (#158)
  Why: Many small organizations run on Microsoft 365 and have no Google account for work. The web can use NextAuth's built-in `azure-ad` provider with `tenantId: "common"`, so it needs no new dependency and keeps the same database-session and adapter machinery as Google. The phone needs a browser-based OAuth flow rather than a native account picker, so `expo-auth-session` (with `expo-crypto` and `expo-web-browser`, installed through `npx expo install` for SDK 58) provides discovery, PKCE and the code exchange; it is the only dependency this change adds and is loaded lazily like the other native modules so Expo Go and Jest still start. The server verifies the ID token with the existing `jose` dependency against Microsoft's multi-tenant JWKS, accepts only RS256, requires `exp`, `sub` and the tenant-scoped object id `oid` (the identity is `tid:oid`, because `sub` differs per app registration), checks the audience against `MICROSOFT_CLIENT_ID`, and validates the v2.0 issuer pattern plus the `tid` claim instead of a single fixed issuer. The subject is `${tid}:${sub}` so tenants cannot collide. Microsoft's `email` claim is not guaranteed verified, so the shared policy receives `emailVerified: false`: a Microsoft sign-in always creates its own owner or is linked from a signed-in session, never by email. NextAuth's provider id stays `azure-ad` (the documented callback path) while `auth_accounts` stores the canonical `microsoft` name; the adapter maps between them and the provider profile id is the same tenant-qualified subject. No live Microsoft sign-in or device check was run.

  Decision: Learn a brand voice from one public page with a bounded, dependency-free fetcher (#97)
  Why: Owners want captions that sound like their business instead of a tone dropdown. A website URL is the smallest useful source and avoids social-account scraping. `lib/services/safeFetch.ts` uses `node:dns`, `node:net`, `node:http`/`node:https` and no new dependency: it verifies every resolved address, rejects private, loopback, link-local, CGNAT, multicast and IPv4-mapped forms, and connects to the verified address so DNS rebinding cannot swap it. Redirects stay on the same host or its `www.` variant, with a 5 second timeout, 512 KB body cap and 6,000 characters of text. The profile is produced by the existing caption provider (OpenAI or OpenRouter), so no second AI SDK is added. It is Pro only via a new `brandVoice` plan limit, counts as one `generation` call against the owner's daily AI limit, and is stored in three additive `businesses` columns (1,200 character check). Fetched text is labelled quoted untrusted data in the prompt, and only length/format validation is applied to the result; nothing is stored on failure and neither page text nor voice is logged.

- Date: 2026-10-31
  Decision: Save approved phone posts with `expo-media-library` through the optional Save to Photos action (#87)
  Why: The phone already downloads the PNG through the owner-protected media route for the share sheet, so saving can reuse that cache file without a public URL or a new server route. `expo-media-library` is the Expo SDK 58 module for adding a file to the device library, installed with `npx expo install` so its version stays compatible with the SDK; it is the only dependency this change adds. Permission is requested at press time and write-only (`requestPermissionsAsync(true)`) because the app never reads the library; the config plugin supplies `NSPhotoLibraryAddUsageDescription`, `NSPhotoLibraryUsageDescription` and the Android photo permission at prebuild. The native module is required lazily like Google Sign-In so Expo Go and Jest still start without it, and Save to Photos reports that it is unavailable instead of crashing. The cached copy is deleted after every attempt.

  Decision: Use `expo-notifications` and `expo-device` for the phone's weekly reminder, with the native modules loaded lazily (#89)
  Why: The server half (#88) already sends "posts are ready" through Expo's push service, so the app only needs to obtain an Expo push token, register it at `POST /api/mobile/push-tokens`, and open `praiseloop://queue?businessId=...` when the owner taps it. `expo-notifications` is the Expo-supported module for permission, token and notification-response APIs; `expo-device` is only used for `Device.isDevice`, because a simulator cannot receive a push even though the module loads. Both are required through a try/catch `require`, like the native Google module, so Expo Go and Jest still start; push is reported unavailable in Expo Go, on simulators and without an EAS project id, and no OS prompt is shown there. The permission choice lives in the existing `expo-secure-store` rather than adding another storage dependency, and a target tapped before sign-in stays in memory until the session is ready. A physical iOS/Android delivery test and the APNs/FCM owner setup remain manual checks.

  Decision: Verify Apple identity tokens with the existing `jose` setup and use `expo-apple-authentication` for the native button (#92)
  Why: Apple identity tokens are RS256 JWTs with a stable `sub`, so they fit the same JWKS verification already used for Google and need no new server dependency. `lib/appleIdToken.ts` checks Apple's published keys (cached), issuer `https://appleid.apple.com`, expiry, and only the audiences listed in `APPLE_CLIENT_ID`; a missing setting fails closed. `expo-apple-authentication` is Apple's Expo-supported native module and the only new dependency; it is a lazy `require` like the Google module, so Expo Go, Jest and Android still start without it. The phone requests `FULL_NAME` and `EMAIL`, sends the token once to `POST /api/mobile/session/apple`, and stores only our bearer session. Apple sends the name only on the first authorization, so the app forwards it separately and `fillProviderName` fills a missing name without replacing an owner-edited one. Web Apple sign-in is deferred: it needs a Services ID, a `.p8`-signed client secret and domain verification, none of which the native App Store requirement needs. No device or simulator check was run.

  Decision: Apple sign-in never links to an existing owner by email (#92, #156)
  Why: Issue #92 says not to auto-link to a Google owner by email, and linking accounts is a separate decision. Apple's address can also be an `@privaterelay.appleid.com` relay that is not the owner's mailbox, so matching it to an existing `auth_users.email` could attach an Apple sign-in to the wrong person. The identity is the Apple `sub`; the address is kept on the method row for display. An owner who wants Apple and Google on one account links Apple from a signed-in session, which already proves control of the owner, and the rule that rejects a second subject for one provider still applies.

- Date: 2026-10-31
  Decision: Use `@react-native-google-signin/google-signin` 17 for native Google sign-in on the phone (#85)
  Why: The app needs the device's Google account picker and an ID token to exchange at `POST /api/mobile/session`; a browser redirect would leave the app and cannot reuse the installed account on iOS. The library has an Expo config plugin that registers the iOS URL scheme at prebuild, and the client IDs are public values supplied through `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` and `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`, never a secret. It includes native code, so Google sign-in works only in a development or store build, not Expo Go; `TurboModuleRegistry.get("RNGoogleSignin")` is checked before the JS package is imported, so a build without the native module hides the Google button instead of throwing while the package's `getEnforcing` spec loads, while demo and email sign-in keep working there. The ID token is sent once and never stored or logged; only our bearer session goes to the keychain.

- Date: 2026-10-30
  Decision: Show initials instead of Google's profile picture on owner avatars (#149)
  Why: The profile API needs a stable fallback while Google does not always supply a name, and an avatar is not worth another network dependency or privacy surface now. Initials come from the name (or the email's local part) on the server, so both clients render the same thing without fetching anything. If a picture is added later, store it locally rather than hotlinking Google's URL, which can expire and leaks the owner's browsing to the image host.

  Decision: Identify an owner by provider plus stable subject, and use a verified email only as a fallback link (#156)
  Why: One owner will have Google, email-code, Apple and Microsoft methods, and two failure modes have to be impossible: one person getting two owners, and one person inheriting another person's owner because an address moved. Therefore a returning subject always signs in as its own owner; an email can find an owner only when the provider guarantees the claim (Google today, our own code later) and the subject is not already linked to a different owner for that provider; a provider with an unverified email claim creates a separate owner. A live session can always attach another method because it already proves control of the owner, but the last method cannot be unlinked. The policy lives in `lib/authLinking.ts` and is called by both the NextAuth callback and the mobile exchange, instead of relying on NextAuth's provider-specific email linking. `auth_accounts` records the method's own email, when it was added and last used; no provider tokens are stored. No support override exists in code, and merging two owners stays an operator task.

  Decision: Send transactional email through Resend's HTTP API behind a transport interface, with a fake outbox for tests and the dev stack (#155)
  Why: Options checked 2026-10-30: Resend (free 3,000/month with 100/day on 3 domains; paid from $20/month for 50,000 — https://resend.com/pricing), Postmark (free 100/month; paid from $15/month for 10,000 — https://postmarkapp.com/pricing), Amazon SES (Essentials from $0.16 per 1,000 — https://aws.amazon.com/ses/pricing/), and Cloudflare Email Service (Email Sending is beta and needs Workers Paid; 3,000/month included then $0.35 per 1,000 — https://developers.cloudflare.com/email-service/platform/pricing/). All four support a verified own domain with SPF, DKIM and DMARC; the pilot's Cloudflare Tunnel does not make Cloudflare the default sender. Resend has the smallest setup and a free tier large enough for the pilot, documents a plain `text` field, an Idempotency-Key and automatic hard-bounce suppression, and needs only `fetch` (no new dependency). SES is cheapest at volume but needs AWS IAM and production-access approval; Postmark's 100-message free tier is too small to re-send codes; Cloudflare sending is still beta. Plain SMTP to a mailbox provider was rejected because it adds credential and connection management without removing the provider, and every candidate already offers SMTP later if needed. Resend will not send from a shared domain to arbitrary recipients, so #90's hostname must resolve to a domain the owner controls; one test to the account owner's own address is possible before DNS is ready. `lib/email.ts` uses the fake transport outside production (in-memory outbox plus one log line so the dev can read the code) and Resend in production once `EMAIL_FROM` and `RESEND_API_KEY` are set; a missing setting fails closed with `EmailError` (`email_unavailable`), and tests never reach the network. Messages are plain text first (one-time code now, reset link later), with no HTML, tracking pixels, review text or secrets in real-transport logs, and a process-local throttle limits both recipient and sender. Permanent bounces go to Resend's suppression list; complaint webhooks and DNS setup are owner/follow-up work. The owner creates the Resend account and domain records, and no live send was run in this PR, so #152's email issues stay blocked until that test is recorded.

- Date: 2026-10-30
  Decision: Link an email sign-in to an existing owner only when the verified address matches, and never merge two owners (#152, #156)
  Why: `auth_accounts` already keys identity on provider plus stable subject id. The email method uses the normalised address as its subject; a code proves control of that mailbox, so an owner already known by that address keeps one owner and gains a method, while a different address always gets a new owner. Google owners keep their rows and businesses unchanged. The residual risk that a reassigned address can recover the owner it was registered to is inherent in passwordless email and is documented in `docs/auth.md` instead of being hidden behind an automatic merge.

- Date: 2026-10-28
  Decision: Allow OpenRouter as the caption provider, with the model supplied only by `OPENROUTER_MODEL`
  Why: The pilot has no OpenAI or Anthropic key and wants to start on OpenRouter's free models. It speaks the OpenAI chat-completions shape, so it is a second branch inside the existing `fetch` caller with no new dependency. The model is a required setting with no default because free model ids change and a guessed id would fail in production; without it nothing is sent. OpenAI keeps priority when both keys are set, so existing deployments are unchanged. Free models are rate limited and may log prompts (reviewer quotes), so use real customer reviews only after checking the chosen model's data policy.

- Date: 2026-10-27
  Decision: Send "posts ready" notifications through the Expo push HTTP API with `fetch`, not `expo-server-sdk`, and record each send in `push_deliveries` (#88)
  Why: Only two endpoints (send, getReceipts) are needed, so a plain, timeout-bounded `fetch` avoids a new dependency. A unique `(business_id, period_start, token)` delivery row makes one send per device per weekly period survive worker restarts; attempts are capped at three. Tokens reported as `DeviceNotRegistered` (by ticket or receipt) are deleted. Payloads carry only a count, the business name and a `praiseloop://queue` deep link. The transport is injectable so tests never call Expo.

- Date: 2026-10-26
  Decision: Accept hashed bearer sessions for the native app alongside NextAuth cookies (#80)
  Why: Native apps send neither cookies nor a matching Origin. `auth_sessions` gains a `kind` (`web` or `mobile`) and `created_at` so mobile sessions can slide for 30 days under a 90-day absolute cap without changing the web's eight-hour sessions. Both credentials in one request are rejected, and origin checks stay for cookie writes where CSRF applies. One guard still enforces ownership, upload size and limits for every route.

- Date: 2026-10-26
  Decision: Publish `linux/amd64` web and worker images to GHCR from CI (#102)
  Why: The pilot server and a future VPS both run x86-64, so building and pushing a single platform keeps the pipeline fast; add `linux/arm64` only if an ARM host is planned. PRs build without pushing so Dockerfile breakage is caught in review, and master pushes only after `verify` passes using the built-in `GITHUB_TOKEN` with `packages: write`. Images contain no secrets; runtime configuration stays in the environment. Package visibility remains an owner decision before #90 goes live (private needs a `read:packages` token to pull).

  Decision: Use Expo SDK 58, Expo Router and Jest/`jest-expo` for the app in `mobile/` (#84)
  Why: One TypeScript codebase covers iOS and Android while the web dependencies and Docker build stay unchanged (`mobile` is excluded from the root tsconfig, ESLint and `.dockerignore`). Expo Router gives file-based navigation for the queue, sign-in and update screens. Jest with the Expo preset runs in CI without a device or EAS account; EAS Build is optional and local builds also work. The bundle ID/package name is a placeholder until the owner confirms it in #91.

- Date: 2026-10-15
  Decision: Use a consented manual observation ledger and offline pilot report for #47
  Why: Current draft status/updated_at cannot reconstruct approval edits or session history. Explicit observations preserve unknown values, exclude synthetic businesses and avoid collecting review text or adding an unauthenticated report endpoint. No analytics platform or new dependency; human pilot outcomes remain unverified.

- Date: 2026-02-27
  Decision: Use lightweight markdown docs for alignment
  Why: Fast to edit, easy to review, low process overhead. Keeps intent, architecture, and workflow explicit without heavy tooling.

- Date: 2026-10-14
  Decision: Refresh dependencies, Docker, and build tooling to a supported baseline (issue #48)
  Why: Reproducible installs (npm ci + lockfile), real ESLint, multi-stage Docker builds with healthchecks, Node 22 baseline, CI. Upgrades stayed within current major versions (Next 15, React 19, TypeScript 5); Next 16 / TypeScript 7 major upgrades are deferred. Redis/BullMQ queue remains planned — the worker stays a timer loop until #41.

- Date: 2026-02-27
  Decision: Require explicit decision logging for architectural changes
  Why: Prevent re-litigating the same choices every week and reduce AI-driven drift in architecture over time.

- Date: 2026-02-27
  Decision: Build as a SaaS web application (not a library/framework)
  Why: The product is a revenue-generating automation tool for local businesses. It requires onboarding, dashboards, approval flows, and scheduling — not just reusable code.

- Date: 2026-02-27
  Decision: Use Node.js + TypeScript + Next.js
  Why: Strong ecosystem for API integrations, background jobs, and rapid product iteration. Type safety helps maintain architectural discipline as the codebase grows. Next.js supports both UI and API in one deployable unit.

- Date: 2026-02-27
  Decision: Use Postgres as primary datastore
  Why: Relational model fits businesses, reviews, drafts, and scheduling states well. Strong consistency guarantees and mature tooling. Avoid premature NoSQL complexity.

- Date: 2026-02-27
  Decision: Use Redis + BullMQ for background jobs
  Why: Review ingestion, quote extraction, image rendering, and scheduling are asynchronous tasks. A job queue ensures retries, observability, and reliability.

- Date: 2026-02-27
  Decision: Deploy MVP via Docker on existing VPS
  Why: Lowest cost, full control, fast iteration. Infrastructure simplicity outweighs managed-service benefits at early stage.

- Date: 2026-02-27
  Decision: Scheduler-first publishing strategy
  Why: Direct platform integrations (Instagram, X, Facebook, etc.) are complex and policy-heavy. Integrating with a scheduler (e.g., Buffer) reduces integration surface area and accelerates MVP delivery.

- Date: 2026-02-27
  Decision: Human-in-the-loop approval required for MVP
  Why: Protect brand voice and reduce risk. Auto-posting introduces reputational and legal risk. Manual approval builds trust and reduces AI hallucination exposure.

- Date: 2026-02-27
  Decision: PR-only development workflow (no direct pushes to main)
  Why: Prevent accidental architecture drift or destructive changes from AI agent. Maintain human oversight and review discipline.

- Date: 2026-10-15
  Decision: Render quote cards with Sharp's Pango text backend and DejaVu fonts (#8).
  Why: Actual glyph rasterization and measured wrapping replace unsupported SVG foreignObject layout. Runtime containers install the same font family; bounded embedded raster logos eliminate remote fetching and its SSRF risk. No text is silently shortened.

- Date: 2026-10-15
  Decision: Store quote-card-v1 options alongside existing brand colors (#26).
  Why: One typed template and two text sizes need no template framework. The sample preview uses the production renderer without persisting draft assets; default migration preserves colors and existing generated images.

- Date: 2026-10-15
  Decision: Enforce review identity in Postgres and preserve historical duplicates (#45).
  Why: Concurrent imports need a unique constraint, not check-then-insert. Normalize NFKC/case/whitespace and UTC milliseconds only for identity; retain original wording. Keep duplicate rows and their draft references under legacy keys, excluding them from new selection. Stable source IDs take precedence over imperfect manual fingerprints.

- Date: 2026-10-15
  Decision: NextAuth GitHub login with revocable database sessions and explicit legacy claims (#42). Superseded by the 2026-10-18 Google sign-in decision below; sessions/claims unchanged.
  Why: A maintained OAuth implementation handles sign-in/CSRF cookies. The minimal adapter stores no provider tokens and hashes session tokens. Shared server guards authorize every API family; DB counters persist generation limits. Media moves outside public with legacy URL denial. No password database, team roles or production provider setup.

- Date: 2026-10-15
  Decision: BullMQ delivery with a Postgres generation outbox, weekly reservations and renewable claims (#43).
  Why: Transactional business locks enforce quotas alongside draft uniqueness, while BullMQ provides the documented durable queue. An outbox recovers Redis loss without creating replacement drafts. Persisted stages bound redundant paid calls; retries and daily owner counters cap exposure.

- Date: 2026-10-15
  Decision: Serialize draft edits with revisions, transactional policy and append-only audit events (#44).
  Why: Every mutation shares ownership/lifecycle checks and a transaction context; stale revisions fail instead of overwriting edits. Approval decodes the persisted PNG. Rendering uses content-addressed filenames so approved artifacts cannot change in place. Chromium browser checks use playwright-core with an explicitly installed browser, never paid providers.

- Date: 2026-10-15
  Decision: Keep #29 blocked until owner Buffer access and a permitted live test are available.
  Why: Official GraphQL/OAuth-PKCE, scheduling/media and rate-limit interfaces are documented in integrations.md with dated references. No configured account/channel, encryption key or public media origin is available. Retire false stub success and content logging; no alternative provider, scraping or unverified live success is substituted.

- Date: 2026-10-15
  Decision: Keep Google sync #46 blocked at its access/reuse-policy feasibility gate.
  Why: Dated official prerequisites, OAuth/review contracts and policy references are captured in integrations.md. No approved project or permitted live location is configured, and temporary storage/manipulation rules need clarification for social reuse before adding a connector. Owner approval cannot substitute for provider access or policy resolution; no scraping/mock success.

- Date: 2026-10-18
  Decision: Use Google instead of GitHub as the owner OAuth provider (#76).
  Why: Pilot customers are small-business owners who rarely have GitHub accounts but usually have Google, often the account behind their Business Profile. Only openid/email/profile are requested, so no sensitive-scope verification is needed. Adapter, hashed database sessions, token discarding and ownership guards are unchanged. No GitHub app or real owners existed, so no account migration.

- Date: 2026-10-26
  Decision: Go mobile-first: an Expo app for owners on top of the existing server (#79, docs/mobile-plan.md)
  Why: Owners approve on their phones, not laptops, and a push notification is what brings them back weekly. Keeping the Next.js/Postgres/worker server avoids a rewrite; the app is a thin client over the same API and ownership guard. Expo gives one TypeScript codebase for iOS and Android. The app lives in `mobile/` as a separate package so web dependencies and builds are unaffected.

- Date: 2026-10-26
  Decision: Share sheet first; scheduler integration (#29) becomes a later paid feature (#79)
  Why: #29 is blocked on provider access, credentials and public media. The phone's share sheet lets the owner post the approved image and caption now, with media kept private. A new `shared` status records owner-reported posting and is never presented as verified publication. Approval stays required.

- Date: 2026-10-26
  Decision: Start hosting on the home server behind a Cloudflare Tunnel; move to a small VPS for paying customers (#79)
  Why: The pilot should cost about $0. The same Docker Compose stack runs in both places, and the app uses one HTTPS URL, so moving is a DNS change. Backups off the machine are required in both stages.

- Date: 2026-10-26
  Decision: Monetize through server-enforced plans (free/pro) unlocked by app-store subscriptions (#79)
  Why: AI captions, review sync, AI review replies and more posts per week are worth paying for, while CSV import and one weekly post keep a free tier. Entitlements live on the server so the app can't unlock features itself. The billing provider (for example RevenueCat) is chosen and stubbed in its own issue, as CONTRIBUTING.md requires.

- Date: 2026-10-26
  Decision: Store one plan per owner and enforce entitlements on the server (#94)
  Why: A plan per business could not enforce "more than one business", and store subscriptions attach to an owner anyway. One `owner_plans` row with source and expiry keeps upgrades simple; every owned business inherits the limits. Weekly targets are capped inside the generation lock, the free watermark is part of the deterministic render, and business creation is serialized per owner. Expired plans fall back to free without deleting the record, and `owner_plan_events` records every operator or future billing change.

- Date: 2026-10-27
  Decision: Verify Google ID tokens with `jose` 6.2.13 (#81)
  Why: Verification needs JWKS fetching and caching, RS256 signature, issuer, audience and expiry checks. `jose` does all of it with no dependencies and supports local key sets for fixture tests. `google-auth-library` pulls in a much larger tree for the same job.

- Date: 2026-10-27
  Decision: Land the Buffer adapter and credential encryption behind the still-closed scheduler gate (#29, partial).
  Why: These are safe without provider access: mocked-fetch contract tests cover auth, 429, timeout-after-acceptance (ambiguous, never resubmitted), media failure and incomplete/past drafts. The adapter is not selected by `getSchedulerAdapter()` and its mutation shape is unverified live, so no success is claimed. OAuth, storage, worker jobs and live acceptance remain blocked on owner access.

- Date: 2026-10-27
  Decision: Build Google review sync against a stubbed client interface while API access is pending (#46)
  Why: Approval can take weeks, and the storage, encryption, checkpoint, retry and revoke logic is provider-independent. `liveClient()` throws until access exists, so nothing can call Google or be mistaken for a live integration. Uses Node crypto (AES-256-GCM) and no new dependency; #46 stays open until the live acceptance test in integrations.md passes.

- Date: 2026-11-01
  Decision: Build the Buffer Connect backend first, with owner-wide connections and one selected channel per business (#29, part 1)
  Why: OAuth, encrypted token storage and channel selection are provider-independent of posting and media policy, so they can land and be tested with mocked `fetch` while live acceptance waits on owner access. Connections belong to the owner, not a business, because one Buffer account can serve several businesses. Refresh tokens are single use, so refreshing holds a row lock and stores the replacement token in the same transaction; a lost or rejected refresh marks the connection `needs_reconnect` instead of reusing the old token. The callback is public and authenticated by the single-use state, not a cookie, and always redirects with a fixed outcome code. No UI, posting, scheduling, media URL or worker change is included, and the dev seeder stays without a fake connection because it would need real encrypted tokens.

- Date: 2026-11-02
  Decision: Post to Buffer from the worker at the due time, behind a three-value gate that defaults to off (#29, part 3)
  Why: The schedule stays in PraiseLoop (`shareNow`, never Buffer's queue), so cancel, reschedule and the image link's lifetime are ours. `BUFFER_POSTING_MODE` is `off` (never calls Buffer), `draft` (a Buffer draft, nothing published) or `live`, because merging code that can publish to a real business Instagram must not by itself publish anything; the first real run is a draft. CONTRIBUTING's "never auto-post" is kept: an owner who confirms a specific approved post for a specific slot is explicitly authorizing it, and nothing posts without that confirmation. A late post is `missed` rather than sent at a surprising time, and an unproven outcome is `unknown` and never resubmitted, because Buffer does not deduplicate. Image links are public (Buffer cannot upload or sign), so each is an unguessable token that works only while its post is in flight and is revoked after.

- Date: 2026-11-04
  Decision: Make automatic posting a Pro and Business limit, enforced on every server write path (#216).
  Why: Buffer posting should not be resold to Free owners, and the plan must not depend on Buffer when direct publishing (#234) replaces it, so the limit is named `automaticPosting` rather than Buffer posting. The effective plan comes from `entitlementsFor`, so an expired plan is refused too. Connecting Buffer, choosing a channel, confirming a post for a slot and the worker immediately before sending all check the limit; the UI is not the only gate. A queued post whose owner lapses is not sent and not resubmitted: the worker ends it `error`/`failed` with `plan_required`, and the approval card and schedule tell the owner why. Free owners keep the phone share sheet and image download, approval is required on every plan, and nothing auto-posts.

- Date: 2026-11-04
  Decision: Let owners fetch their own Google reviews through Apify as a removable stopgap (#232)
  Why: Official Business Profile sync (#46) is still blocked on Google access, and the owner chose a stopgap on 2026-11-04 while accepting the risk that Maps terms prohibit bulk downloads and Google may block scraping at any time. Rows use a new `apify_google` source so they can never collide with official `google` rows and can be deleted or reconciled when #46 lands. Each owner must confirm the single place is their own business; that confirmation, who made it and when are stored. Every run carries the plan's review cap, an Apify `maxTotalChargeUsd` spend cap, one run per business per interval and the existing daily owner counter. The request only starts a run and stores its ID; a status endpoint polls it and imports a successful dataset once behind a conditional update, using the same row checks as CSV import. Reviewer names are shortened to first name plus last initial, and reviewer IDs, profile links, photos and review links are discarded. Tests use only the fake adapter and invented data. One owner-approved live run on 2026-11-04 confirmed the actor's URL, request and result fields, and that it accepts a `maps.app.goo.gl` link; see integrations.md.

- Date: 2026-11-04
  Decision: Keep email-code sign-in to an existing Google owner unchanged and add a fresh-code step-up before sensitive billing actions (#221).
  Why: The owner decided the existing sign-in path stays exactly as it is; denying a verified mailbox would remove the documented recovery route for an owner who loses another method. Instead, opening the billing portal or changing a plan will call `requireRecentStepUp`, which needs a code sent to the address on the signed-in owner's `auth_users` row within the last ten minutes. This is a pause before sensitive steps, not strong protection: whoever holds that mailbox can also receive the code, so it does not resolve a reassigned address by itself. Sign-in and step-up codes are stored with separate purposes and cannot be swapped. Only the verifying session is marked, a new session starts unmarked, and owners with no address (Apple or Microsoft) pass only while their session is under ten minutes old. Nothing is logged.
