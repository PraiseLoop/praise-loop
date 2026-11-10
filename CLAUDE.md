# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

PraiseLoop turns customer reviews into branded social posts for local businesses behind a human approval queue. **Read `docs/design.md` first**: it is the map of how the app works, the rules reviewers enforce, and where each decision lives. A Next.js app (UI + API routes) and a separate worker share one Postgres. An Expo phone app (`mobile/`, its own package) talks only to the API. Docs in `docs/` are the source of truth for design (`architecture.md`, `auth.md`, `features.md`, `decisions.md`, `mobile-plan.md`); update them when behavior changes. When asked "what's next?", read `docs/roadmap.md` (order of work, owner tasks, blockers) and keep it current in the PR that finishes an item.

## Commands

Node 22 (`.nvmrc`), npm.

```bash
cp .env.example .env && npm ci
docker compose up -d postgres redis
npm run db:migrate && npm run db:health
npm run dev              # web on :3000
npm run worker           # generation loop, separate terminal
npm run lint && npm run typecheck
npm test                 # all suites; run before requesting review
npm run test:browser     # needs TEST_BROWSER=1, TEST_DATABASE_URL, Chromium
```

Tests are plain `assert` scripts, not a framework. Run one with
`npx ts-node --compiler-options '{"module":"CommonJS","moduleResolution":"node"}' scripts/test-<name>.ts`
(the `ts-node scripts/...` form also works for most). New suites must be appended to the long `"test"` chain in `package.json`.

Suites that use `databaseFixture` (`scripts/db-fixture.ts`) **skip silently and exit 0** unless `TEST_DATABASE_URL` is set; set it, otherwise a green run proves little. The fixture creates a throwaway database. Generation-queue tests also need `TEST_REDIS_URL`.

## Architecture

- **Pipeline:** reviews (CSV import, `source='manual'`) → `quoteSelector` → `generation.ts` reserves a weekly quota (`generation_periods`) and enqueues `generation_jobs` → worker (`worker/index.ts`, BullMQ delivery with Postgres as the authority) writes caption + rendered PNG into `draft_posts` → owner approves. Rendering (`imageRenderer.ts`, sharp) is deterministic and content-addressed; images are served from the shared media volume via `/api/media/<name>`, never from `public/`.
- **Draft lifecycle:** all draft mutations go through `draftMutation` in `lib/services/draftLifecycle.ts`: optimistic `version` check (409 on stale), blocked while generation is active or provider scheduling exists, and every transition writes an append-only `draft_events` row. Scheduling fails closed; nothing auto-posts.
- **Auth:** every route under `app/api` must be wrapped in `ownerRoute` (`lib/authorization.ts`), which handles NextAuth cookie sessions and hashed mobile bearer sessions, ownership checks, CSRF/origin, and upload limits. `scripts/test-authorization.ts` calls every exported route handler anonymously and expects 401, so a new route is public only if explicitly allow-listed there (e.g. `/api/mobile/config`). Routes that are owner-wide rather than business-scoped are listed in `OWNER_WIDE_PATHS`.
- **Data access:** `lib/db.ts` `query()` transparently joins an active `transaction()` via AsyncLocalStorage, so `query` inside a transaction callback is transactional.
- **Integrations** (`lib/integrations/`) are built against stubbed interfaces; the live scheduler/Google clients fail closed until access is approved.
- **Migrations:** `db/migrations/NNN_name.sql`, forward-only, applied in filename order. Parallel PRs collide on the number; renumber the later one when rebasing (renumbering a file that was already applied is safe: the runner matches the name after the number).

## Repo rules

- Follow `CONTRIBUTING.md`: one PR per issue, no dependency upgrades unless asked, tests required, `Closes #<id>` (or `Refs #<id>` for partial work), no schema change without an issue and migration, never auto-post.
- The `master` ruleset requires linear history and **all review threads resolved**; squash merge is disabled in repo settings, so merge with `gh pr merge --rebase`. Automated Codex review leaves threads that must be answered and resolved before merge.
- When new code adds or changes a table, column, feature state or other sample-worthy behaviour, check whether the dev seeder (`scripts/dev-seed.ts`, `scripts/seed/`) and `sample-data/` need updating, and do it in the same PR. `scripts/test-dev-seed.ts` fails when the seeder no longer runs against the migrated schema.
- Tests and fixtures use synthetic data only (`@example.invalid` emails); never put real reviews, tokens or keys in the repo.
