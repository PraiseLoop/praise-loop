# Owner authentication and access (#42)

Uses maintained NextAuth 4.24.15 (Next 15/React 19 support) with Google and Microsoft
(Entra ID) OAuth and a small Postgres adapter. Sources: https://next-auth.js.org/configuration/providers/google,
https://next-auth.js.org/configuration/providers/azure-ad,
https://support.google.com/cloud/answer/15549945
and https://next-auth.js.org/tutorials/creating-a-database-adapter (checked 2026-10-15).
The adapter stores provider identity only, discards provider access/refresh tokens,
and hashes opaque session tokens. Eight-hour sessions are checked in Postgres on
EVERY protected request; sign-out deletes the server session, including copied tokens.

Owner setup (no accounts, credentials, or production config created by this PR):

1. Run `npm ci` and `npm run db:migrate` (migration 007 preserves unclaimed businesses).
2. In Google Cloud Console (Google Auth Platform), configure an External consent screen
   and create an OAuth "Web application" client. Add authorized redirect URI
   `NEXTAUTH_URL/api/auth/callback/google`. Request only `openid email profile`
   (the provider default, checked 2026-10-18): Google then needs no test-user list or
   unverified-app warning and does not expire sign-ins after 7 days in Testing.
   Adding any sensitive scope (e.g. Business Profile for #46) changes that.
3. Supply `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, a random `NEXTAUTH_SECRET` (32+
   bytes), and canonical `NEXTAUTH_URL`; use HTTPS in production. Never commit values.
   Login and sign-out return an actionable 503 if `NEXTAUTH_URL` or `NEXTAUTH_SECRET`
   is missing. Google sign-in additionally needs the client variables; email sign-in
   does not, and its session can still be signed out when Google is unset. Use
   Sign in / Sign out in nav.
4. Keep DATABASE_URL private to the app/worker/operator. Worker runs in a separate
   process with direct DB access; no bearer token bypass or public worker endpoint.
5. Verify an existing business belongs to the signed-in owner, locate their
   `auth_users.id` privately, then run `npm run business:claim -- BUSINESS_ID AUTH_USER_ID`.
   Claim accepts only an unclaimed business and an existing owner, never assigns all
   data to a registrant, and refuses reassignment. New businesses belong to the caller.

Every API route except NextAuth and the public sign-in routes in the email section below
is wrapped in the same owner guard. Business lists
are filtered server-side; guessed foreign business/draft/media IDs return 404. A
composite FK rejects new cross-business review references without deleting legacy
data; existing violations require operator reconciliation before validating that FK.
Cookie writes require an Origin matching NEXTAUTH_URL and reject cross-site fetches.
Bearer writes skip that check because a browser never attaches the token itself.
Uploads are stream-bounded to 1.5 MB before JSON/form parsing; CSV has tighter limits.

Mobile bearer sessions (#80): `POST /api/mobile/session` (added in #81) creates a
session with `kind = 'mobile'` and returns the raw token once; only its SHA-256 hash
is stored. A request may authenticate with either the NextAuth cookie or
`Authorization: Bearer <43-character token>`, never both. Mobile sessions last 30
days from the last request, capped at 90 days after creation, and
`POST /api/mobile/session/revoke` deletes the calling session. Malformed, expired,
revoked and oversized (over 43 characters) tokens return 401. The same ownership,
CSRF, upload-size and daily-limit rules apply to both session kinds.
Generation attempts use atomic shared per-owner/day UTC counters (default 25,
`OWNER_GENERATION_DAILY_LIMIT`). Preview has a separate 120/day limit. Attempts
consume budget even on provider failure; the UI receives 429 on exhaustion.

Media is private: authorized DB image_path lookup precedes filesystem access, and
responses use private/no-store. `/generated/*` is blocked, including old static files.
Default storage is `private-media/` outside public. Compose mounts the SAME named
volume at `/app/private-media`, retaining its contents. Host installs must move
existing generated files from public/generated into private-media (or an external
MEDIA_ROOT) before restarting. Migration 007 rewrites legacy DB URLs to /api/media/.
Do not expose the media directory through a reverse proxy. #29 supplies deliberate
provider-fetchable media; guessing draft IDs never grants publication access.

## Deleting an account (#93)

`DELETE /api/account` is owner-wide (listed in `OWNER_WIDE_PATHS`, not
business-scoped) and works with both the NextAuth cookie and a mobile bearer
session. It requires a JSON body of `{"confirm": "DELETE"}`; a missing or
different value is a `400` and no row or file is touched. Cookie requests still
need the same Origin as `NEXTAUTH_URL`, exactly like every other cookie write;
bearer requests skip the Origin check because a browser never attaches the token.
The successful response is `200 {"ok": true}`, and a cookie session also gets
both session-cookie names expired.

One transaction (`lib/services/accountDeletion.ts`, using `lib/db.ts`'s
transaction-aware `query`) locks the owner row and deletes:

- `businesses` for the owner, cascading reviews, drafts, draft events, generation
  periods and jobs, posting-slot claims, push deliveries, and Google connections;
- `google_connections` explicitly as well, because its `owner_id` FK has no
  cascade of its own;
- `email_sign_in_codes` for the owner's login address and any address recorded on
  its `auth_accounts` methods;
- `auth_users`, cascading `auth_accounts`, `auth_sessions` (web and mobile),
  `owner_usage`, `owner_plans`, `owner_plan_events` and `device_push_tokens`.

No migration was needed: every other FK either cascades from `businesses` or
`auth_users`, or is one of the two explicit deletes above. The deleted owner's
cookie and bearer sessions stop working on the next request because the session
rows are gone; a retry with the old token is `401`, not a second deletion. There
is no soft delete, recovery period or operator restore today.

**What is deleted, what is kept: nothing kept today.** The account row, profile
name and email, every business and all its reviews, captions, quotes, drafts,
generated images, logos, plan and usage history, push tokens, Google connection,
sign-in methods and sessions are removed. `docs/architecture.md` carries the
privacy-policy note.

Media files are collected before the rows are deleted and removed only after the
transaction commits. Only paths of the form `/api/media/<one filename>.png` that
resolve inside `MEDIA_ROOT` are eligible, so data URLs and path traversal are
ignored. A missing file is fine; a file that cannot be removed is counted in one
sanitized `account_deletion_media_cleanup_failed` log event and does not fail the
request after the data is gone. The cleanup helper is safe to retry. Deleting the
account does not cancel an App Store or Google Play subscription; both confirmation
screens say so and explain where to cancel it. `scripts/test-account-deletion.ts`
covers owner A/B isolation, every owner/business table including an
information-schema scan, media removal and traversal, confirmation failures,
both session kinds, immediate 401s and cleanup retry.

`TEST_DATABASE_URL=postgres://... npm test` runs disposable-schema A/B ownership,
media, limits, expiry/revocation and cross-origin tests. Anonymous tests inventory
all actual route exports. Older domain tests bypass the guard explicitly; boundary
tests do not. Production auth/CSRF/sign-out HTTP smoke uses synthetic sessions only;
real Google login still requires owner-provided OAuth configuration and a manual check.
No live OAuth acceptance is claimed without that configuration.

Google sign-in from the app (#81): the app sends `{ "idToken": "<Google ID token>" }` to
`POST /api/mobile/session`, a public route (with NextAuth and the other sign-in routes). The server
verifies the RS256 signature against Google's published keys
(https://www.googleapis.com/oauth2/v3/certs, cached by `jose`), the issuer
(`accounts.google.com`), expiry, `email_verified`, and that the audience is
`GOOGLE_IOS_CLIENT_ID` or `GOOGLE_ANDROID_CLIENT_ID`. Anything else returns 401, including
every request while neither variable is set (fail closed). It then finds or creates the owner through
`auth_accounts` (`provider = google`, `provider_account_id = sub`), the same row the web
uses, so both see the same businesses. A web owner with the same verified email but no
Google account row is linked instead of duplicated; if that owner is already linked to a different
Google subject the sign-in is rejected (401). No Google token is stored or logged.
Failed attempts are limited to 10 per 15 minutes per client IP (`cf-connecting-ip`, else
`x-forwarded-for`, honoured only when `TRUST_PROXY_HEADERS=1`, which the pilot overlay sets because
only cloudflared can reach the app; otherwise all callers share one bucket), counted in process memory: it resets on restart and is per replica,
which suits the single-instance pilot. Move it to Postgres if the web tier is replicated.

Owner steps to create the app's OAuth clients (Google Cloud Console, Google Auth Platform
> Clients, in the same project as the web client; live sign-in waits on these, #78):

1. iOS: create an OAuth client of type "iOS" with the app's bundle ID (the Expo
   `ios.bundleIdentifier`). Put its client ID in `GOOGLE_IOS_CLIENT_ID`.
2. Android: create a client of type "Android" with the package name (Expo
   `android.package`) and the SHA-1 of the signing certificate. Use the EAS or Play App
   Signing SHA-1 for store builds and add a separate client for the debug keystore if
   you test with one. Put the client ID(s) in `GOOGLE_ANDROID_CLIENT_ID`.
3. Native Google Sign-In must produce an ID token whose audience is one of these client
   IDs. The phone app sets `webClientId` from `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` (the same
   value as `GOOGLE_CLIENT_ID`) and `iosClientId` from `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`.
   Because `webClientId` is set, the token's audience is the web client ID on both
   platforms (the native library passes it as the server client ID). The server only
   trusts the IDs listed in `GOOGLE_IOS_CLIENT_ID` and `GOOGLE_ANDROID_CLIENT_ID`, which
   are one shared allowlist, so add the web client ID to at least one of them, for example
   `GOOGLE_ANDROID_CLIENT_ID`, even if you only ship iOS. The iOS client ID itself is
   still needed in the app (`EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`) to start the sign-in.
   Each variable accepts several comma-separated IDs. The app's
   reverse iOS scheme goes in `EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME` for prebuild only
   (see `mobile/README.md`).

Sign in with Apple from the app (#92): the app sends `{ "idToken": "<Apple identity
token>", "fullName": "<optional first-sign-in name>" }` to
`POST /api/mobile/session/apple`, a public route like the Google exchange. The server
verifies the RS256 signature against Apple's published keys
(https://appleid.apple.com/auth/keys, cached by `jose`), the issuer
(`https://appleid.apple.com`), expiry, and that the audience is one of the
comma-separated values in `APPLE_CLIENT_ID` (the app's bundle id
`ca.visda.praiseloop`; a Services ID is added only when web sign-in exists). Missing
`APPLE_CLIENT_ID` returns 401 for every request (fail closed), and every other
invalid token gets the same generic 401. It then finds or creates the owner through
`auth_accounts` (`provider = apple`, `provider_account_id = sub`), the same row a
future web Apple login will use. The Apple token is never stored or logged. Failed
attempts share the Google limiter: 10 per 15 minutes per client IP, in process
memory, as described above.

Apple-only owners and web setup: the web app has no Apple sign-in yet and the phone has
no business setup, so an owner who only signed in with Apple cannot set up a business
until they link Google (Profile, Sign-in methods) and sign in to the web with it. The
phone's "no business yet" screen says so. A session handoff from the phone to the web is
a possible follow-up.

Apple only sends the owner's name on the first authorization, outside the token. The
optional `fullName` is trimmed and capped at 80 characters and passed to
`fillProviderName`, so it can fill a missing name but never replaces a name the owner
edited. Apple's address (possibly an `@privaterelay.appleid.com` relay) is recorded on
the method row but Apple never auto-links an existing owner by email, as the issue
requires; a new Apple sign-in creates its own owner. A signed-in owner can link Apple through
`POST /api/account/methods` with `{ "provider": "apple", "idToken": "..." }` (the
phone API; no Apple linking button is shown on the web or phone yet), which uses
the same verified token and subject rules and also allows a relay address because
the live session already proves control of the account.

Owner setup for the native app: in the Apple Developer portal create an App ID for
`ca.visda.praiseloop` with the **Sign in with Apple** capability (or let Xcode/EAS
enable it), then add the same bundle id to `APPLE_CLIENT_ID`. No key, secret or
Services ID is needed for the native token flow. Nothing was run on a device or
simulator in this change; the live check waits on the owner's Apple account.

Web Apple sign-in: not built yet. NextAuth would need an Apple provider with a
Services ID and a client secret JWT signed by a `.p8` key, and the browser redirect
domain must be verified with Apple. That work is a follow-up; the native flow above
does not depend on it. Owner steps when it is built:

1. Create (or reuse) the App ID above with **Sign in with Apple** enabled.
2. Create a **Services ID** for the web hostname, configure its return URL as
   `${NEXTAUTH_URL}/api/auth/callback/apple`, and add the domain (and any subdomain)
   under **Sign in with Apple > Configure > Domains and Subdomains**, then verify the
   domain by downloading Apple's file and serving it at
   `/.well-known/apple-developer-domain-association.txt`.
3. Create a **Key** with Sign in with Apple enabled, download the `.p8` once, note
   its Key ID and the Team ID, and generate the short-lived client secret JWT from
   it at runtime (never commit the key).
4. Add the Services ID to `APPLE_CLIENT_ID` alongside the bundle id so the server
   verifier accepts web identity tokens too.

## Sign in with Microsoft (Entra ID, #158)

Microsoft sign-in is available on the web and in the phone app. The web uses
NextAuth's built-in Azure AD provider (provider id `azure-ad`; the redirect URI is
`${NEXTAUTH_URL}/api/auth/callback/azure-ad`) with `tenantId: "common"` so both
work/school and personal Microsoft accounts can sign in. It requests only
`openid email profile`; the provider is enabled only when both
`MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` are set, so a deployment
without Microsoft credentials keeps the email and Google paths and simply hides
the button. The phone uses the same app registration as a public client:
`expo-auth-session` fetches Microsoft's discovery document, runs the
authorization-code flow with PKCE and no secret, and sends the resulting ID token
to `POST /api/mobile/session/microsoft`.

The phone route is public like the Google and Apple exchanges. The server
verifies the RS256 signature against Microsoft's multi-tenant key set
(https://login.microsoftonline.com/common/discovery/v2.0/keys, cached by `jose`),
requires `exp` and `sub`, and accepts the audience only when it is one of the
comma-separated values in `MICROSOFT_CLIENT_ID`. A multi-tenant token has no
single fixed issuer, so the issuer must have the form
`https://login.microsoftonline.com/<tid>/v2.0` and the `<tid>` in it must equal
the token's own `tid` claim; anything else is rejected. The identity subject is
`${tid}:${sub}`, so ids from different tenants cannot collide. The display name
comes from the token's `name` claim. The address comes from `email`, or from
`preferred_username` when it looks like an address, lower-cased, and is recorded
on the method row for display only. Missing `MICROSOFT_CLIENT_ID` makes every
phone request fail closed with the same generic 401, and the body limit is 8 KB.
Failed attempts share the Google limiter: 10 per 15 minutes per client IP, in
process memory, as described above. The ID token is never stored or logged.

Microsoft never links to an existing owner by email. Its `email` claim is not
guaranteed to be verified or to belong to the account holder, so
`lib/authLinking.ts` is called with `emailVerified: false`: a new Microsoft
sign-in creates its own owner with no login email, even when the address equals a
Google owner's. A signed-in owner can attach Microsoft from a web sign-in (the
NextAuth callback sees the live session) or from `POST /api/account/methods` with
`{ "provider": "microsoft", "idToken": "..." }`; the live session already proves
control, and a subject that belongs to another owner is refused. `/account` and
the phone profile label the provider "Microsoft".

Owner setup (nothing was run against Microsoft's live service in this change):

1. In the Microsoft Entra admin center open **App registrations > New
   registration**. Choose **Accounts in any organizational directory and personal
   Microsoft accounts** (multi-tenant plus personal). No Microsoft Graph
   permission is needed; the OIDC scopes `openid email profile` are enough.
2. Under **Authentication > Add a platform**, add a **Web** redirect URI
   `${NEXTAUTH_URL}/api/auth/callback/azure-ad` (use the real HTTPS host in
   production). For the phone add a **Mobile and desktop applications** redirect
   URI `praiseloop://auth/microsoft`, matching the app's Expo scheme and the path
   in `mobile/src/auth/microsoft.ts`. The same registration can carry both.
3. Copy the **Application (client) ID** into `MICROSOFT_CLIENT_ID` (the server
   accepts a comma-separated list for the phone audience check; the web sign-in
   uses the first id in the list, so put the web registration first) and into the
   app's build environment as `EXPO_PUBLIC_MICROSOFT_CLIENT_ID`. Create a client
   secret under **Certificates & secrets** and put it in
   `MICROSOFT_CLIENT_SECRET`; the secret is used by the web provider only, never
   by the phone and never committed.
4. Rebuild the phone app (a development or store build; the Microsoft button is
   hidden without the client id) and restart the web app. A Microsoft-only owner
   still cannot set up a business on the phone; like an Apple-only owner they
   link Google or email from the profile and finish setup on the web.

Live web sign-in, live phone sign-in and a real work/school or personal account
were not run in this change. They wait on the owner's Entra registration and a
device check.

## Linking several sign-in methods to one owner (#156)

One owner can have several methods in `auth_accounts`. Every sign-in path (web
NextAuth callback and the mobile exchange) calls the same policy in
`lib/authLinking.ts`:

- **Identity is the provider plus its stable subject id**, never the email by
  itself. A returning Google `sub` is the same owner even if Google now reports a
  different address.
- **Email can find an existing owner only when the provider guarantees the
  claim is verified.** Google and our own email codes are trusted; Apple is
  not, because its address can be a private relay and account linking is a
  separate decision (#92). The address must
  match the owner row. An owner linked to a different subject for the same
  provider is rejected, which is the #116/#117 reassigned-address rule.
- **A provider whose email is not guaranteed verified never links by email.**
  Microsoft's `email` claim is the current example: it creates a new owner with
  no login email (the provider address is kept only on the method row), or is
  linked from a signed-in session. Google sign-in with `email_verified` absent
  is rejected rather than linked.
- **A signed-in owner may attach a new method** because the session proves
  control of the existing owner. The method must not already belong to another
  owner, and one owner cannot have two subjects for the same provider. On the
  web this happens when an owner on `/account` presses "Link Google": the
  NextAuth callback sees the live session and links instead of switching
  accounts. `POST /api/account/methods` does the same for the phone with a
  verified Google, Apple or Microsoft ID token. Neither action requires the
  emails to match.
- **Unlinking is refused for the last method.** `DELETE /api/account/methods`
  with `{ "provider": "google" }` removes a method only while another remains,
  so an owner cannot lock themselves out. `GET /api/account/methods` is the
  owner-wide list the web and phone screens share; it returns the provider,
  the method's email (a display snapshot), and when it was added and last used.
  Existing rows have no historical timestamps and report `null`.
- **Concurrency:** the email upsert locks the existing owner row and the
  signed-in paths lock the owner row before attaching, so two subjects racing
  for one address, or two link requests racing for one provider, leave exactly
  one method. An owner row created by a losing request is removed if it has no
  methods or other data.

Migration 017 adds `auth_accounts.email`, `created_at` and `last_used_at`; it is
additive and does not rewrite existing identities. Existing Google owners keep
their `auth_users` row, email and data, and are only dated from the migration
onward.

### Account recovery

The verified email on the owner is the recovery path: once the email one-time
code lands (#157), an owner who loses their only method can prove control of
that address and attach a new one. Until then there is no in-app recovery.
There is deliberately **no support override in code**: an operator cannot
impersonate an owner or attach a method through a hidden route. Merging two
owners after an address was reassigned remains an operator task, not something
the sign-in code does automatically.

`scripts/test-auth-linking.ts` covers link, reject, unlink-last and the races;
`scripts/test-mobile-google.ts` keeps the existing Google exchange behaviour.

Email one-time code (#157): the second way in, for owners whose organization does not
use Google. No password is stored and the only requirement is that the owner can read
the mailbox.

- `POST /api/auth/email/request` (`{email}`, public) normalises the address (trim,
  lowercase) and answers `200` with the same message whether or not an owner exists. A
  malformed address is a `400`; missing configuration is a `503`. A per-address limit
  (5 per 15 minutes) and a per-IP limit (20 per 15 minutes) drop excess requests without
  telling the caller, so throttling cannot be used to probe addresses. The email
  transport also caps 5 messages per recipient and 100 per sender per hour in each
  process, so rotating addresses cannot turn the server into an open relay.
- The code is 6 digits from `crypto.randomInt`, lives 10 minutes, is single use, and a
  newer request supersedes the earlier one. Only an HMAC-SHA256 keyed with
  `NEXTAUTH_SECRET` is stored in `email_sign_in_codes`; the real transport never logs
  the code. Five wrong guesses consume the code. Because a new code starts its own
  count, wrong guesses are also capped per address across all of its codes: after 15 in
  an hour the address is refused (even for the right code) until they age out. That cap
  is stored in Postgres, so a restart or another replica does not reset it. Verify
  failures are also limited to 10 per 15 minutes per client IP, counted in process
  memory like the Google limiter.
- `POST /api/auth/email/verify` (`{email, code}`, public, same-origin only) sets the same
  hashed eight-hour Postgres session cookie as Google. `POST /api/mobile/session/email`
  is the phone equivalent and returns a normal bearer session. A wrong code is a `400`
  on both, never a `401`, because the app reads `401` as "the session ended" and would
  clear its token over a typo.
- Linking policy (#156): identity stays the provider plus its stable subject id. The
  email method uses the normalised address as its subject. A verified code proves
  control of that mailbox, so an owner already known by the same address keeps one
  owner and gains an email method; a Google owner and their businesses are untouched.
  A different address always gets its own owner and never attaches to someone else.
  Because a code proves the mailbox, a reassigned address can still recover the owner
  it was registered to: that is inherent in passwordless email and documented rather
  than hidden.
- Email transport (#155): `lib/email.ts` has one interface. In development and tests
  the fake transport keeps messages in an in-memory outbox (also shown at
  `/dev/outbox`), logs one `email_outbox` line including the code and never sends.
  Production always uses Resend over HTTPS and fails closed unless `RESEND_API_KEY`
  and `EMAIL_FROM` are set; `EMAIL_TRANSPORT=fake` is refused in production.
- Owner steps before live email sign-in: create the Resend account, verify the sending
  domain, publish SPF, DKIM and DMARC records, set `EMAIL_FROM` to an address on that
  domain (for example `PraiseLoop <signin@example.com>`), and put the API key in the
  runtime environment only. Real delivery was not run in the #157 PR because no account
  or domain exists yet.
- Development: the fake outbox is at `http://localhost:3000/dev/outbox` (development
  process and fake transport only); the seeder also creates an email-only owner
  (`demo-email@praiseloop.invalid`) so the flow can be walked without a mailbox.

Push tokens (#88): `POST /api/mobile/push-tokens` (`{token, platform}`) registers or refreshes
the signed-in owner's Expo push token and `DELETE` (`{token}`) removes it on sign-out; a
token can only be removed by its owner. When a business's weekly generation period has
finished with drafts awaiting approval, the worker sends each of that owner's devices one
notification (count, business name and a `praiseloop://queue?businessId=` deep link only),
recorded in `push_deliveries` so restarts never resend. Tokens Expo reports as
`DeviceNotRegistered`, in a ticket or a receipt, are deleted. Sends are retried up to three times.

Demo sign-in (development only): `POST /api/mobile/session/dev` mints a normal
bearer session for the fixed `dev-owner` row, with no Google token. It exists only
when `MOBILE_DEV_AUTH=1` **and** the process is not a production build; otherwise it
returns 404 exactly like an unknown route. `npm run dev:seed` creates the owners and
synthetic drafts; a body of `{"owner":"free"}` signs in as the seeded Free owner
and `{"owner":"email"}` as the email-only owner, instead of the default Pro one.

The web uses `POST /api/dev/session` with the same flag, production guard and
`{"owner":"pro"|"free"|"email"}` body. It creates the normal `auth_sessions` row
and NextAuth cookie for that demo owner, so `/approval`, the plan page and the
Brand page work without Google. A cookie-minting request must come from the app's
own origin. `GET /api/dev/session` lists the owner keys and labels for the
landing-page buttons and also answers 404 when the flag is off. Only the known
seed keys are accepted (400 otherwise), so neither route can sign in a real
owner. The demo owner has the same ownership checks, version conflicts and
audit events as a real owner, so the flow is realistic; never enable the flag on a
shared server. Production sign-in remains the Google exchange above.

Profile (#149): `GET /api/profile` returns the signed-in owner's `name` (nullable),
`email`, `nameSource` (`provider`, `owner`, or null when there is no name), `provider`
(the owner's linked sign-in method, Google first when there are several, or null
when none is linked) and `initials` for an avatar. It
never returns provider tokens and keeps `Cache-Control: private, no-store`.
`PATCH /api/profile` accepts only `{ "name": "..." }`: trimmed, 1–80 characters, no
control characters, and 400 otherwise. The email is read-only because it is the
verified Google identity account linking depends on. Migration 016 adds
`auth_users.name_source`; a name the owner sets is never overwritten by a later
provider sign-in on the web or the phone, while an empty name may still be filled
from Google. Both cookie and `Authorization: Bearer` sessions use the same guard,
so a request only ever reads or writes the session's own owner. `scripts/test-profile.ts`
covers provider, missing, edited and sign-in-after-edit names.

When the session ends (#137): the server side above is unchanged; every protected route
answers 401. The clients now act on it.

- Web: pages call our own API through `apiFetch` (`app/apiFetch.ts`), never bare `fetch`. On a
  401 from a protected `/api/` route it stops the page's current action (the call never
  resolves, so no "something went wrong" message flashes), clears the dead cookie with
  `signOut({ redirect: false })`, then loads `/?reason=session-ended&callbackUrl=<current page>`.
  The landing page shows "Your session ended. Sign in again." and its Google button returns to
  that page (or goes there straight away if the owner is signed in again). 403, 404, 409, 429
  and 5xx keep their own messages and never sign the owner out. Loop guards: a 401 on the
  landing page, from `/api/auth/*` or from `/api/mobile/*` is ignored, several simultaneous
  401s (polling) sign out once, and a failing or slow `signOut` never blocks the redirect. The
  `callbackUrl` must be a same-site relative path. The decision logic is
  `lib/sessionExpiry.ts`. When a tab regains focus (at most every 30 seconds) the shell makes
  one `/api/businesses` call, so a tab left open overnight redirects without the owner acting
  first. New pages must use `apiFetch` for `/api/` calls.
- Phone: `api/client.ts` maps 401 to an `ApiError` of kind `signedOut`; every screen passes
  its errors to `useSession().handleError`, which deletes the keychain token and returns to
  sign-in, where a "Your session ended" banner explains why (not shown after a deliberate
  sign-out).
- Tests: `scripts/test-session-expiry.ts` (decision logic, the wrapper, and an expired cookie
  session and revoked mobile token against the real drafts and import routes) and
  `mobile/__tests__/sessionExpiry.test.ts`. No browser test was added, so the redirect itself
  is covered only by the wrapper tests with a fake `navigate`.
