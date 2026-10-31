# Architecture

## Tech stack

Define and maintain the core stack in this section as the source of truth:

### Runtime(s)

- Node.js (TypeScript)

### Framework(s)

- Next.js (app + API routes) for web UI + API surface
- Worker process for background jobs (separate entrypoint)
- Expo (React Native, TypeScript) for the owner's iOS/Android app in `mobile/`, a separate package that talks only to our API ([mobile-first plan](mobile-plan.md))

### Data store(s)

- Postgres (primary datastore)
- Redis + BullMQ for generation delivery; Postgres outbox, quotas and renewable claims are authoritative
- If we later want fewer moving parts, we can consider a Postgres-backed queue, but start with Redis for maturity.

### Infrastructure / deployment model

- Docker Compose for MVP: the pilot runs on a home server behind a Cloudflare Tunnel, then a small VPS ([hosting](mobile-plan.md#hosting)):
  - web: Next.js
  - worker: background jobs
  - postgres
  - redis
  - Generated images: shared `generated_media` volume between worker and web containers; S3-compatible (MinIO) object storage is a future option

### Testing and CI tooling

- Tests: Node `assert` suites run via ts-node (`scripts/test-*.ts`) with synthetic fixtures (no external services required)
- Lint: ESLint (flat config + typescript-eslint)
- CI: GitHub Actions (lint, typecheck, test, production build)

## Key patterns

### Product boundaries (modules)

- Ingestion: review sources → normalized Review records
- Curation: quote selection + ranking
- Generation: captions + variants + metadata
- Rendering: templates → images
- Scheduling: publish/schedule integration (scheduler-first)
- Approval: human-in-the-loop state machine for drafts
- Entitlements: owner plan → server-enforced limits for generation, rendering and business creation

### Data flow rules

- All writes go through the API layer (no direct DB writes from UI)
- Worker consumes jobs and writes results back to Postgres
- Rendering is deterministic from (template + brand + quote + caption + plan watermark)
- Plan limits live in one server module; clients read them from `GET /api/entitlements` and never unlock features themselves

### API compatibility for the mobile app

- Installed apps cannot be upgraded on demand. API changes the app uses must be
  additive; a breaking change needs a new route and an old one kept until the
  minimum supported version moves past it.
- `GET /api/mobile/config` is public and owner-free. It returns
  `minimumVersion`, `latestVersion` and `features` from `MOBILE_MINIMUM_VERSION`,
  `MOBILE_LATEST_VERSION` and comma-separated `MOBILE_FEATURES` (defaults:
  `1.0.0`, `1.0.0`, none). Below `minimumVersion` the app shows an update screen.
  `devAuth` is `true` only in a development process with `MOBILE_DEV_AUTH=1`, and
  tells the app it may show the demo sign-in button.
  The response is cacheable for a short time and carries no cookies. It,
  `POST /api/mobile/session/dev` (development only) and the three public
  email-sign-in routes in `docs/auth.md` are the only unauthenticated routes
  besides NextAuth's handlers.

### State machine (draft lifecycle)

- ImportedReview → CandidateQuote → DraftPost → Approved → Scheduled → Published (best-effort)
- Owner-reported sharing: Approved → Shared (#83). `shared` is never shown as a verified Published; it records `shared_at` and an `owner_shared` audit event, and is read-only afterwards (undo is a follow-up).
- Every transition is stored with timestamps for audit/debugging

### Error handling and observability

- All external API calls must be wrapped with:
  - timeouts
  - retries with backoff (bounded)
  - structured logging including request IDs
- Record "why failed" in job metadata; never silently drop jobs

### Security / privacy

- Never store OAuth refresh tokens unencrypted at rest
- Do not store more customer review data than needed (quote + rating + date + source id)
- No secrets in repo; env vars only
- Brand voice fetches one owner-supplied public page through `lib/services/safeFetch.ts`.
  The URL must be `http`/`https` with no credentials. The hostname is resolved
  with `node:dns` (all answers) and every address must be public: loopback,
  private, link-local, CGNAT, multicast, unspecified, unique-local and
  IPv4-mapped/6to4 forms of those ranges are rejected, as are `localhost` names.
  The HTTP client connects to the verified address through its own lookup, so a
  second DNS answer cannot rebind the request. Redirects are limited to 3 and each
  hop is re-resolved and must stay on the same host or its `www.` variant. The
  request times out after 5 seconds, reads at most 512 KB, accepts only
  `text/html` or `text/plain`, and keeps at most 6,000 characters of readable
  text. Fetched page text is passed to the model as quoted untrusted data and is
  never logged.
- Account deletion is immediate and complete: `DELETE /api/account` removes the
  owner, businesses, reviews, drafts, generated images, sign-in methods, plan and
  usage records, push tokens and sessions. **What is kept: nothing today** — there
  is no legal-retention archive, soft delete or recovery period. Generated media
  is removed from `MEDIA_ROOT` after the database commit with a retry-safe cleanup.
  Deleting an account does not cancel an App Store or Google Play subscription;
  the web and phone confirmation screens tell the owner to cancel it in the store.

## Directory structure

```text
.
├─ README.md / CONTRIBUTING.md
├─ docs/           # product, architecture, decisions, plans, feature and ops docs
├─ app/            # Next.js app (UI pages + API routes)
├─ lib/            # shared domain logic (db, services, integrations)
├─ worker/         # durable generation worker entrypoint
├─ scripts/        # migrations, db health, scheduling sweep, test suites
├─ db/migrations/  # SQL migrations
├─ mobile/         # Expo app (planned)
└─ Dockerfile.web / Dockerfile.worker / Dockerfile.dev / docker-compose*.yml
```

## Don’t do X

- Don’t add new frameworks without a documented decision (`docs/decisions.md`)
- Don’t let UI talk directly to external APIs (go through our API)
- Don’t embed secrets/tokens in logs
- Don’t auto-post without an explicit approval step (MVP)
