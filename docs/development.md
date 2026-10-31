# Development and operations

Setup beyond the [README](../README.md) quickstart: container workflows, configuration, migrations, tests, the worker and deployment.

## Quickstart — all containers (development, hot reload)

```bash
cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Later runs only need `up`; add `--build` after changing `Dockerfile.dev`.

The dev override runs `next dev` and mounts the repository into the
migrate/web/worker containers as uid/gid 1000 (the image's `node` user), so
files they write stay owned by you. Rendered media goes to `./private-media`
instead of the `generated_media` volume.

Startup order is `deps` → `migrate` → `web`/`worker`. `deps` keeps the shared
`node_modules` volume in sync with `package-lock.json`, running `npm ci` only
when the lockfile changed, so pulling new dependencies needs no rebuild or
volume reset. If the stack is already running when dependencies change, run
`up` again and then `restart web worker`. Migrations run from the mounted
source, so new migration files apply on the next `up`.

### Troubleshooting

- **`password authentication failed for user "postgres"`**: the
  `postgres_data` volume keeps the password it was first initialized with;
  later `POSTGRES_PASSWORD` changes are ignored. Reset it to match `.env`
  (keeps data):
  `docker compose exec postgres psql -U postgres -c "ALTER ROLE postgres PASSWORD '<POSTGRES_PASSWORD>'"`
- **`Module not found` / `Cannot find module` after a pull**: run `up` again so
  `deps` resyncs, then restart web/worker. As a last resort,
  `docker compose -f docker-compose.yml -f docker-compose.dev.yml down` and
  `docker volume rm praise-loop_node_modules`.
- **`Permission denied` on `.next/`, `public/` or `private-media/`**: files left
  root-owned by older containers; `sudo chown -R $USER:$USER .` once.

## Phone app in the dev stack

`docker compose -f docker-compose.yml -f docker-compose.dev.yml up` also starts a
`mobile` service: the Expo dev server for the phone app in `mobile/`, so it comes up
with the web app and worker. Watch its logs for a QR code and an `exp://<LAN address>:8081`
URL. On a phone on the same Wi-Fi, install **Expo Go** (App Store or Google Play), scan the
QR code (or enter the URL under "Enter URL manually"), then see the demo flow below to sign in.

- It runs on the **host network** (Linux; Docker Desktop on macOS/Windows does not support
  that) so it can detect the LAN address a phone reaches. Set `DEV_LAN_IP` in `.env` to
  override the detected address (several networks, a VPN). The app is pointed at
  `http://<LAN address>:3000` automatically.
- Dependencies install into `mobile/node_modules` on first start and again whenever
  `mobile/package-lock.json` changes. Source edits reload on the phone.
- The service waits for the web container to be healthy. To skip it, add
  `--scale mobile=0` to `up`.
- Port 8081 must be free. If you start Expo by hand (`npm start` in `mobile/`) at the same
  time, stop it first or set `MOBILE_PORT` in `.env` for one of them.
- A firewall may block the phone from reaching ports 3000 and 8081. On Fedora with
  firewalld, allow them for your network (for example `sudo firewall-cmd --add-port=8081/tcp
  --add-port=3000/tcp`, which lasts until reboot).
- Expo Go covers the demo flow. Native Google, Apple and Microsoft sign-in and push
  notifications need a development build (#85, #89, #92, #158); push also needs the EAS
  project id and APNs/FCM credentials listed in `mobile/README.md#push-notifications`,
  Apple needs iOS 13+ and `APPLE_CLIENT_ID` on the server, and Microsoft needs
  `MICROSOFT_CLIENT_ID` on the server plus `EXPO_PUBLIC_MICROSOFT_CLIENT_ID` in the
  app; a button stays hidden elsewhere.

## Demo flow with synthetic data

The phone flow can be walked end to end without Google OAuth, an OpenAI key or a
review provider. It is a development-only path; a production build (`next start`)
answers 404 for the demo sign-in even if the flag is set.

1. Put the flag in `.env` (it stays blank in `.env.example`):

   ```
   MOBILE_DEV_AUTH=1
   ```

2. Start the development stack and seed the demo owner:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
   docker compose exec web npm run dev:seed
   ```

   On the host (Node 22, `DATABASE_URL` from `.env` pointing at `localhost`) run
   `npm run dev:seed` instead. It needs no OpenAI, OpenRouter or Google
   credentials. What it creates:

   | Owner | Plan | Businesses |
   | --- | --- | --- |
   | `dev-owner` (`demo@praiseloop.invalid`) | Pro | Copper Kettle Café (21 reviews, 7 drafts), Hespeler Powder Coating (24 reviews, 6 drafts) |
   | `dev-owner-free` (`demo-free@praiseloop.invalid`) | Free | Harbour Bike Repair (17 reviews, 3 drafts) |
   | `dev-owner-email` (`demo-email@praiseloop.invalid`) | Free | None; an email-only owner for walking email sign-in |

   Each business has its own timezone and branding. The reviews (ratings 1 to 5
   across several months) are loaded from `sample-data/csv/` through the same
   import code as the app's CSV upload. Drafts cover every status: `draft`,
   `approved`, `shared`, `archived` and `failed` (a failed generation has a quote
   but no caption or image). Images are rendered locally, with the watermark on
   the Free owner's. The Pro owner also gets a synthetic push token and a stub
   Google connection on the café (no refresh token, so nothing can sync). The
   current week's generation period is reserved so the worker does not add more.
   The fake push token may make the worker contact Expo once; Expo rejects it and
   the token is dropped.

   The seed is idempotent. Running it again replaces only the three demo owners'
   businesses (and everything under them, plus their images) and leaves other
   owners alone; ids change, content does not. To reset, run it again. To remove
   the demo data, delete those owners' businesses, or drop the dev database
   volume. Edit `scripts/seed/fixtures.ts` and `sample-data/csv/` to change what
   is seeded.

   The seed refuses to run unless `MOBILE_DEV_AUTH=1` in a non-production
   process and `DATABASE_URL` points at `localhost`, `127.0.0.1`, `::1`, a Unix
   socket or the Compose service name `postgres`.

3. Run the app on a phone with Expo Go. `localhost` points at the phone, so use
   the machine's LAN address:

   ```bash
   cd mobile
   npm ci
   EXPO_PUBLIC_API_BASE_URL=http://192.168.1.20:3000 npm start
   ```

4. On the phone, tap the demo button for the owner you want: **Pro demo owner**
   (Copper Kettle Café and Hespeler Powder Coating), **Free demo owner** (Harbour
   Bike Repair, with the watermark and the Free plan limits) or **Email demo
   owner** (no businesses; walks the email-only account). Each button creates a
   normal bearer session for that seeded owner. Approve a post, then open the
   approved one and tap **Post** to open the share sheet. The caption is copied
   to the clipboard; answer “Did you post it?” to record `shared`.

5. On the web, open `http://localhost:3000` and use the same three buttons under
   the sign-in options. They create the ordinary web session cookie for the
   chosen owner and go to `/approval`, so This Week, Plan and Brand can be used
   with the seeded data and no Google account. The buttons appear only when the
   server reports dev sign-in enabled; otherwise the route answers 404 and the
   page shows nothing.

   The same flag and production guard apply to the phone and the web. The
   bearer route is `POST /api/mobile/session/dev` and the cookie route is
   `POST /api/dev/session`; both accept `{"owner":"pro"|"free"|"email"}`.

Queue thumbnails and the draft screen's image are fetched like the share flow:
the app downloads the owner-protected PNG with `expo-file-system` and the bearer
token into its cache, then renders the local file. React Native's core `Image`
does not reliably send custom headers in Expo Go, so do not switch these back to
`source={{ uri, headers }}`. A failed download shows a tappable retry
placeholder; a 401 returns the app to sign-in. With the phone on the demo owner,
the web log should show `200` for its `/api/media/draft-…png` requests. The seed
is unchanged: its `image_path` values already point at the rendered files.

The demo owner is an ordinary `auth_users` row, so ownership checks, version
conflicts and audit events behave exactly as they do for a real owner. Never set
`MOBILE_DEV_AUTH` on a shared or production server.

## Quickstart — all containers (production-style)

```bash
cp .env.example .env
docker compose up --build
```

Runs migrations once, then starts the built web app (`next start`) and the
compiled worker. Generated images are shared between worker and web via the
`generated_media` volume. Put this behind a reverse proxy; only port 3000 is
published.

## Configuration

Copy `.env.example` to `.env`. Never commit `.env`.

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes (host exec) | Host execution connects to `...@localhost:5432/...`; Compose services build their own URL from `POSTGRES_*` via the `postgres` service name |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | yes (containers) | Defaults in `.env.example`; do not rename the database/volumes (data lives there) |
| `OPENAI_API_KEY` | no | Enables caption generation; without it the worker marks affected drafts `failed` with an actionable error instead of crashing |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | no | Caption generation through [OpenRouter](https://openrouter.ai) when `OPENAI_API_KEY` is unset (OpenAI wins if both are set). `OPENROUTER_MODEL` is required with the key and has no default: pick an id at openrouter.ai/models (ids ending in `:free` cost nothing but are rate limited, roughly 20 requests/minute and 50/day on a free account, and some providers log prompts, which contain reviewer quotes). The request asks the provider to turn reasoning off, because thinking models such as DeepSeek V4.1 Flash otherwise use the whole 400-token budget and return empty text. Weaker models fail the JSON/length checks more often; those drafts are marked `failed` and can be retried |
| `OPENAI_TIMEOUT_MS` | no | Caption provider timeout in milliseconds (default `20000`, applies to either provider); on timeout the draft is marked `failed` with an actionable error |
| `DRAFT_PIPELINE_INTERVAL_MS` | no | Worker sweep interval (default `60000`) |
| `APPLE_CLIENT_ID` | for Apple sign-in | Comma-separated audiences accepted from Apple identity tokens. The native app uses its bundle id `ca.visda.praiseloop`; a Services ID is added only when web Apple sign-in exists. Empty fails closed with 401 (see [auth.md](auth.md)) |
| `MICROSOFT_CLIENT_ID` | for Microsoft sign-in | Entra ID application (client) id, also the comma-separated audience list for phone ID tokens (the web sign-in uses the first id). The same id goes in the app's `EXPO_PUBLIC_MICROSOFT_CLIENT_ID`. Empty hides the web button and fails the phone exchange closed with 401 (see [auth.md](auth.md)) |
| `MICROSOFT_CLIENT_SECRET` | for web Microsoft sign-in | Client secret for the NextAuth `azure-ad` provider. The phone uses PKCE and never needs it. Never commit the value |
| `EXPO_ACCESS_TOKEN` | no | Expo push access token; only needed if enhanced push security is enabled on the Expo project |
| `EMAIL_TRANSPORT` | no | `fake` (default outside production) or `resend`. `fake` records to an in-memory outbox and logs an `email_outbox` line, and is refused in a production process |
| `EMAIL_FROM` | for real sends | Sender, for example `Praise Loop <no-reply@mail.example.com>`, on a domain verified in Resend. With the fake transport it defaults to `Praise Loop <no-reply@praiseloop.invalid>` |
| `RESEND_API_KEY` | for real sends | Resend API key, supplied only through runtime secret configuration. A missing key (or `EMAIL_FROM`) fails closed with a clear `email_unavailable` error; nothing crashes at startup |
| `MEDIA_ROOT` | no | Where rendered draft images are written/served (default `private-media`, the owner-protected `generated_media` volume mount in Compose; host upgrades must move existing images there as described in [auth.md](auth.md)) |
| `REDIS_URL` | no | Reserved for future queue work; unused by the current worker |

Postgres and Redis ports are bound to loopback (`127.0.0.1`) only — reachable
from the host, not exposed to the network.

### Email in development

Outside production `EMAIL_TRANSPORT` defaults to `fake`, so nothing is sent and no
key is needed. Each message is kept in the process's in-memory outbox and logged
once as `email_outbox {json}` with its recipient, subject and body; read a sign-in
code from that line (`docker compose logs -f web`, or the terminal running
`npm run dev`), or open `http://localhost:3000/dev/outbox`. That page exists only in a
development process using the fake transport. Tests also use the fake transport or a
mocked `fetch`, so they never reach the network; select `resend` explicitly outside
production only when trying a real send.

During email sign-in, request a code from the landing page or the phone sign-in screen
and read it at `/dev/outbox` or from the log line. The code expires after ten minutes
and can be used once; a newer request replaces it. The seeder's `dev-owner-email`
(`demo-email@praiseloop.invalid`) is an email-only owner, so signing in with that
address walks the returning-owner path and the empty account it lands on.

For a real send, complete the owner steps in [integrations.md](integrations.md) and
set `EMAIL_TRANSPORT=resend`, `EMAIL_FROM` (on the verified domain) and
`RESEND_API_KEY` in `.env`, then restart web. The key is a secret: keep it out of the
repository, logs and screenshots. Without the key or sender, email features fail
closed with `email_unavailable`; the app still starts and serves other routes.

## Database migrations

- `npm run db:migrate` — applies SQL files from `db/migrations` in filename order; applied files are recorded in `schema_migrations`
- A migration is identified by the name after its number. Renumbering a file that was already applied (for example when rebasing past another PR) records the new filename and skips the SQL instead of running it twice, so never reuse that name for different SQL.
- `npm run db:health` — connectivity check

## Tests, lint, typecheck, build

```bash
npm test          # pipeline + branding routes + caption decoding + media smoke + tooling regressions (synthetic, no external services)
npm run lint      # ESLint
npm run typecheck # tsc --noEmit
npm run build     # next build
```

### Opt-in live-provider verification

`npm test` never calls the paid provider. To verify caption decoding against
the real OpenAI Responses API (one paid call):

```bash
LIVE_PROVIDER_VERIFY=1 OPENAI_API_KEY=sk-... npm run test:live
```

Without `LIVE_PROVIDER_VERIFY=1` and `OPENAI_API_KEY` the script reports the
skip honestly and exits 0, so CI stays green without credentials.

## Worker

- `npm run worker` — draft generation loop (quote selection → captions → image render) every `DRAFT_PIPELINE_INTERVAL_MS`
- `npm run worker:schedule` — retired; fails closed pending verified provider setup

## Production deployment notes

- `docker compose up --build` is the production-style path: multi-stage builds, deterministic `npm ci`, healthchecks, bounded shutdown (`stop_grace_period`), shared media volume, loopback-only database/Redis ports.
- Prefer the published images for a server: every merge to master and every `v*` tag builds `ghcr.io/iamstevedavis/praise-loop-web` and `ghcr.io/iamstevedavis/praise-loop-worker` after CI passes. See [Published images](#published-images).
- Restart safety: database and generated media live in named volumes (`postgres_data`, `generated_media`); container restarts preserve them.
- Image delivery: the worker writes PNGs into the shared `generated_media` volume; the web container serves them via `GET /api/media/<filename>` (see `app/api/media/[name]/route.ts`). Browsers should always use the `/api/media/...` URL stored in `draft_posts.image_path` — never a bare `public/generated/...` path, because runtime-written files under `public/` are not guaranteed to be served by the Next production server.

## Pilot hosting

Runs the production stack on the home server, reachable over HTTPS through a
Cloudflare Tunnel with no inbound ports ([hosting plan](mobile-plan.md#hosting)).
`docker-compose.pilot.yml` adds `cloudflared` and unpublishes the web port, so
only the tunnel (an outbound connection) reaches `web`. Postgres and Redis stay
on loopback. Commands marked **owner** touch the real server and secrets, so the
owner runs them.

1. **Owner:** in Cloudflare Zero Trust, create a tunnel, add a public hostname
   (for example `praise.example.com`) with service `http://web:3000`, and copy
   the tunnel token.
2. **Owner:** on the server, `cp .env.example .env` and set strong
   `POSTGRES_PASSWORD`, `NEXTAUTH_SECRET`, Google and OpenAI keys,
   `CLOUDFLARE_TUNNEL_TOKEN`, and `NEXTAUTH_URL=https://praise.example.com`. The
   app's production `API_BASE_URL` is that same URL. Add
   `https://praise.example.com/api/auth/callback/google` as an authorized
   redirect URI on the Google OAuth client ([auth.md](auth.md)).
3. **Owner:** start it: `docker compose -f docker-compose.yml -f docker-compose.pilot.yml up -d --build`.
4. Verify from outside the home network (phone on mobile data):
   `curl -I https://praise.example.com/` works, and
   `nc -vz <home public IP> 3000 5432 6379` is refused.

### Backups and restore

`ops/backup.sh` writes a gzipped `pg_dump` and a tarball of the `generated_media`
volume, checks both, copies them off the machine with [rclone](https://rclone.org)
(`BACKUP_REMOTE`, for example Backblaze B2 or Google Drive), and deletes copies
older than `RETENTION_DAYS` (default 14). **Owner:** configure an rclone remote,
then cron it from the repo root:

```cron
30 3 * * * cd /srv/praise-loop && BACKUP_REMOTE=offsite:praise-loop HEALTHCHECK_PING_URL=<backup heartbeat URL> ops/backup.sh >> /var/log/praise-backup.log 2>&1
```

Restore (replaces the database and media) into a fresh or running stack:

```bash
rclone copy offsite:praise-loop/db-<stamp>.sql.gz . && rclone copy offsite:praise-loop/media-<stamp>.tar.gz .
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.pilot.yml" ops/restore.sh db-<stamp>.sql.gz media-<stamp>.tar.gz
```

Drill the restore after setup and after any change to the stack. The script was
drilled on a throwaway local stack: seed a business and a media file, back up,
`docker compose down -v`, restore into a new project, and both came back.

### Uptime alert

`ops/healthcheck.sh` requests `PUBLIC_URL/api/auth/providers` and pings
`HEALTHCHECK_PING_URL` only on success. Create two heartbeat checks in a free
Healthchecks.io account (one for this, one for the backup) that email or push
the owner when a ping is missing. Cron it every 5 minutes:
`*/5 * * * * PUBLIC_URL=https://praise.example.com HEALTHCHECK_PING_URL=... /srv/praise-loop/ops/healthcheck.sh`.
A power or internet outage stops the pings, which raises the alert.

### Published images

The `images` job in `.github/workflows/ci.yml` builds both images on every PR with
`push: false`, so a broken Dockerfile fails review. On master it pushes after
`verify` passes; version tags also get semver tags. Images are `linux/amd64` only
(see [decisions](decisions.md)).

```bash
# First run on a server with the repo checked out (pulls instead of building):
docker compose pull
docker compose up -d

# Pin the exact build that CI produced (short sha tag):
PRAISELOOP_TAG=sha-abc1234 docker compose pull
PRAISELOOP_TAG=sha-abc1234 docker compose up -d

# Roll back: pick an earlier sha- tag and repeat. Migrations are forward-only,
# so restore the matching database backup if the release included a migration.
PRAISELOOP_TAG=sha-def5678 docker compose up -d
```

`docker-compose.yml` keeps `build:` so local and dev builds still work; Compose
uses the `image:` when it is present. `migrate`, `web` and `worker` use the
published web/worker images (migrate runs the worker image).

GHCR packages are private by default. Log the server in once if pulls return
`denied`; use a token with `read:packages` (a classic PAT is simplest):

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
```

Making the packages public avoids that step, but only do it if images can never
contain secrets — configuration is supplied from the environment at runtime.
