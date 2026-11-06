# Features

How each shipped feature works, how to verify it and how to roll it back. Owner sign-in and access rules are in [auth.md](auth.md); provider integrations are in [integrations.md](integrations.md).

## Onboarding: resumable first drafts (#30)

Run migrations through 011, configure owner login ([auth.md](auth.md)), and start the durable
worker/Redis ([Durable weekly generation](#durable-weekly-generation-43)). Signing in with no business opens `/onboarding`, a
four-step wizard (brand → reviews → making posts → first posts) that resumes where
you left off. “+ Add a business” in the sidebar opens `/onboarding?new=1`, which
starts a fresh setup with its own idempotency key. No Google connection, billing,
automatic approval or publishing is required. The final step offers an optional
“Connect Instagram or Facebook” link to `/connections`; onboarding finishes without
it and approved posts wait in the approval queue.

1. Sign in, enter business name (1–120 characters), IANA timezone, colors and tone.
   Optional PNG/JPEG/WebP logo is validated before saving (256 KB / 4 MP); remote
   URLs/SVG/animation are rejected. Synthetic preview reuses the shared renderer and designs.
2. Import a CSV or download the synthetic sample. Inspect persisted totals/bounded
   row errors. Duplicate imports are safe. Add more reviews if there are fewer than
   three eligible 4–5 star, 30+ character, suitable reviews after curation.
3. Explicitly queue up to three drafts (default weekly target three). Existing jobs
   and onboarding share the same weekly budget. Poll persisted state; auto-retries
   retain successful stages. Exhausted jobs offer bounded owner retry; fix branding
   on the Brand page before retrying rendering failures. A pending, running or
   auto-retrying job that holds for two minutes (`STUCK_JOB_MS`) shows a “taking
   longer than usual” notice and a “Carry on to This week” link, because the worker
   may be paused; the job keeps its place and nothing posts without approval.
   Back and Save & exit sit in the step 3 footer beside the waiting message, and
   Save & exit opens the approval queue instead of resuming the wizard.
4. Open the actual owner-protected images and captions. “Usable previews” appears
   only after each image loads. Review in approval selects the saved business;
   the owner decides what to edit/approve. An optional card links to Connections
   to connect Instagram/Facebook; real publishing needs a Meta target or a Buffer
   channel (#234/#29), but onboarding never requires either.

Saved steps resume from owner-scoped database records and the business URL. A
sessionStorage UUID only deduplicates initial business creation; no review text,
logo or form content is stored there. Concurrent retries with the same owner/key
return the existing business. Unsaved initial form fields and file selections must
be entered again after reload. Expired sessions clear the wizard's loaded data.
Public sample CSV ships in the web image; private/generated media is excluded from
Docker build context and still requires owner-authorized image access.

### Actual timed evidence (2026-10-15)

Chromium production-server walkthrough: **5.46–5.70 seconds**, synthetic session and
injected caption provider, real Postgres and Sharp rendering. Included malformed
CSV, an insufficient first review, duplicate setup requests, reload/resume,
provider failure/recovery, adding reviews, and three 1080px previews. This is an
AUTOMATED synthetic timing, not a human/live-provider result or product SLA.
Live OAuth/provider latency and a human manual timing are not verified here.

Reproduce after build with `TEST_BROWSER=1 TEST_DATABASE_URL=... npx ts-node scripts/test-onboarding-browser.ts`.
Requires Chromium (CHROMIUM_PATH). The test invokes the real worker handler with
fixture captions and the real renderer; BullMQ delivery is covered separately.
`TEST_DATABASE_URL=... npm test` also verifies setup idempotency, owner isolation,
logo/timezone validation and database resume. No paid calls occur in ordinary tests.

Owner manual timing: start when business setup opens after sign-in; stop only when
all three image/caption previews visibly load. Record provider mode, failures,
review availability and elapsed time; do not substitute synthetic seconds for this
measurement. Retry/reload must retain the same business/import/job counts. Document
live results separately when owner credentials and a permitted setup are available.
Rollback: stop writes, retain onboarding keys and all existing business/review/job
records. No data is deleted by migration 011.

CI now supplies disposable Postgres/Redis services and installs matching Playwright
Chromium so database and all four browser/HTTP flows run instead of being skipped.

Resume without an explicit business ID prefers the latest saved onboarding business, falling back to the latest owned legacy business. An explicit owned business ID selects another business. Progress shows the newest five drafts, so old archived attempts do not permanently hide newer previews.

## Durable weekly generation (#43)

Run `npm ci`, `npm run db:migrate` (008), configure `REDIS_URL`, and run `npm run worker`.
Compose wires Redis into the worker. BullMQ 6 with ioredis handles durable delivery; Postgres
is the authoritative outbox/claim/quota store, so lost Redis deliveries are rebuilt.
The worker scans every 60s (minimum configurable 5s), not five new drafts per tick.
Only owned businesses participate, and after a downgrade only those within the plan's business
allowance generate; the extra ones are paused (#217). The Brand page (Posts per week) exposes weekly
target 1–5, default 3; changes apply to the next Monday-based business-local generation period.

A business-row transaction reserves review/draft jobs and counts all initial drafts
against the same period budget. Up to five pending/running/retrying jobs per business
bound backlog across rollover. Historical duplicates and their relationships remain
intact, but new canonical review→draft mappings are unique. Existing incomplete
current-period drafts are adopted instead of replaced. `generation_periods` persists
allocated/completed counts and quota_met/reviews_exhausted/backlog_full/queued reasons.

Claims have 90s renewable leases, three automatic attempts, 30s/60s backoff and
sanitized error codes. Caption calls time out at <=30s. Persisted caption/image
stages are reused after failures/restarts; a crash after a provider accepted a call
but before local persistence can require another call. Attempts and per-owner daily
counters bound that exposure; exactly-once paid calls are not promised.

Captions are limited to 200 characters. The prompt asks for 180 or less. A caption
that still comes back too long gets one extra provider call asking for a shorter
rewrite of just those captions. If that fails or is still too long, it ends on the
last full sentence (or whole word) that fits, never mid-word or mid-hashtag and
without a trailing "...". At most five hashtags are kept.

`GET /api/generation?businessId=...` exposes only owner-authorized state. Existing
quote selection POST now queues generation (202), never a second synchronous AI
pipeline. `POST /api/generation/retry` takes draftPostId, only retries an exhausted
failed job, and permits at most two owner-triggered retries. Successful drafts stay
in draft status and require human approval. Do not manually reset a job's counters.

Validate with `TEST_DATABASE_URL=... TEST_REDIS_URL=redis://localhost:56379 npm test`.
Tests use isolated Postgres schemas and a uniquely named Redis queue; fake-provider
calls verify quota rollover, concurrent claims, lost Redis delivery, crashed leases,
retained stages, bounded retries and redaction. No provider key is used. Redis/db
access needs to remain internal; the public worker has no authentication bypass.
Rollback: stop the worker before reverting, retain new job/period tables and draft
reference annotations. Do not run the former unbounded timer-loop worker on live data.

Invalid legacy business timezones produce `invalid_timezone` without reserving jobs; correct the IANA timezone in business settings to resume. Compose always uses the Redis service hostname, independently of host `.env` URLs.

## Timezone-aware posting slots (#28)

Run migration 010, configure owner login ([auth.md](auth.md)), and ensure the durable worker/Redis is running ([Durable weekly generation](#durable-weekly-generation-43)). The Schedule page (`/schedule`) shows the PostingSlots component for the business selected in the app shell.

### Flow

1. Owner sets weekly posting slots (weekday + local time) on the Schedule page. Times are stored in business timezone.
2. On confirm, the system proposes the next 5 available UTC slots (skipping occupied) using business timezone with correct DST resolution.
3. Each selected approved draft gets a durable `queued` claim on a specific UTC instant and becomes `scheduled`, with the provider fixed on the claim. **Nothing is sent to any provider at this point.** The business needs a usable target: a Meta Page/Instagram target, or a connected Buffer channel that can post by itself (a Facebook Page or a Business/Creator Instagram). Meta wins when both exist.
4. When the time comes the worker sends the post to that provider ([Posting through Buffer](#posting-through-buffer-29-part-3), [Direct Meta publishing](#direct-meta-publishing-234)). Only a verified provider result makes the draft `published`.
5. Before that time the owner can cancel (`POST /api/posting-slots/cancel`), which frees the slot and returns the draft to `approved`.

### DST handling

- `localSlotInstant` searches forward up to 24h for the next valid local minute.
- Nonexistent minutes (spring forward) resolve to the next valid minute.
- Repeated minutes (fall back) use the earliest UTC instant.
- Verified by `test-posting-slots.ts` for America/New_York, Australia/Lord_Howe.

### Acceptance

- `proposeSlots` returns future UTC instants matching the configured weekdays/times.
- `assignSlots` enforces ownership, draft completeness (caption + available image), version match, and slot availability.
- Concurrent assignment to the same slot is prevented by unique claim.
- With `BUFFER_POSTING_MODE=off` (the default) assigning returns 503 and nothing is persisted.
- A Free or expired plan is refused with 403 and nothing is persisted; an expired plan reads as Free.
- A missing channel, a needs-reconnect connection or a personal Instagram channel is refused with a plain reason.
- A reserved slot makes no network call; only the worker talks to Buffer.

### Tests

- Unit: `scripts/test-posting-slots.ts` - DST/rollover, ownership, concurrency, the off gate, channel rules, cancel (no network)
- Browser: `scripts/test-slots-browser.ts` - Chromium flow: schedule edit, confirm, provider failure, browser/business timezone persistence, branding logo upload/remove
- Run with `TEST_DATABASE_URL=... npm test` (unit) and `TEST_BROWSER=1 TEST_DATABASE_URL=... CHROMIUM_PATH=... npx ts-node scripts/test-slots-browser.ts` (browser)

### Boundaries

- No automatic scheduling; owner explicitly confirms each batch.
- Posting requires `BUFFER_POSTING_MODE` to be `draft` or `live` (see below). Without it, assign returns 503.
- A post can be cancelled only while it is still `queued`. Once it has been handed to a provider, manage it there.
- Maximum 5 slots per weekly batch (MVP limit).

### Rollback

Stop writes, retain `posting_slot_claims` and `businesses.posting_slots`. Migration 010 is additive.

## Posting through Buffer (#29 part 3)

The worker (`lib/services/bufferPosting.ts`, called every tick from `worker/index.ts`) sends an
approved, scheduled post to the owner's own Buffer channel when its time comes, then watches Buffer
until it reports the result. The schedule lives in PraiseLoop; Buffer's own queue is never used.

**The gate: `BUFFER_POSTING_MODE`** (web and worker). `off` is the default and what every unknown value
means: the worker never calls Buffer, and assigning a slot answers 503. `draft` sends the post to Buffer
as a **draft** (`saveToDraft`), so nothing is published; the post returns to `approved` and the claim
ends as `drafted`. `live` publishes. An owner who confirms a slot is explicitly authorizing that one post
for that time ([decisions.md](decisions.md)).

**Automatic posting is paid (#216).** The `automaticPosting` plan limit is false on Free and true on Pro
and Business; the effective plan is read through `entitlementsFor`, so an expired plan counts as Free.
The server refuses a Free or expired owner when connecting Buffer, choosing a channel, and confirming a
post for a slot, and the worker checks again under the claim lock immediately before it sends. A post
already `queued` when the plan lapses is not sent and not resubmitted: it ends `error`/`failed` with
`plan_required`, and the approval card and schedule show "Automatic posting is included in Pro and
Business. This post wasn't sent." Free owners keep the phone share sheet and image download, and approval
is still required on every plan.

Claim states (`posting_slot_claims.state`): `queued` (waiting, nothing sent) → `submitting` (committed
before the call) → `submitted` (Buffer accepted it; we poll) → `sent` (Buffer said so; draft becomes
`published`). Other ends: `drafted` (draft mode), `error` (Buffer said so, rejected it, the plan no longer
includes automatic posting, or the connection needs reconnecting), `missed` (the worker was down more than
2 hours past the due time; never sent late),
`unknown` (outcome unproven: a timeout after sending, a crash mid-call, or no final status after 14 checks).
**An `unknown` post is never resubmitted**, because Buffer does not deduplicate.

At submit time, under the claim's lock, everything is re-checked: the draft is still scheduled with a
valid image, the owner's effective plan still includes automatic posting, the connection is active, the
business still has a channel, and it is not a personal Instagram. A failed check ends the claim as `error`
without calling Buffer.

**Public image links.** Buffer fetches the image from a public HTTPS URL, so each submission gets
`https://<NEXTAUTH_URL host>/api/public-media/<43-character token>.png`. The token is 256 random bits,
unrelated to the draft id or filename; only its SHA-256 is stored. The route is public but serves an image
only while its claim is `submitting`, `submitted`, `unknown` or `drafted` and not expired (3 days live,
1 hour draft), and every miss is the same empty 404. The token is revoked when the post is sent, fails or
is cancelled, and removed with the draft or account. `NEXTAUTH_URL` must be `https`, or nothing is sent.
**The `/api/public-media/` path must be reachable from the internet**; on the home dev stack the
Cloudflare rule that limits `dev.praiseloop.ca` to the home network must also allow that prefix.

**Status checks** use `post(input:{id})` with a backoff of 1, 5, 15 minutes then hourly (Buffer's free plan
allows 1,000 requests per channel per month), and stop at `sent` or `error`.

### How to test

- `scripts/test-buffer-posting.ts` (gate, every state change, concurrency, lateness, revocation, the public
  route) and `scripts/test-buffer.ts` (request shape and error mapping) use a scripted fake Buffer. No
  test can reach Buffer.
- **First real run:** follow [the supervised draft-mode test](development.md#supervised-draft-mode-posting-test-207)
  on a test business whose channel is a Business Instagram, with the account owner's agreement.
  Expect one draft in Buffer and nothing published. Only then consider `live`.

## Direct Meta publishing (#234)

The same worker and gate can publish an approved, scheduled post straight to the Instagram
professional account or Facebook Page the owner selected, instead of Buffer. The Connect backend,
encrypted Page token, one target per business and the `/connections` setup screen are described in
[integrations.md](integrations.md#direct-instagram-and-facebook-publishing-234--checked-2026-11-05).
The live Graph client is **not built**; the production client fails closed with
`MetaAccessNotApproved`, no live call has been run, and nothing below has been exercised against
Meta. The posting banner and schedule page use the provider-neutral connected-state rule so a Meta
target counts exactly like a Buffer connection.

- **Gate and plan.** `BUFFER_POSTING_MODE` is still the shared gate (`off`/`draft`/`live`, default
  `off`), exposed provider-neutrally as `automaticPostingMode`. Scheduling and the worker both check
  `automaticPosting`, so Free and expired owners are refused with no provider call. `off` makes no
  provider call. Meta has no draft post type, so in `draft` mode the preflight runs but no container
  is created and nothing is published; the draft returns to `approved` and the claim is `drafted`.
- **Provider choice.** Meta wins over Buffer for a business with both. The provider is written on the
  claim when the owner schedules, so later changes do not reroute a confirmed post; a business with
  neither fails closed. The rule is in `lib/services/postingGate.ts`.
- **Instagram.** Create a media container, commit its id to the claim, then publish. If the worker
  dies between those steps, the next tick reads the container status: a published container is
  confirmed, a finished one is published with the same id, and an in-progress one is polled later.
  A crash after publish but before recording the receipt is confirmed, never published again.
- **Facebook Page.** One `photos` call. Meta offers no idempotency key, so an ambiguous outcome is
  `unknown` and never resubmitted; the owner resolves it like a Buffer `unknown`.
- **Retries and errors.** Rate limits (`80002`/`80001`) and transient create errors requeue with a
  backoff and stop after five attempts. A rejected Page token marks the Page `needs_reconnect` and
  fails visibly once, with no retry loop. Permanent failures have short codes that the approval card
  turns into sentences: `rejected`, `page_cannot_publish`, `instagram_unavailable`,
  `container_unavailable`, `caption_too_long`, `too_many_hashtags`, `rate_limited`,
  `retry_exhausted`. Every transition still writes one `draft_events` row.
- **Media.** The stored original stays PNG. `renderJpegVariant`/`ensureDraftJpeg` derive a
  deterministic, content-addressed JPEG (fixed quality/chroma, flattened on white, centre-cropped
  into 4:5–1.91:1, under 8 MB). The tokenized public route serves it at
  `/api/public-media/<token>.jpg` as `image/jpeg`, and `.png` still serves the original.
- **Captions.** Instagram: 2,200 characters and 30 hashtags. Facebook: 63,206 characters. An
  over-limit post is refused with an owner-readable reason; nothing is silently cut.
- **Tests.** `scripts/test-meta-publish.ts` (DB-backed, fake Meta client) and
  `scripts/test-meta.ts` (client contract) cover the state machine, retries, crash recovery,
  duplicate delivery, plan and ownership refusals, gate modes, provider choice and the JPEG
  variant. No test can reach Meta.
- **Roll back** by setting `BUFFER_POSTING_MODE=off`; queued Meta posts wait and then become
  `missed`. A Meta target and Buffer channel are independent, so removing the target leaves Buffer
  posting available for businesses that still have it.

### The Schedule page shows what is lined up (#206)

A post that holds a slot (queued, being sent, sent and waiting, or unconfirmed) stays on the Schedule page as
a filled tile at its time, with the quote and its real posting status; the tile has Cancel while it is still
queued, and the two "did it go out?" buttons when it is unconfirmed. Open times are listed beside the filled
ones. Finished results (posted, saved as a Buffer draft, not posted) appear under "Recently sent". The page
refreshes every 5 seconds because the worker moves posts along on its own. The rules live in
`lib/posting/lineup.ts`; the status wording is shared with the Approval cards (`postingView`).

### How to roll back

Set `BUFFER_POSTING_MODE=off` and redeploy; queued posts wait and are marked `missed` after 2 hours.
**Roll back with the gate, not the image.** The migration only adds columns and widens a check, but the
previous image predates the new claim states: its slot assignment would leave claims it cannot clean up,
and a claim blocks editing its draft. If an older image must run, delete the `queued` claims and set
those drafts back to `approved` first.

### The "is posting set up?" banner (#205)

The Approval and Schedule pages ask `GET /api/businesses/<id>/posting-setup` (database only, never calls a
provider) and show one provider-neutral banner for the business: posting switched off, no posting connection
yet, needs reconnecting, no target chosen, a personal Buffer Instagram account, or a Facebook Page that cannot
publish. A business with a Meta target **or** a Buffer connection counts as posting-connected, so the page
never says "nothing connected" when either exists. The provider is chosen with the same
`selectPostingProvider` helper the scheduler and worker use (Meta wins when both exist), so the banner cannot
disagree with who would receive a post. Each fixable state links to Connections. In `draft` mode a ready
business says it is a test (Buffer drafts are saved in Buffer; Meta publishes nothing); in `live` mode a ready
business shows nothing. The wording lives in `lib/posting/postingSetup.ts`.

### Not built yet

- The phone app shows nothing about posting yet. On the web the approval cards show the status, let the
  owner cancel a queued post, and let them say whether an `unknown` post went out (recorded as
  owner-reported, never as verified). Still, keep `draft` mode to one supervised test until a real
  Buffer round trip has been seen.
- Instagram **Creator** accounts: Buffer's channel `type` has no "creator" value, so a Creator account is
  allowed only if Buffer reports it as `business`. Unverified; check on the first real channel.
- Channels saved before migration 021 have no recorded type and are refused until chosen again.

## Buffer connections screen (#29 part 2)

A signed-in owner can connect their own Buffer account from `/connections`, reached
from the profile menu, and choose one Buffer channel for each business. This screen
does not post, schedule or read media. The Connect backend, OAuth flow and token
storage are described in [integrations.md](integrations.md). Posting still fails
closed until the worker submission and reconciliation work is built.

- **Not connected:** the page explains what Buffer is for and offers Connect.
  `POST /api/buffer/connect` returns the Buffer authorize URL; nothing is posted
  without approval. With Buffer unset on the server the route answers 503 and the
  page says so instead of navigating. Automatic posting is paid (#216): a Free or
  expired plan gets 403 and a plain sentence saying it is included in Pro and
  Business, and no OAuth state or Buffer call is made.
- **Callback outcome:** `/connections?buffer=<code>` shows a fixed sentence for
  `connected`, `denied`, `expired`, `failed`, `not_configured` or `plan_required`,
  then removes the parameter with `history.replaceState`. Unknown codes show
  nothing, and the text never comes from the URL.
- **Connected and active:** `GET /api/buffer/connection` supplies the status and
  channel list. Each business shows its saved channel from
  `GET /api/businesses/:id/buffer-channel`; changing it uses `PUT` and "No channel"
  uses `DELETE`. A personal Instagram channel (`service=instagram`, `type` not
  `business`) stays listed with a note that Buffer can only remind the owner to
  post. Route error codes map to plain sentences, and `needs_reconnect` or
  `connection_changed` reloads the screen.
- **Reconnect / disconnect:** `needs_reconnect` offers Reconnect and hides the
  channel picker. Disconnect asks "Are you sure?" inline, then deletes PraiseLoop's
  saved tokens. Removing PraiseLoop from the Buffer account itself is done in
  Buffer's settings, because Buffer exposes no revoke endpoint.
- **Out-of-order guard:** each business tracks a request counter, so a late
  response for an older channel choice cannot overwrite a newer one.

Tests: `scripts/test-buffer-connections-view.ts` covers the pure wording, state and
guard rules. `scripts/test-buffer-connections-browser.ts` starts the production
build, signs in a synthetic owner, checks the not-connected state, the 503 connect
message, browser removal of `?buffer=` codes including an unknown one, and the
profile menu link. It sets an empty Buffer client id, so no Buffer call is
possible. Run it with
`TEST_BROWSER=1 TEST_DATABASE_URL=postgres://... TEST_REDIS_URL=redis://... npx ts-node scripts/test-buffer-connections-browser.ts`
after `npm run build`; it needs Chromium (`CHROMIUM_PATH`). `npm test` also runs
the pure suite.

Rollback: stop using the screen and leave `buffer_connections` and
`business_buffer_channels` in place; the backend and migrations are unchanged by
this part. Removing the profile menu entry hides the page, and disconnecting from
the page deletes only PraiseLoop's stored tokens.

## Meta publishing setup and direct publishing (#234)

The OAuth connect/disconnect backend for direct Instagram and Facebook Page publishing exists, and
worker publishing is built and tested with a fake client. The setup screen is built on `/connections`;
Buffer stays available and keeps working unchanged. The live Graph client and the owner-approved live
connect/publish test are **not built/run** — they need the owner's approved Meta app, Business
Verification and App Review. No Meta request is possible in tests or browser fixtures.
The feasibility findings, permissions, token lifetimes and owner setup are in
[integrations.md](integrations.md#direct-instagram-and-facebook-publishing-234--checked-2026-11-05);
the decision is in [decisions.md](decisions.md).

- **Connect.** `POST /api/meta/connect` (owner-wide) stores a hashed, ten-minute, single-use state
  bound to the owner and returns the Facebook Login URL. `GET /api/meta/callback` is public to the
  route guard but still needs the same owner's session, which prevents login CSRF. The callback
  exchanges the code for a short-lived User token, then a ~60-day token, and reads
  `/me/accounts?fields=id,name,access_token,instagram_business_account,tasks`.
- **Storage.** Migration 026 adds `meta_connections`, `meta_pages` and `business_meta_targets`.
  Only each Page's long-lived token is stored, encrypted with `CREDENTIAL_ENCRYPTION_KEY` and
  bound to the owner and Page; the User token is discarded. `GET /api/meta/connection` returns the
  Page list without tokens, and `DELETE` removes the connection and cascades its Pages and
  selections.
- **Selection.** `GET`/`PUT`/`DELETE /api/businesses/:id/meta-target` picks one target per business,
  `instagram` or `facebook`. The server re-checks the business and Page ownership, the Page's
  create-content task, and a linked Instagram account for an Instagram target. Selecting a Page
  that belongs to another owner, or a business the caller does not own, is a 404. Automatic
  posting stays paid: a Free or expired plan is refused at start, completion and selection.
- **Reconnect.** Pages Meta no longer returns are deleted and their selections cascade away. A
  changed linked Instagram account drops an existing Instagram target rather than publishing to a
  different account. A reconnect that returns no Pages reports `no_pages` and leaves a working
  connection alone. A rejected Page token marks that Page `needs_reconnect`.
- **Setup screen (`/connections`).** A Meta section sits beside the Buffer section. When the server
  has no `META_APP_ID`/`META_APP_SECRET`/encryption key it shows an honest "Not available yet" state
  with no Connect button (fail closed). Otherwise it offers Connect through the existing
  `POST /api/meta/connect`, shows `needs_reconnect` from the connection status, and after connecting
  lists Facebook Pages and linked Instagram accounts. Each business chooses exactly one target with
  the existing `GET`/`PUT`/`DELETE /api/businesses/:id/meta-target` routes; an Instagram option
  appears only for a Page with a linked account, and a Page that cannot publish or needs reconnecting
  stays listed but disabled with the reason. Disconnect asks inline and removes the stored access.
  Callback outcomes (`connected`, `no_pages`, `denied`, `expired`, `failed`, `not_configured`,
  `plan_required`) are shown once from `/connections?meta=<code>` and removed from the address bar.
  The wording and state rules live in `lib/meta/connectionsView.ts`.
- **Not built:** the live Graph client and the owner-approved live connect/publish test. The worker
  publishing path itself is built (see below); the setup screen and callback landing exist now.
- **Tests:** `scripts/test-meta-connections-view.ts` covers the pure screen states and wording;
  `scripts/test-meta-connections-browser.ts` walks the production build with synthetic data, the
  not-available state, target selection, reconnect and disconnect, and asserts no request goes to
  Meta. Neither test can reach Meta.
- **Backend tests.** `scripts/test-meta-connect.ts` runs against a disposable database and a fake
  Graph client: state hashing and single use, owner binding, encrypted storage and decryption, no
  tokens in views, target selection and owner isolation, reconnect shrinking, needs-reconnect,
  disconnect and cascades, pagination and refusing a foreign paging URL, plus the routes.
  `scripts/test-meta.ts` covers the stub/fake publishing adapter; `scripts/test-meta-publish.ts`
  covers the worker. All are in `npm test`; no test can reach Meta.
- **Rollback:** stop calling the routes and leave the tables in place. Disconnecting deletes only
  PraiseLoop's stored Meta tokens; a business with a Buffer channel keeps Buffer. Removing the app
  in Facebook settings is the owner's side. The live connect/publish test has **not** been run.

## Quote-card rendering

Quote-card rendering uses Sharp/Pango measured wrapping with Bricolage Grotesque, loaded
from `assets/fonts` (SIL OFL, licence alongside), on a 1080px canvas with 80px safe margins
and automatic black/white contrast. Four designs exist, all using the same brand colours,
logo and free watermark:

- **Classic** (`quote-card-v1`, the frozen original): rating stars top left and the business
  name top right as a small brand header, the verbatim quote in the middle, the reviewer's
  name as the signature bottom left, logo bottom right.
- **Spotlight** (`quote-card-v2`): a centred poster with the logo top left, business name and
  stars centred above the quote, and the reviewer centred below it.
- **Split** (`quote-card-v3`): the quote in the brand colour above a secondary-colour footer
  holding the business name, reviewer and logo.
- **Framed** (`quote-card-v4`): an editorial column with the reviewer at the top, a narrower
  quote in the middle and the business name along the bottom inside a thin secondary frame.

A review with no reviewer name has no signature: the business name is never used as one.
Quotes shrink through the sizes each design allows and are rejected verbatim if they still
do not fit, never truncated. The Polished (`premium`) tone sets the quote in DejaVu Serif.
Supply optional logos as PNG/JPEG/WebP base64 data URLs (256 KB, 4 MP maximum); remote
URLs/SVG/animation are rejected without network requests. Manual and worker generation use
the same design, tone, colours and logo. Regenerate explicitly after brand changes.
`IMAGE_EVIDENCE_DIR=/tmp/evidence npm test` saves synthetic PNGs.

Quote rendering falls back to DejaVu and Noto core/CJK fonts in both runtime images, including for Chinese, Japanese, Korean and other supported Unicode scripts. Host installations must install the same font packages before rendering.
Template settings: Brand (`/brand`) → Quote-card design → Quote text size → live
preview → Save changes. Free keeps Classic; Pro and Business include all four designs.
Settings live in `businesses.brand_colors` with data-preserving defaults in migration
005; run `npm run db:migrate`. The server checks the effective plan on both business
creation and the brand save, and refuses a design the plan does not include. After a
downgrade the saved choice is kept, but new images fall back to Classic until the plan
allows it again. Color controls choose readable black/white text automatically. Saving
settings never changes existing draft images; explicitly regenerate and review a new
image. `TEST_DATABASE_URL=postgres://... npm test` also verifies real Postgres migration
preservation and settings round-trip in a disposable schema.

## Brand voice (#97)

A Pro owner can learn a short voice profile from one public page on their own
website, then edit or reset it. Captions use the profile when it exists; without
one the prompt falls back to the tone setting exactly as before.

- **Learn:** `POST /api/businesses/[id]/brand-voice` with `{ "url": "https://..." }`.
  The server reads one page, asks the existing caption provider (OpenAI or
  OpenRouter) for 3–5 sentences plus up to five example phrases, and stores at
  most 900 characters in `businesses.brand_voice` with the source URL and
  updated time. It counts as one `generation` call against the owner's daily AI
  limit, and a failure stores nothing and returns a plain error. The page text and
  profile are never logged.
- **Edit/reset:** `PUT` with `{ "voice": "..." }` trims and caps the text at 1,200
  characters; `DELETE` clears the profile and source URL so captions use the tone
  setting again. All three routes are inside `ownerRoute`, so another owner's
  business is a 404.
- **Bounded fetch:** only `http`/`https`; the host must resolve only to public
  addresses; no URL credentials; at most 3 redirects, each staying on the same
  host or its `www.` variant; 5 second timeout; 512 KB of body; only
  `text/html` or `text/plain`; at most 6,000 characters of readable text. The
  full SSRF rules are in [architecture.md](architecture.md#security--privacy).
- **Free owners:** the Brand page says brand voice is a Pro feature and links to
  the plan page; the API refuses before fetching or calling the provider.
- **Demo:** `npm run dev:seed` gives the Pro Copper Kettle Café business a sample
  profile; the Free business keeps the tone fallback.
- **Rollback:** stop calling the route and clear the three columns if needed. The
  migration is additive and old code ignores them.

## Fetch Google reviews through Apify (#232)

A removable stopgap until official sync (#46). When `APIFY_TOKEN` is set, the reviews page shows a
form where an owner pastes one Google Maps link or place ID for their business, confirms it's their
own, and starts a fetch. The page polls until it finishes and shows what was imported.

- **Limits:** reviews per fetch come from `APIFY_REVIEW_LIMIT_FREE`, `_PRO` and `_BUSINESS`
  (defaults 5, 10 and 15). One fetch per business per `APIFY_REVIEW_RUN_INTERVAL_HOURS` (default 24),
  with a spend cap of `APIFY_MAX_CHARGE_USD` per run (default 0.50).
- **Stored:** review text, stars, date, the source review ID and a short reviewer name such as
  "Jane D.". The rows use `source='apify_google'`.
- **Risk:** Google's terms prohibit bulk downloads, and the owner accepted that. See
  [integrations.md](integrations.md) for the decision, the risk and the live-run status.
- **Tests:** `scripts/test-apify-reviews.ts`, using a fake adapter and synthetic data.
- **Rollback:** unset `APIFY_TOKEN` to hide it. Migration 023 only adds, so it can stay in place.

## CSV review import

CSV imports are limited to 1 MB / 1000 logical rows; quoted multiline cells are
supported. Optional `source_review_id` and `source_url` preserve manual-source
provenance. Reimports use a database-unique per-business/source ID, or a normalized
(rating/text/author/UTC millisecond date) fingerprint. Fingerprints cannot identify
edited reviews without stable IDs. Original text is retained. Migration 006 keeps
all historical duplicates and draft references, marks extra rows `duplicate_of`,
and prevents those rows entering new quote selection. UI reports imported,
duplicate, empty, invalid and storage-failed rows, with at most 20 redacted errors.
Ownership enforcement is supplied by #42 before any customer exposure.

Before customer access, configure owner login and explicitly claim any legacy data as described in [auth.md](auth.md).

## Approval

Approval supports inline caption edits, per-item bulk approval, archive, and persisted
job retries. Every draft mutation requires its current `version`; refresh on 409.
Approval requires nonempty caption and a decoded, available 1080px PNG. Edits and
regeneration clear approval; scheduled/published items require provider operations.
Migration 009 adds archived status, revisions and append-only actor/time/reason events.
Migration 013 adds owner-reported `shared` (only from `approved`, with `shared_at`
and an `owner_shared` audit event). It is shown as "Shared by you", never as a
verified publication, and is read-only; undo back to approved is a follow-up.
Generated PNGs now use immutable content hashes; historical images remain compatible.
After building, run `TEST_BROWSER=1 TEST_DATABASE_URL=... npx ts-node scripts/test-approval-browser.ts`
with Chromium installed (`CHROMIUM_PATH` defaults to /usr/bin/chromium). Uses synthetic
sessions and fixtures only, with no external AI/social calls. Rollback requires
stopping writes first; retain audit events, revision columns, and immutable media.

## Plans and entitlements (#94)

An owner's effective plan is `free` (the default), `pro` or `business`. The
manual grant lives in `owner_plans` with its source (`manual` or `store`) and
optional expiry; provider subscriptions live separately in `owner_subscriptions`
(#219). The owner reads the highest active grant across both, and the reported
source names the grant that won (`manual`, `store`, `stripe` or `default`).
`owner_plan_events` is an append-only audit trail of every change; provider events
never write `owner_plans`. Every owned business inherits the owner's plan, which
is what lets the plan limit "more than one business".

| Limit | Free | Pro | Business |
|---|---|---|---|
| Drafts per business per week | 1 | 5 | 5 |
| Quote-card designs | 1 (Classic) | 4 | 4 |
| Image watermark | Yes | No | No |
| Automatic posting (Buffer or Instagram/Facebook) | No | Yes | Yes |
| Automatic review sync | No | Planned | Planned |
| AI review replies | No | Planned | Planned |
| Brand voice from your website | No | Yes | Yes |
| Owned businesses | 1 | 1 | 5 |

Only limits with a feature behind them are sold as included (#218). The four
quote-card designs are shipped and `templates` is compared on the plan page,
account page and phone. `reviewSync` and `aiReplies` stay in `PLAN_LIMITS` for
later features and read as planned, never included. When #46 or #96 ships it
must check its limit on the server as part of its acceptance criteria.

The limits live in `lib/services/entitlements.ts` and are enforced on the server:

- `requestGeneration` caps the business's configured `weekly_target` inside the
  same business lock that reserves the weekly quota, including for a period
  created under an older plan.
- After a downgrade nothing is deleted. `businessAllowance` in
  `lib/services/entitlements.ts` orders the owner's businesses by `created_at`
  then `id`; only the oldest ones within `limits.businesses` stay active. The
  same check runs inside `requestGeneration`'s transaction and business lock, so
  a paused business creates no drafts, no `generation_periods` row and reserves
  no quota, and returns `business_paused`. Existing drafts of a paused business
  stay visible and can still be approved. `GET /api/entitlements` adds an
  optional `paused` flag to each usage entry; the account page and This Week show
  the pause with a link to the plans page, and the phone explains it with no upgrade
  prompt or link (see `docs/billing.md`). Upgrading raises the limit
  and resumes the paused businesses on the next request. A picker for which
  business stays active is a possible follow-up (#217).
- The worker and the manual render route pass the free-plan watermark into the
  deterministic renderer. It is drawn in the bottom safe margin, so it never
  covers the quote, reviewer, business name or logo, and a plan change produces
  a new content-addressed image.
- **Automatic posting** is the paid limit `automaticPosting` (`false` on Free,
  `true` on Pro and Business). The server reads the effective plan through
  `entitlementsFor`, so an expired plan counts as Free. It is enforced when
  starting or completing a Buffer or Meta connection, choosing a Buffer channel
  or Meta target, confirming a post for a slot, and again in the worker
  immediately before it sends. A post already queued when a plan lapses is not sent and not
  resubmitted: it ends `error`/`failed` with the `plan_required` reason, and the
  approval card and schedule explain why. Free owners keep the phone share sheet
  and image download, and approval is required on every plan.
- Business creation and the brand save check the saved design against the
  effective plan's `templates` allowance; the save keeps an unchanged design from
  before a downgrade but refuses choosing a new one the plan does not include.
  The renderer also falls back to Classic for a saved design the effective plan
  no longer allows, without changing the saved choice or any existing image.
- `POST /api/businesses` serializes creation per owner with an advisory lock and
  refuses a new business past the limit. A repeated `onboardingKey` still returns
  the original business, so a retried onboarding request cannot be blocked or
  duplicated.
- `GET /api/entitlements` is owner-authenticated, read-only and returns the
  effective plan and limits, plus `usage`: one entry per owned business with this
  week's allocated drafts against the effective cap (the owner's weekly target
  limited by the plan), whether the quota is met, whether the business is paused
  over the plan's business limit, and when the week resets
  (`resetsOn` is the next Monday in the business's timezone, `resetsAt` that
  instant). Usage reads `generation_periods` and `generationWeek`, so it never
  disagrees with what the generator enforces. `expired` is true when a stored
  Pro or Business plan has lapsed and is read as Free, and `expiredPlan` names
  the stored plan for the expiry copy. No route lets an owner change their plan
  to a paid tier without paying: checkout and the customer portal go through
  Stripe and the webhook is the only writer (#223).

### Plan page and limit messages (#133)

Plans are published: Pro is CA$29.99 a month, plus tax; Business pricing is still
open (#222), so its card says "Contact us for pricing" and has no upgrade button.
A Free owner sees **Upgrade to Pro** on `/account`, which confirms a fresh code
with `StepUpCodeForm`, then opens Stripe Checkout. An owner whose plan came from
Stripe sees **Manage subscription**, which opens the customer portal. The success
redirect grants nothing; only the verified webhook changes the plan. The page
shows a short "confirming" notice and reloads only while the plan is still Free;
a paid plan shows "Your Pro plan is active.", and after the last reload a Free
plan shows "This is taking longer than usual" instead of waiting forever. The
notice reflects the server's plan, so a cancellation or downgrade never shows
"confirming", and the page removes `checkout` from the URL once the notice is
final so a reload cannot bring it back. The plan card states where the plan came
from and its paid-through date once, with a separate note only when a stored
plan has lapsed.

- **Plan page** (`/account`, reached from the profile menu; #150): the plan, where it came from
  (default, manual, store or web subscription), its expiry, what it includes (posts per week,
  quote-card designs, watermark, automatic posting, review sync, AI replies, businesses) and
  per-business usage such as "1 of 1 post this week" with the reset date. Review
  sync and AI replies read as planned, never included (#218).
- **Expired Pro or Business** reads as Free with a note saying when that plan expired.
- **This Week** says "You've reached this week's limit" and names the plan
  limit, instead of "All caught up", when the weekly quota is used up. It
  distinguishes a plan-capped target from a quota the owner set themselves.
- **Brand settings** shows the plan's weekly allowance beside "Posts per week",
  and says how many will be made when the target is higher.
- **Phone app**: the queue screen shows the same limit message; the plan details
  themselves moved to the Profile screen (#151) and read the same endpoint. The
  phone shows status only: no upgrade prompt and no link to web checkout, because
  Apple's rules outside the US do not allow it until store purchases exist (#95).
  Wording lives in `lib/planDisplay.ts` (web) and
  `mobile/src/queue/planSummary.ts` (phone) and both are covered by tests.
  An installed app accepts any non-empty plan name the server sends, so a new
  tier cannot break it; a plan it does not recognise keeps the server's name
  instead of reading as Free (#214).
- Onboarding does not yet mention the limit; that is a follow-up.

Expired Pro or Business falls back to Free at read time without deleting the stored plan, so
a renewal restores it. Operators can still set plans with:

```sh
npm run plan:set -- owner@example.com pro --reason "Pilot upgrade"
npm run plan:set -- --business 42 pro --expires 2027-01-01
```

Those need `ts-node`, which production images leave out. On a deployed stack, run the compiled
script in the worker with the same arguments:

```sh
docker compose exec worker node dist-worker/scripts/set-plan.js owner@example.com pro --reason "Pilot upgrade"
```

The script resolves an email or business to the owner and records the actor,
reason and expiry in `owner_plan_events`. Stripe purchases use the same
subscription tables from the verified webhook (#223). Migration 012 is additive;
rollback can leave the plan tables in place while reverting the checks.

### Web checkout, webhook and portal (#223)

`POST /api/billing/checkout` creates a Stripe Checkout session after
`requireRecentStepUp`; the client sends only a plan key and the server picks the
price. A plan with no configured price is a `400`, an owner with a live Stripe
subscription is a `409` pointed at the portal, and missing config is a `503`.
`automatic_tax[enabled]=true` shows tax at checkout. `POST /api/billing/portal`
looks up the stored customer id and returns Stripe's portal URL for card changes
or cancellation.

`app/api/billing/webhook/route.ts` is public and verifies the Stripe signature on
the raw body before parsing. It handles checkout, subscription created/updated/
deleted, invoice paid/failed/succeeded and `charge.refunded`, always re-reads the
subscription from Stripe, and applies it through `applyBillingEvent`. A refund is
acknowledged and does not cancel a subscription. Unknown owners write nothing; a
still-billable subscription for a deleted owner is cancelled at Stripe so a late
checkout cannot keep charging. Repeat cancels and a missing subscription are
success. The three-day `past_due` grace lives in `PAST_DUE_GRACE_PERIOD_MS`.
`customer_id` is stored by migration 027 and never cleared by an event that omits
it. The full fixtures are in `scripts/test-stripe-billing.ts`; a Stripe test-mode
run with a test card has **not** been run because the webhook secret is not
configured.

### Public plans page (#134)

`/plans` is public: a signed-out visitor sees the Free, Pro and Business cards, what
differs (posts each week per business, watermark, automatic posting, review sync, AI replies, brand
voice, businesses) and a "Continue with Google" call to action. Pro shows
CA$29.99 a month plus tax and an **Upgrade to Pro** button; Business says
"Contact us for pricing" and has no button because #222 is open. The landing
page links to it from the header and the call to action, and also offers an
"Email me a sign-in code" option (#157) for owners without Google. When the server
has Microsoft credentials, the landing page adds "Continue with Microsoft" too
(#158); the button is hidden otherwise. `AppShell`
treats `/plans` as a bare route, like `/` and onboarding, so the signed-out
sign-in wall does not hide it.

- The comparison is worded in `lib/plansDisplay.ts` and rendered from
  `PLAN_LIMITS` in `lib/services/entitlements.ts`; the page keeps no copy of the
  numbers. `scripts/test-plans.ts` fails when a limit changes, when a new limit
  is not classified as shipped, planned or unlisted, or when a limit without a
  feature is advertised as available.
- Prices come from `PLAN_PRICING`, recorded in `docs/decisions.md` in the same
  change. The test fails if a pricing decision is recorded without prices, if a
  price appears before the decision, or if the Pro price differs. Business has no
  number until #222.
- Wording is honest about what ships: Free's small watermark is stated plainly,
  the four quote-card designs are compared, and review sync and AI replies read
  "Planned — not available yet". Nothing implies posting is connected.
- The page never starts a checkout. Its Pro button uses the session: a signed-in
  owner goes to `/account?plan=pro`, and a signed-out visitor signs in with
  Google first. Checkout, step-up and the portal live only on `/account` (#223).
- A 401 while signed out does not redirect off `/plans` (`lib/sessionExpiry.ts`
  treats `/` and `/plans` as public pages), so a visitor can read the plans and
  then choose "Continue with Google".

## Owner profile (#149)

An owner can see who they are signed in as and fix a missing or wrong display name.
One owner-authenticated endpoint serves the web profile menu (#150) and the phone
profile screen (#151), so the two cannot disagree.

- `GET /api/profile` returns `name` (null when Google supplied none and the owner
  has not set one), `email`, `nameSource` (`provider`, `owner`, or null without a
  name), `provider` (the owner's linked sign-in method, Google first, or null
  when none is linked) and `initials` for the
  avatar. It returns no
  provider tokens and no other internal ids; the owner comes from the session, so
  another owner's row is never reachable. The response is `Cache-Control: private,
  no-store`.
- `PATCH /api/profile` accepts `{ "name": "..." }`, trimmed to 1–80 characters and
  rejecting control characters with 400. The email is read-only: it is the
  verified Google identity and changing it would break account linking.
- Migration 016 adds `auth_users.name_source`. A name the owner sets is recorded as
  `owner` and survives the next Google sign-in on the web and the phone, while an
  empty name may still be filled from the provider. The demo seeder's Free owner
  has no name, so the empty state is visible after `npm run dev:seed`.
- Both cookie and mobile bearer sessions use the same guard. Anonymous requests get
  401 (the route inventory in `scripts/test-authorization.ts`), and
  `scripts/test-profile.ts` covers provider, missing and owner-edited names, the
  sign-in-after-edit case and the read-only email.
- Avatars show initials for now; keeping Google's profile picture is a later
  decision (see `docs/decisions.md`).


## Linked sign-in methods (#156)

One owner can have several sign-in methods, but every path uses one rule: the
provider plus its stable subject is the identity, never the email alone. Google
and our own email codes may still link an owner that has the same verified
address but no row for that provider; a different subject on an already-linked
address is rejected, as before (#116/#117). Apple never links by email. A provider whose email claim is not guaranteed verified
(Microsoft) creates a new owner instead of linking by email. A signed-in owner can
link another method from `/account` or the phone profile even when the emails
differ, and the last method cannot be unlinked. The phone links Google from the
profile with a native ID token through the same route.

The shared code is `lib/authLinking.ts`; `docs/auth.md` records the policy and
`docs/decisions.md` records why. Migration 017 records the method's email and
its added/last-used timestamps, and is additive. `GET /api/account/methods`,
`POST /api/account/methods` (a verified Google, Apple or Microsoft ID token) and
`DELETE /api/account/methods` are owner-wide and work with cookie and bearer
sessions. `/account` labels the providers "Google", "Apple" and "Microsoft".

Rollback: stop linking writes, retain `auth_accounts.email`, `created_at` and
`last_used_at`; old code ignores the extra columns. No owner or business data is
rewritten by the migration. `scripts/test-auth-linking.ts` covers link, reject,
unlink-last and the one-address/two-subject race.

Recovery has no in-app path until the verified email code (#157) ships. There is
no support override route and merging two owners remains an operator task.

## Profile menu (#150)

The web app keeps who the owner is and what they are on under one profile button
instead of spreading account things through the nav and the business switcher.

- The profile button sits at the bottom of the sidebar and in the phone top bar.
  It shows the owner's initials and their name where there is room. Its menu has
  a name/email header, **Plan and usage** (the full `/account` page), **Edit
  name** (inline) and **Sign out**, which deletes the server session.
- A missing name shows an unobtrusive "Add your name" prompt in the menu and on
  the profile page, never a blank or the raw email. The email is shown read-only.
- `/account` is now the full profile and plan page: name, read-only email, inline
  name editing, then the existing plan, limits and weekly usage sections. Editing
  the name updates the menu and the page through shared state, with no reload.
- "Plan" is no longer a top-level nav item, so the tab bar is back to the four
  work screens and the five-item layout from #141 is gone. Sign out is only in the
  profile menu; it was removed from the sidebar and the phone business dropdown.
- At phone width the profile button is in the top bar and its menu is anchored to
  it, inside the viewport and above the tab bar. It is a real button with an
  accessible name; Escape and an outside click dismiss the menu, and Escape
  returns focus to the button.
- Wording and the menu items live in `lib/profileDisplay.ts` (pure and
  client-safe), covered by `scripts/test-profile-display.ts`. The browser
  walkthrough (open, edit the name, reach the plan page, sign out, phone width) is
  `scripts/test-profile-browser.ts`.
- The demo seeder's Pro owner is named and its Free owner has no name, so both
  states can be walked with `npm run dev:seed`.


## Phone sign-in (#85, #92, #158)

The phone signs in to the same owner account as the web. Google uses the native
account picker: the app sends the Google ID token to `POST /api/mobile/session`
and keeps only our bearer token in the keychain.

- **Continue with Google** appears only when the native module is present (a
  development or store build, not Expo Go) and `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`
  is set. Cancelling the picker returns to sign-in without an error banner; a
  failed exchange shows a plain-language message.
- **Continue with Apple** appears on iOS 13+ when `expo-apple-authentication` is
  compiled in and reports available. It requests name and email, sends the Apple
  identity token (and the first-sign-in name, if any) to
  `POST /api/mobile/session/apple`, and keeps only our bearer token. Cancelling
  the Apple sheet is also a quiet no-op. The server verifies Apple's signature,
  issuer, expiry and `APPLE_CLIENT_ID`; Apple never links to an existing owner by
  email (link it from a signed-in session instead).
- **Continue with Microsoft** appears when `expo-auth-session` is present and
  `EXPO_PUBLIC_MICROSOFT_CLIENT_ID` is set. It opens Microsoft's discovery
  document and authorization page with PKCE, requests `openid email profile`,
  exchanges the code for an ID token and sends that token to
  `POST /api/mobile/session/microsoft`. Closing the browser is a quiet no-op.
  The server verifies the RS256 signature against Microsoft's multi-tenant keys,
  the v2.0 issuer and its `tid` claim, the audience and expiry, and uses
  `${tid}:${oid}` (tenant plus object id, shared across app registrations) as the identity; Microsoft never links to an existing owner by
  email. No secret is used or stored on the phone.
- Expo Go hides the Google and Apple buttons and keeps the dev-only demo owner
  and the email-code sign-in. Android hides Apple because the module and the
  platform do not offer it. Microsoft uses a browser flow and needs a development
  or store build for its registered `praiseloop://auth/microsoft` redirect URI.
- An owner with no business sees a short setup screen instead of the queue: a
  heading, one sentence that setup and branding happen on the web, **Set up on
  the web** (opens `${apiBaseUrl}/onboarding`; hidden when the build has no API
  URL) and **Check again** to reload the business list.
- Covered by `mobile/__tests__/google.test.ts`,
  `mobile/__tests__/googleSignIn.test.ts`, `mobile/__tests__/apple.test.ts`,
  `mobile/__tests__/appleSignIn.test.ts`,
  `mobile/__tests__/microsoft.test.ts`,
  `mobile/__tests__/microsoftSignIn.test.ts` and
  `mobile/__tests__/onboarding.test.ts`. The server side is
  `scripts/test-apple-signin.ts` and `scripts/test-microsoft-signin.ts`. A device
  or simulator check with the real OAuth clients, Apple account and Microsoft
  account still waits on owner setup; none was run in this change.

## Phone profile screen (#151)

The phone app reaches the profile from an initials avatar button in the queue
header; it is a normal expo-router screen with its own back button, so opening a
draft from the queue and coming back still works.

- The avatar shows initials from the name, or from the email's local part when
  Google gave no name. The queue loads the profile best-effort on focus, so a name
  edited on the profile screen shows up on the way back.
- **Name** and **email**. A missing name shows **Add your name**, a saved one
  shows **Edit name**; the email is read-only. A saved name appears immediately
  and after relaunch. The name rule is checked on the phone before the request
  (`mobile/src/profile/identity.ts`, mirroring `lib/services/profile.ts`) and the
  server's own 400 message is shown if it still rejects it.
- **Sign-in methods**: the methods linked to the owner, each with its provider
  name, email and added date (or "Added before we tracked method dates" for
  rows without one). **Unlink** asks for confirmation in the screen first and is
  disabled for the only method, with the same hint as the web page. **Link
  Google** appears when the build supports Google and it is not linked yet;
  the native ID token goes straight to `POST /api/account/methods` and is never
  stored or logged. The server's own refusal is shown on failure and the list is
  replaced from the response on success.
- **Your plan**: the plan, its limits, this week's usage per business and the
  expiry note, moved here from the bottom of the queue. The queue keeps only the
  short "weekly limit reached" message that explains an empty week.
- **This app**: the app version and the API server it is talking to, for support
  and for the demo stack.
- **Notifications**: a real toggle for the weekly reminder; see
  [Phone notifications](#phone-notifications-89) below.
- **Sign out**: revokes the session on the server, clears the stored token and
  returns to sign-in.
- Profile, plan and method requests are best-effort. A failure shows a retry on
  the profile screen and never blocks the queue, while a 401 goes through the
  session's `handleError` back to sign-in (see #137).
- Covered by `mobile/__tests__/profile.test.ts` (initials, display name, the name
  rule, method names, added dates and the unlink rule) and
  `mobile/__tests__/methods.test.ts` (list, unlink and link, 400/409 messages and
  401) plus the client's best-effort test. Manual checks on iOS and Android are
  recorded in the PR.

## Phone approval queue and sharing (#86, #87)

The phone queue is the weekly approval flow: it lists this business's drafts,
approved posts and owner-reported shared posts, keeps the last loaded queue
read-only when offline, and shows generation progress from
`GET /api/generation`. Opening a post shows the full image, caption, quote and
rating. Every mutation sends that draft's `version`; a 409 reloads the screen
and says the post changed somewhere else, like the web queue.

- **Edit, approve, archive.** Saving a caption still needs the same 1–200
  character rule as the web. Approving saves a pending caption first, so the
  owner never approves the text that is about to be replaced.
- **Make a new version.** Available for a finished draft or a failed generation.
  A confirmation dialog says that PraiseLoop writes a fresh caption and image,
  clears approval and uses one of the post's two new-version attempts.
  `POST /api/generation/regenerate` is the existing `ownerRoute`, so the phone
  uses the normal bearer session. Success returns to the queue, where the
  cleared post appears as "being made" with the generation progress. A 409 for
  a stale version or a generation that is still active reloads the post and
  explains what happened; an exhausted retry budget, the daily limit and an
  expired session each get their own plain-language message.
- **Post.** On an approved post, **Post** downloads the owner-protected PNG into
  the app cache, copies the caption and opens the system share sheet. The owner
  is told to paste the caption because Instagram does not accept it from another
  app, and the post is only marked `shared` after they answer "Did you post it?".
- **Save to Photos.** Also on an approved post, **Save to Photos** downloads the
  same PNG and adds it to the device library with `expo-media-library`. The
  photo-library permission is requested only when the button is pressed, and
  only for adding photos. A denied permission explains how to enable it in the
  phone's settings; a failed download keeps the reason on screen; the cached
  copy is deleted afterwards. The module is required lazily, so Expo Go and Jest
  still start without it, and it is unavailable there rather than fatal.
- Covered by `mobile/__tests__/queueState.test.ts`,
  `mobile/__tests__/drafts.test.ts`, `mobile/__tests__/shareFlow.test.ts`,
  `mobile/__tests__/regenerateFlow.test.ts` and
  `mobile/__tests__/saveToPhotosFlow.test.ts`. Manual iOS and Android checks
  with Instagram and Facebook installed are still recorded in the PR.

## Delete account (#93)

An owner can delete their account from the web profile page (`/account`) or the
phone profile screen. Both show what is removed, say that a web subscription is
cancelled for them, state that an App Store or Google Play subscription must be
cancelled in its store, and require typing `DELETE` before the button works. The
phone copy has no purchase link or prompt.

- `DELETE /api/account` takes `{"confirm": "DELETE"}` and is owner-wide, so the
  phone's bearer session works as well as the web cookie. Anything else is a
  `400` with no changes. The session cookie is cleared on a successful cookie
  request.
- Before local data is deleted, every `owner_subscriptions` row that can still
  bill is cancelled through the provider (store subscriptions are skipped because
  we cannot cancel them). A failed cancel returns `503` with a retry message and
  deletes nothing, so the owner stays signed in and a retry is safe even if an
  earlier attempt cancelled only some rows; a second cancel and a subscription
  already missing at Stripe are success (#223). An owner with no subscriptions
  needs no billing provider and makes no network call. A provider event that
  arrives after the owner is gone is acknowledged and records nothing, and a
  still-billable subscription is cancelled at Stripe (#220, #223).
- The deletion, cascade list, media cleanup and the "nothing is kept today"
  policy are documented in [auth.md](auth.md#deleting-an-account-93). There is no
  soft delete or recovery period.
- After success the web page signs out and returns to `/`; the phone clears the
  keychain token and returns to sign-in. The server already deleted the session,
  so the phone's normal sign-out treats the revoke call as best-effort.
- Confirmation, wording and error handling are `mobile/src/profile/accountDeletion.ts`
  with `mobile/__tests__/accountDeletion.test.ts`; the API call is
  `mobile/src/api/account.ts`. `scripts/test-account-deletion.ts` runs against a
  disposable database (owner A deleted, owner B untouched, media and sessions
  checked, live subscriptions cancelled, a failed cancel and a retry) and is in
  the `npm test` chain. `scripts/test-billing.ts` covers the late event and
  `scripts/test-stripe-billing.ts` covers Stripe cancels and repeat attempts.
- Rollback: no schema change is involved. Restoring a deleted account is not
  possible; stop deploying the route to disable the feature.

## Phone notifications (#89)

Push is the weekly way back into the app: the worker sends "posts are ready" for
a business (#88) with a deep link to that business's queue. #89 adds the phone
half.

- **Permission**: after the first successful sign-in the queue shows a card
  explaining "We'll tell you when your week of posts is ready". Only **Turn on
  notifications** asks the OS; **Not now** stores the choice in the same keychain
  used for the session (`expo-secure-store`) and unregisters any cached token, so
  it behaves like the Profile switch. The card re-reads the stored choice every
  time the queue regains focus, so turning notifications on in Profile removes it
  without a relaunch. The explanation is hidden in Expo Go, on simulators and
  when the build has no EAS project id, because no token can be obtained there.
- **Registration**: the app lazily requires `expo-notifications` and
  `expo-device` (Expo Go and Jest still start). It reads the project id from
  `Constants.expoConfig?.extra?.eas?.projectId` or `Constants.easConfig?.projectId`
  (`app.config.ts` fills the former from `EXPO_PUBLIC_EAS_PROJECT_ID`) and calls
  `POST /api/mobile/push-tokens` with
  `{token, platform: "ios"|"android"}`. A signed-in launch with notifications on
  refreshes the token. Sign-out calls `DELETE /api/mobile/push-tokens`
  best-effort before revoking the session. If a relaunch cleared the in-memory
  token, turning notifications off stores a pending marker; the next launch or
  sign-out obtains the token and removes the registration once it can, and keeps
  the marker while the OS still cannot provide one.
- **Deep link**: a notification tap parses
  `praiseloop://queue?businessId=<id>` and checks a positive integer before
  navigating. With no session the target is kept in memory until sign-in, then
  the queue opens for that business; an id the owner does not own falls back to
  the first business. The link applies once: after it opens the queue, a focus or
  pull-to-refresh reload keeps the business chip the owner selected instead of
  snapping back to the old URL parameter, while a new link selects again.
- **Settings**: the profile's Notifications section is a switch. Off unregisters
  the device and remembers the choice. On requests permission if needed and
  registers. A denied OS permission is explained with a link to system settings.
- Covered by `mobile/__tests__/notifications.test.ts` (permission mapping and
  denial, register/unregister calls with a mocked API, a pending marker when the
  token is unavailable, deep-link parsing and routing with/without a session, the
  stored choice, the toggle and launch refresh),
  `mobile/__tests__/queueSelection.test.ts` (a link applies once, a refresh keeps
  the owner's chip choice, and an unowned id is ignored) and
  `mobile/__tests__/notificationNative.test.ts` (mocked native module, project id,
  token cache, permission read/request). No physical device was available: the OS
  prompt, real Expo delivery and the tap on hardware are still manual checks.
- Owner setup, not committed: an APNs key for iOS, a Firebase/FCM project for
  Android and the EAS project id (see `mobile/README.md`). Without them the app
  says notifications are unavailable rather than failing at launch.
- Rollback: remove the notification modules, the queue card and the profile
  section; the preference key and server tokens are ordinary local/API state,
  and removing a token from the server simply stops deliveries.

## Demo owner picker (#154)

In a development process with `MOBILE_DEV_AUTH=1`, the phone sign-in screen and
the web landing page each offer one button per seeded synthetic owner: **Pro
demo owner**, **Business demo owner**, **Free demo owner** and **Email demo
owner**. The Free owner walks the watermark, weekly limit and plan page; the
Business owner walks the Business plan and shows a seeded web subscription
(#219); the email-only owner walks the
account with no businesses (`npm run dev:seed` creates all four).

- The phone still uses `POST /api/mobile/session/dev` with
  `{"owner":"pro"|"business"|"free"|"email"}` and a bearer token.
- The web uses `POST /api/dev/session` with the same body. It creates the normal
  hashed `auth_sessions` row and NextAuth cookie, so the whole web app works
  without Google. `GET /api/dev/session` supplies the button labels; it and the
  POST answer 404 when the flag is off, and the POST also requires the app's own
  Origin.
- Unknown owner keys are 400; only the seeded demo rows are reachable, never a
  real owner. Production builds answer 404 even with the flag set.
- Verify with `TEST_DATABASE_URL=... npx ts-node scripts/test-dev-auth.ts`
  (gates, unknown key, a working web cookie that reads `/api/profile`) and
  `npx ts-node scripts/test-authorization.ts` without `MOBILE_DEV_AUTH`. The
  phone's list is covered by `mobile/__tests__/demoOwners.test.ts`.
- Rollback: remove the buttons and routes; the demo owners are ordinary
  `auth_users` rows, so no data migration is involved.
