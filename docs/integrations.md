# Integrations

Feasibility gates, dated official references and owner setup for third-party providers. None of these integrations is live yet.

## Transactional email (#155) — checked 2026-10-30

Status: the transport and its tests exist, but **no live send has been run**: there is
no owner Resend account or API key in this session. #155 stays open and #152's email
issues stay blocked until the owner actions below are done and one test message is
recorded. Tests and the dev stack never send.

### Chosen provider and comparison

Resend, through its HTTP send API (`POST https://api.resend.com/emails`) with a
plain-text body and an optional `Idempotency-Key`. Resend was compared with the
alternatives on 2026-10-30:

| Option | Free tier | Paid entry | Domain and authentication | Why not chosen |
| --- | --- | --- | --- | --- |
| [Resend](https://resend.com/pricing) | 3,000/month, 100/day, 3 domains | $20/month for 50,000 | Verified own domain, SPF/DKIM/DMARC, automatic hard-bounce suppression, webhooks | **Chosen**: smallest setup, free tier covers the pilot, plain `text` field, no SDK needed |
| [Postmark](https://postmarkapp.com/pricing) | 100/month | $15/month for 10,000 | Verified domain, DKIM/SPF/DMARC, suppression, strong deliverability reputation | 100 free messages is too small once codes are re-sent; double the entry price |
| [Amazon SES](https://aws.amazon.com/ses/pricing/) | No standing free allowance assumed | $0.16 per 1,000 (Essentials) | Own domain, DKIM/SPF/DMARC, reputation dashboards | Needs AWS account, IAM policy and production-access approval before arbitrary recipients |
| [Cloudflare Email Service](https://developers.cloudflare.com/email-service/platform/pricing/) | Sending needs Workers Paid | 3,000/month included, then $0.35 per 1,000 | Own domain, DKIM/SPF/DMARC, API token | Sending is beta; the Tunnel does not remove the account/token work |
| Plain SMTP to a mailbox provider | Depends on provider | Depends on provider | Provider-specific | Rejected: adds credential/connection management without removing the provider; every option above offers SMTP if needed |

All options need a real domain the owner controls ([#90](https://github.com/PraiseLoop/praise-loop/issues/90)).
Resend will not send from its shared domain to arbitrary recipients: a verified
domain is required, and the shared sender only reaches the account owner's own
address. That owner address is enough for the first live test, but not for pilot
owners.

### Verified official interfaces and references

Fetched 2026-10-30:

- [Send email](https://resend.com/docs/api-reference/emails/send-email): `from`,
  one or more `to`, `subject`, and `text`; `Idempotency-Key` deduplicates for 24
  hours and is at most 256 characters. We send one bare recipient and plain text.
- [Verified domains](https://resend.com/docs/dashboard/domains/introduction): sending
  requires a domain you own; Resend recommends a subdomain (for example
  `mail.example.com`) so transactional reputation is separate from other mail.
- [Cloudflare DNS setup](https://resend.com/docs/dashboard/domains/cloudflare): DKIM
  TXT (`resend._domainkey...`), SPF TXT and MX on the `send` subdomain, all
  **DNS only** (never proxied); verification often takes minutes and can take up to
  72 hours.
- [DMARC](https://resend.com/docs/dashboard/domains/dmarc): start with
  `v=DMARC1; p=none; rua=mailto:...`, confirm `spf=pass dkim=pass dmarc=pass` on real
  messages, then tighten to `quarantine` and `reject`. A verified Resend domain
  already passes SPF and DKIM.
- [Pricing](https://resend.com/pricing): the free plan includes 100 messages/day and
  hard-bounce suppression; webhook endpoints are included for delivery/bounce/
  complaint events. Only a sanitized message id is logged by the real transport.

### Implementation (real transport exists, unverified live)

`lib/email.ts` defines `EmailTransport` with two implementations:

- `fake` (default outside production): appends to an in-memory outbox and writes one
  `email_outbox {...}` log line containing the recipient, subject and body, so a
  developer can read the one-time code in the dev stack. It never calls the network
  and is refused in a production process.
- `resend`: a timeout-bounded `fetch` call. It sends `text` only (no HTML, images,
  tracking pixels or review content), never logs the API key, message body or
  recipient, and maps errors to sanitized codes (`email_auth`, `email_sender`,
  `email_invalid`, `email_throttled`, `email_provider`, `email_timeout`). A 401
  from Resend is `email_auth` (missing or invalid key); a 403 is `email_sender`
  (refused sender: usually an unverified `EMAIL_FROM` domain) unless Resend's error
  name says the key is inactive, suspended or invalid, which stays `email_auth`. A missing `EMAIL_FROM` or
  `RESEND_API_KEY` fails closed with `email_unavailable` and a clear message.

`sendEmail()` throttles per recipient (5/hour) and per sender (100/hour) with a
sliding window before handing the message to the transport. The throttle is
**process-local**: web and worker each get their own budget; replace it with a shared
store if more than one sending process is added. Errors never include the recipient,
and callers must answer sign-in attempts identically whether or not an address has an
account.

`scripts/test-email.ts` covers the fake outbox and its log, the plain-text template,
both throttle dimensions and window recovery, invalid recipients/subjects and header
injection, the missing-configuration paths, and the Resend contract against a mocked
`fetch` (success plus 401/403/422/429/5xx/timeout). No test or dev run touches the
network.

### Owner actions to unblock and deliverability checklist

1. Settle the sending domain from #90 and choose a transactional subdomain, for
   example `mail.praise.example.com`. Do not use the root domain if it also has
   human mailboxes.
2. Create the Resend account (owner owns billing and keys) and add that subdomain.
   Put the API key only in runtime secret configuration, never in `.env.example`,
   the repository or logs.
3. In Cloudflare DNS add exactly the records Resend shows: DKIM TXT, SPF TXT and MX
   on the `send` subdomain, all **DNS only**. Click verify in Resend.
4. Add `_dmarc.mail.praise.example.com` with `v=DMARC1; p=none; rua=mailto:<owner
   address>;`. Send a test message, inspect the headers for `spf=pass`,
   `dkim=pass` and `dmarc=pass`, then tighten the policy to `quarantine` and later
   `reject`.
5. Set `EMAIL_TRANSPORT=resend`, `EMAIL_FROM="Praise Loop <no-reply@mail.praise.example.com>"`
   and `RESEND_API_KEY` on the web service (and the worker if it will send), restart,
   and send one message to a test address the owner controls. Record the date and
   sanitized Resend message id here. Until that is done, #152's email issues stay
   blocked.
6. Enable a complaint (and bounce) webhook before wider use and decide how to record
   suppression outside the repo. Keep provider responses, recipients and codes out of
   logs and never reveal whether an address has an account.

## Buffer feasibility gate (#29) — checked 2026-10-15

Status: BLOCKED; no owner-authorized Buffer account/client/channel or public test
media origin is configured in this session. This PR completes research and removes
false stub success only, not the integration. Keep #29 open and this PR draft until
provider implementation/live acceptance is supplied. No external post was attempted.

### Verified official interfaces

- [Quick start](https://developers.buffer.com/guides/getting-started.html): GraphQL
  at https://api.buffer.com. Personal API keys act on the owner's account; do not
  share one global key across customers.
- [Authentication](https://developers.buffer.com/guides/authentication.html): SaaS
  clients use owner OAuth authorization-code + PKCE, registered redirect URI,
  state validation, account:read/posts:read/posts:write and offline_access. Refresh
  tokens rotate on each use; refreshing must hold a durable per-connection lock.
- [Posts and scheduling](https://developers.buffer.com/guides/posts-and-scheduling.html):
  customScheduled + dueAt UTC submits future posts in advance. Scheduled is distinct
  from sent/error. Supported services include Instagram and others; choose and
  verify ONE channel before implementation claims.
- [Image posts](https://developers.buffer.com/examples/create-image-post.html):
  asset image URLs must be provider-fetchable. Private /api/media owner cookies
  cannot be used. Plan narrowly scoped, expiring capabilities for one immutable
  approved artifact; never make draft filenames generally public/enumerable.
- [Rate limits](https://developers.buffer.com/guides/api-limits.html): use response
  Retry-After/RateLimit data with bounded backoff; quotas depend on plan/client.
  Recheck actual limits at connection time; do not hardcode these as posting limits.

No idempotency or reconciliation guarantee is assumed from the createPost examples.
An accepted request followed by a timeout/local write failure is ambiguous: persist
an unknown outcome for manual/provider reconciliation, never blindly create again.
Verify current deletion/cancel and any reschedule contract with the registered
client; refuse unsupported changes instead of changing local dates alone.

### Exact owner actions to unblock

1. Select one permitted test channel/account and register a confidential OAuth app
   in Buffer Settings → API with a canonical callback URL. Confirm API/channel access.
2. Make client ID/secret and a separate encryption key available via runtime secret
   configuration (not this repo/chat/logs). Use authenticated encryption at rest,
   owner/business-bound associated data, and a documented key rotation process.
3. Authorize the selected business connection in the app once implemented; select
   organization/channel, verify it belongs to that connection, and provide a public
   HTTPS test media origin for the capability route. Keep ordinary media private.
4. Explicitly authorize one externally visible synthetic test post, its channel and
   scheduled time before any write. Record redacted external ID/state evidence,
   verify sent/error reconciliation, and confirm cancel/reschedule/disconnect behavior.

### Remaining implementation / merge gate

Owner OAuth connect/select/disconnect and encrypted credential storage with rotating
refresh locking are built (see “Connecting Buffer” below); the remaining gate is
durable submit/reconcile/cancel jobs in the existing worker;
validated channel/media handling; unique local claims and persisted external IDs;
bounded retries with ambiguity handling; explicit provider-aware lifecycle/audit.
Fixtures must cover auth/429/timeout-after-acceptance/media failure/concurrent workers,
future times, cancel/reschedule, reconciliation and ownership. Live test above remains
mandatory. A fake adapter alone does not complete #29.

Scheduling fails closed unless `BUFFER_POSTING_MODE` is `draft` or `live` (see
[features.md](features.md#posting-through-buffer-29-part-3)). The legacy CLI no longer queries content,
logs captions/reviews, or marks local rows scheduled. A test-only fake cannot represent real publication.

### Partial implementation (adapter + credential encryption, unverified live)

`lib/integrations/buffer.ts` is a Buffer GraphQL adapter tested only against mocked
`fetch` (`scripts/test-buffer.ts`). `submitPost` sends `mode: shareNow` with `schedulingType: automatic`
and the required `needsApproval: false` (found by introspecting Buffer's schema on 2026-11-02; the earlier
adapter omitted it and would have been rejected), plus `saveToDraft: true` in draft mode. For an Instagram
channel it also sends `metadata.instagram` with `type: "post"` and `shouldShareToFeed: true`: Buffer's first
real call (2026-11-04) was refused with "Instagram posts require a type (post, story, or reel)", and both
fields are required by `InstagramPostMetadataInput`. Other networks get no metadata until one is tested. It never uses
`customScheduled` or Buffer's queue. It refuses incomplete drafts before any network call, retries only 429
(bounded, a Retry-After over 60s is surfaced instead of retried), maps 401/403, `UnauthorizedError` and
`ChannelRefreshRequired` to an auth error, maps only Buffer's refusal types (`InvalidInputError`,
`NotFoundError`, `LimitReachedError`, `DuplicateError` and their `Post*` forms) to a rejection, and treats
timeout/5xx/unreadable responses and `UnexpectedError`/`RestProxyError` as `SchedulerAmbiguous` (never
auto-resubmitted). `getPostStatus` reads `post(input:{id})` (status, externalLink, sentAt, error message).
`lib/integrations/credentials.ts` provides AES-256-GCM encryption with owner-bound AAD, keyed by
`CREDENTIAL_ENCRYPTION_KEY` (32 bytes base64).
Built in #29 part 3: the worker submit/reconcile, unguessable per-draft image links, cancel, and the
off/draft/live gate. Still open: the phone and web status display, resolving `unknown` posts, and the
owner-approved live test.

## Connecting Buffer (#29, backend part 1) — built 2026-11-01

Status: the Connect backend exists and is covered by mocked-fetch tests. The web
connections screen exists (#29 part 2). There is no phone UI, no posting, no
scheduling, no media URL and no worker change yet. Nothing here has been run
against a live Buffer account or client.

### Flow

1. `POST /api/buffer/connect` (signed-in owner, owner-wide) mints 32 random bytes
   of `state` and a PKCE `code_verifier`, stores only the SHA-256 hash of the state
   and the verifier encrypted with `CREDENTIAL_ENCRYPTION_KEY`, and returns the
   Buffer authorize URL. States live ten minutes and are single use.
2. The browser goes to `https://auth.buffer.com/auth` with `client_id`,
   `redirect_uri`, `response_type=code`, `scope`, `state`,
   `code_challenge`, `code_challenge_method=S256` and `prompt=consent`.
   The scope is `posts:read posts:write account:read offline_access`;
   `offline_access` is what makes Buffer return a refresh token, but on the first real connect
   (2026-11-03) it was not granted and the token response had no `refresh_token` until `prompt=consent`
   was added, as in Buffer's own example URL. Buffer's docs do not explain the dependency.
3. Buffer redirects to `GET /api/buffer/callback` (allow-listed as a public route
   because the redirect has no bearer token or CSRF header, but it requires the
   browser's own session: it must belong to the owner who started the flow, or
   nothing is consumed, contacted or stored. This blocks login CSRF, where a victim
   is tricked into finishing an attacker's flow. The web app and the callback share
   one host, so the cookie is present). The route consumes the state row atomically, exchanges
   the code at `https://auth.buffer.com/token` (form encoded, with
   `client_secret` and `code_verifier`), reads the owner's organization and stores
   the encrypted access and refresh tokens. It always answers with a `302` to
   `${NEXTAUTH_URL}/connections?buffer=<outcome>`, where outcome is `connected`,
   `denied`, `expired`, `failed` or `not_configured`. A token, code, state or
   provider error text never appears in the redirect.
4. `GET /api/buffer/connection` reports `{ connected, status, channels }` and
   `DELETE` disconnects. `GET|PUT|DELETE /api/businesses/:id/buffer-channel`
   reads, selects or clears the one Instagram/Facebook channel a business posts
   to. A selected channel must appear in a fresh channel list; another owner's
   business is a 404 and writes nothing.

The callback uses the existing process-memory failed-attempt limiter
(`lib/mobileSignIn.ts`, ten failures per 15 minutes per client IP) rather than a
new one. It is per replica and resets on restart, like the other public routes.

### Configuration

Set on the `web` service, read at request time, never logged:

- `BUFFER_CLIENT_ID`, `BUFFER_CLIENT_SECRET` — the confidential Buffer app client.
- `CREDENTIAL_ENCRYPTION_KEY` — 32 random bytes, base64; also used by
  `lib/integrations/credentials.ts` for the AES-256-GCM envelope.
- `BUFFER_REDIRECT_URI` — optional. Defaults to
  `${NEXTAUTH_URL}/api/buffer/callback` with trailing slashes removed from
  `NEXTAUTH_URL`.

Missing any required value makes connect answer `503` and the callback report
`not_configured`. In Buffer, register exactly the redirect URI the deployment
will use, for example `https://dev.example.com/api/buffer/callback` and later the
production host. Buffer rejects `http://localhost`; development goes through the
tunnel. Do not commit real values.

### Refresh tokens and disconnect

Refresh tokens are single use: every successful refresh returns a new one and
invalidates the one sent, and reusing an old one revokes the whole grant. A refresh
therefore runs in a transaction holding `SELECT ... FOR UPDATE` on the connection
row, re-checks expiry after the lock, sends one request and stores the new access
and refresh tokens before committing. Two concurrent callers send exactly one
refresh. On `invalid_grant`, a 4xx, an unreadable response or a network failure
after sending, the connection is marked `needs_reconnect` and never refreshed
again with the old token; the owner reconnects. There is no documented revoke
endpoint: disconnect deletes our stored tokens and the owner can revoke PraiseLoop
in their Buffer settings.

### Tests

`scripts/test-buffer-connect.ts` covers the authorize URL, single-use and
owner-bound state, the form-encoded exchange, encryption at rest, callback
outcomes and secret-free redirects/logs, single and concurrent refresh,
`needs_reconnect`, channel filtering, selection ownership and disconnect.
`scripts/test-account-deletion.ts` proves the three new tables cascade away with
the owner. The dev seeder deliberately does not create a fake connection: it would
need real encrypted tokens, and a synthetic connection would make the UI claim an
account it does not have.

## Google Business Profile feasibility (#46) — checked 2026-10-15

Status: BLOCKED. No approved developer project, OAuth client/owner grant, verified
permitted live location, or confirmed review-reuse policy interpretation is
available in this session. No account configuration, API call, scraping or mock
connector is presented as completion. Issue #46 stays open.
P2 delivery also waits for the paid-pilot demand evidence specified by the issue.

### Current official references

- [Prerequisites](https://developers.google.com/my-business/content/prereqs): API
  access requires an approved developer project. The applicant must manage an
  active verified profile for at least 60 days, with its business website present.
  Request basic access through the official form with the project number using an
  owner/manager email; zero quota is not proof of access. Enable APIs after approval.
- [OAuth implementation](https://developers.google.com/my-business/content/implement-oauth):
  use owner consent with business.manage scope. This broad management scope is not
  a product authorization to edit profiles/reviews; our connector must remain read-only.
- [Review list](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/list):
  verified location required; accounts/*/locations/* parent, at most 50 per page,
  pageToken/nextPageToken and updateTime-desc ordering. No documented changed-since
  cursor is assumed; stable review IDs and durable pagination checkpoints are needed.
- [Review data](https://developers.google.com/my-business/content/review-data):
  review ID, comment, rating, reviewer/create time support provenance. Do not invent
  a review permalink when the response does not provide one.
- [API policies](https://developers.google.com/my-business/content/policies):
  authorization, attribution, termination and content-storage obligations apply.
  Limited cached content has a temporary 30-day ceiling and restrictions on
  manipulation/aggregation. Third-party projects and access have additional rules.

The product currently retains reviews and turns them into edited social graphics.
We cannot assume that indefinite storage or off-platform reuse is permitted by
API access or business-owner consent alone. Obtain provider clarification for this
specific use before connecting/importing; these notes are not a legal determination.
Do not silently repurpose Places API rules, remove attribution, or scrape instead.

### Exact owner actions to unblock

1. Confirm paid-pilot demand justifies this P2 integration, as required by #46.
2. Establish the developer's eligible GBP/website and Google Cloud project, request
   basic API access, confirm approval/quota, and enable the official APIs. Do not
   require each pilot business to apply for a supplemental developer project.
3. Ask Google to clarify permitted quote extraction/social reuse, attribution,
   cache/retention and handling of deleted/edited reviews for this product. Record
   the response and agreed policy before implementing persistence/publication.
4. Register an OAuth consent/client and canonical redirect, complete any required
   verification, and provide credentials through runtime secret configuration.
   Choose an owner-authorized verified test location and consented data scope.
5. Provide external encryption-key management and retention/deletion requirements;
   never place refresh tokens or encryption keys in source, test fixtures or logs.

### Implementation gate after access/policy resolution

Reuse #42 ownership, #43 durable queue and #45 identity; do not build parallel auth,
queue or deduplication systems. Add owner connect/location select/disconnect,
authenticated encryption with owner/business-bound associated data, a rotating-key
plan, and revoked/expired consent handling. Persist stable source IDs/checkpoints;
upsert pages transactionally, use bounded rate-limit retries, and retain last sync,
counts and sanitized error codes. Incremental refresh must account for edits and
periodic full reconciliation for deletions; absent pages during an interrupted scan
are not proof of deletion. Never silently mutate approved/published artifacts.

Fixture coverage must include pagination/repeated sync/edits/429/expired tokens,
interrupted import, ownership and disconnect. Live acceptance requires a permitted
location import followed by a duplicate-free refresh, with sanitized evidence.
A retention/deletion migration must preserve draft references while respecting the
resolved policy; do not blindly delete reviews. No connector, schema change, live
acceptance, production configuration or provider permission is claimed by this PR.

### Scaffolding added for #46 (stubbed, not live) — 2026-10-27

Google has not approved Business Profile API access, so the sync is built only
against a `GoogleReviewsClient` interface (`lib/integrations/googleReviews.ts`).
`liveClient()` deliberately throws; tests use scripted fixtures with no network,
credentials or customer content. Migration 015 adds `google_connections`.

Implemented and tested: ownership-checked connect/disconnect; AES-256-GCM refresh
token encryption with owner/business-bound AAD (key `GOOGLE_TOKEN_KEY`, 32 base64
bytes, supplied at runtime; no rotation tooling yet); paged import with a durable
per-page checkpoint; idempotent upserts on the existing review identity key; edits
update only the `reviews` row, never `draft_posts`; bounded retry honoring 429
Retry-After; `invalid_grant` marks the connection `revoked` and drops the token;
disconnect removes the token locally and revokes at Google best-effort; last sync,
count and a sanitized error code are stored.

Still unverified/missing (so #46 stays open, `Refs #46`): the live client and
OAuth consent routes/location picker, exposing sync status in the UI, scheduling
the sync in the #43 worker, periodic full reconciliation for deleted reviews,
review-reuse/retention policy confirmation from Google, key rotation, and the
mandatory live test with sanitized evidence. Add `GOOGLE_TOKEN_KEY` to deploy secrets
before use.
