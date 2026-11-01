# PraiseLoop

Turns existing customer reviews into ready-to-post social media content for local
businesses: deterministic quote selection, AI captions in the brand voice, branded
image rendering, and a human-in-the-loop approval queue.

PraiseLoop is moving to a phone app for owners, backed by this server: see the
[mobile-first plan](docs/mobile-plan.md).

## Prerequisites

- Node.js 22+ and npm 10+ (see `.nvmrc`)
- Docker with the Compose plugin (runs Postgres and Redis containers); the
  all-containers dev override needs Compose 2.24.4+ (`docker compose version`)

## Quickstart — host + containers (recommended for development)

```bash
cp .env.example .env
npm ci
docker compose up -d postgres redis
npm run db:migrate
npm run db:health
npm run dev        # web on http://localhost:3000
npm run worker     # in another terminal: draft generation loop
```

Before customer access, configure owner sign-in and claim any legacy data as
described in [docs/auth.md](docs/auth.md).

All-containers workflows, configuration, tests and deployment:
[docs/development.md](docs/development.md).

## Current limitations

- Reviews come from manual CSV import; Google review sync is blocked on provider
  access ([integrations](docs/integrations.md)).
- Real publishing isn't configured; scheduling fails closed
  ([integrations](docs/integrations.md)). The mobile plan replaces it with the
  phone's share sheet for the MVP.
- Owner sign-in needs Google OAuth configuration (#78).

## Documentation

| Doc | What's in it |
|---|---|
| [docs/design.md](docs/design.md) | **Start here.** How the whole app works and why: system map, domain, auth, status, rules, how to change things |
| [docs/mobile-plan.md](docs/mobile-plan.md) | Where the product is going: phone app, hosting, AI features, plans |
| [docs/product.md](docs/product.md) | Who it's for and what the MVP does |
| [docs/architecture.md](docs/architecture.md) | Stack, modules, data flow and rules |
| [docs/decisions.md](docs/decisions.md) | Decision log |
| [docs/features.md](docs/features.md) | How each shipped feature works, and how to test and roll it back |
| [docs/auth.md](docs/auth.md) | Owner sign-in, access rules and media privacy |
| [docs/integrations.md](docs/integrations.md) | Buffer and Google Business Profile feasibility and owner setup |
| [docs/development.md](docs/development.md) | Containers, configuration, migrations, tests, worker, deployment |
| [docs/pilot.md](docs/pilot.md) | Running the paid pilot |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Team rules and the agent workflow |
