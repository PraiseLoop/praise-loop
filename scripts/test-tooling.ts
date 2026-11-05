import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Regression coverage for the issue-48 tooling baseline: real lint, declared
// sharp, pinned Node baseline, documented env URLs, and a production web
// image that never quietly runs `next dev`.
const root = process.cwd();

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

const pkg = JSON.parse(read("package.json")) as {
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  engines?: { node?: string };
};

assert.equal(pkg.scripts.lint, "eslint .", "lint must run ESLint, not a placeholder");
assert.ok(pkg.scripts.worker, "worker execution must be a first-class npm script");
assert.ok(pkg.dependencies?.sharp, "sharp must be a declared runtime dependency");
assert.ok(pkg.engines?.node, "engines.node must declare the Node baseline");

const nodeMajor = /\d+/.exec(pkg.engines.node)?.[0] ?? "";
assert.equal(read(".nvmrc").trim(), nodeMajor, ".nvmrc must match engines.node major");

const envExample = read(".env.example");
assert.match(envExample, /@localhost:5432/, ".env.example must document the host DATABASE_URL");
assert.match(envExample, /@postgres:5432/, ".env.example must document the container DATABASE_URL");

assert.doesNotMatch(
  read("Dockerfile.web"),
  /CMD \["npm", "run", "dev"\]/,
  "production web image must not run next dev"
);



for (const file of ["docker-compose.yml", "docker-compose.dev.yml"]) {
  assert.match(read(file), /REDIS_URL=redis:\/\/redis:6379/, "Compose must override host Redis URL with its service hostname");
  assert.doesNotMatch(read(file), /REDIS_URL=\$\{REDIS_URL/, "host .env must not redirect the worker to localhost");
}

// Pilot hosting (#90): the overlay must hide web and take the tunnel token
// from the environment, and the ops scripts must exist and stay secret-free.
const pilot = read("docker-compose.pilot.yml");
assert.match(pilot, /ports: !reset \[\]/, "pilot overlay must unpublish the web port");
assert.match(pilot, /TUNNEL_TOKEN=\$\{CLOUDFLARE_TUNNEL_TOKEN:\?/, "tunnel token must come from .env, required");
assert.doesNotMatch(pilot, /eyJ[A-Za-z0-9]{20,}/, "no tunnel token in the repo");
assert.match(read(".env.example"), /^CLOUDFLARE_TUNNEL_TOKEN=$/m, "token must be blank in .env.example");

// The standalone file is the same stack as docker-compose.yml + docker-compose.pilot.yml for tools that take one
// file (Dockhand, Portainer). It must run published images only, publish no host ports, and not fall behind: every
// variable the two real files pass to a service must also be passed here.
const standalone = read("docker-compose.standalone.yml");
const serviceBlock = (text: string, name: string): string => {
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `compose file must define the ${name} service`);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n(?: {2}[a-z_-]+:|[a-z]+:)\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};
const envNames = (block: string): string[] => [...block.matchAll(/^ {6}- ([A-Z0-9_]+)=/gm)].map((m) => m[1]);
assert.doesNotMatch(standalone, /^\s+build:/m, "the standalone stack must use published images, not build from a checkout");
assert.doesNotMatch(standalone, /^\s+ports:/m, "the standalone stack must not publish host ports");
// The tunnel is infrastructure, not part of the app stack: it runs as its own stack and reaches web over the
// shared external `edge` network under a fixed alias.
assert.doesNotMatch(standalone, /^ {2}cloudflared:/m, "the standalone stack must not run cloudflared; the tunnel is a separate stack");
assert.doesNotMatch(standalone, /TUNNEL_TOKEN/, "the standalone stack takes no tunnel token");
assert.match(standalone, /^networks:\n {2}# [^\n]*\n {2}edge:\n {4}name: \$\{EDGE_NETWORK:-edge\}\n {4}external: true/m, "web must be reachable over the shared external edge network");
assert.match(serviceBlock(standalone, "web"), /networks:\n {6}default: \{\}\n {6}edge:\n {8}aliases: \["praiseloop-web"\]/, "web joins the stack network and the edge network as praiseloop-web");
assert.doesNotMatch(serviceBlock(standalone, "postgres") + serviceBlock(standalone, "redis") + serviceBlock(standalone, "worker"), /edge/, "only web is exposed on the edge network");
assert.match(standalone, /POSTGRES_PASSWORD:\?/, "the database password must be required, not defaulted");
assert.match(standalone, /NEXTAUTH_SECRET:\?/, "the session secret must be required, not defaulted");
assert.match(standalone, /TRUST_PROXY_HEADERS=1/, "only the tunnel's cloudflared is on the edge network, so proxy headers are trusted");
assert.doesNotMatch(standalone, /eyJ[A-Za-z0-9]{20,}/, "no tunnel token in the repo");
const baseCompose = read("docker-compose.yml");
for (const service of ["migrate", "web", "worker", "postgres"]) {
  const have = new Set(envNames(serviceBlock(standalone, service)));
  for (const name of envNames(serviceBlock(baseCompose, service))) {
    assert.ok(have.has(name), `docker-compose.standalone.yml ${service} is missing ${name}, which docker-compose.yml passes`);
  }
}
// Container logs rotate (3 files of 10 MB per service) so they cannot fill the disk and old lines are deleted
// automatically; the published privacy policy states this. Every service in the production-style stacks needs it.
const servicesIn = (text: string): string[] => {
  const start = text.indexOf("\nservices:");
  const ends = ["\nnetworks:", "\nvolumes:"].map((marker) => text.indexOf(marker, start)).filter((index) => index > start);
  const body = text.slice(start, ends.length ? Math.min(...ends) : undefined);
  return [...body.matchAll(/^ {2}([a-z_-]+):$/gm)].map((m) => m[1]);
};
for (const file of ["docker-compose.yml", "docker-compose.standalone.yml"]) {
  const text = read(file);
  assert.match(text, /x-logging: &logging\n {2}driver: json-file\n {2}options:\n {4}max-size: "10m"\n {4}max-file: "3"/, `${file} must define bounded log rotation`);
  for (const name of servicesIn(text)) {
    assert.match(serviceBlock(text, name), /^ {4}logging: \*logging$/m, `${file}: service ${name} must use the rotated log settings`);
  }
}
assert.match(serviceBlock(read("docker-compose.pilot.yml"), "cloudflared"), /max-size: "10m"[\s\S]*max-file: "3"/, "the pilot overlay's cloudflared must rotate logs too");
for (const f of ["backup.sh", "restore.sh", "healthcheck.sh"]) {
  assert.match(read(`ops/${f}`), /^#!\/usr\/bin\/env bash\nset -euo pipefail|^#!\/usr\/bin\/env bash\n(#.*\n)+set -euo pipefail/, `${f} must fail fast`);
}
for (const f of ["backup.sh", "restore.sh"]) {
  assert.doesNotMatch(read(`ops/${f}`), /gzip -t[^\n]*&&/, `${f} must validate archives as separate commands: set -e ignores the left side of &&`);
}
assert.match(read("ops/restore.sh"), /up -d --wait postgres/, "restore must wait for Postgres to be healthy");

// Next 16 renamed the middleware convention to proxy; the old name only logs a deprecation warning and
// may stop working. The proxy still must hide legacy public/generated files (the HTTP check in
// test-auth-http.ts covers the running server).
assert.ok(existsSync(join(root, "proxy.ts")), "the generated-assets guard must live in proxy.ts");
assert.ok(!existsSync(join(root, "middleware.ts")), "middleware.ts is the deprecated name; use proxy.ts");
const proxyModule = require("../proxy") as { proxy: () => Response; config: { matcher: string[] } };
assert.deepEqual(proxyModule.config.matcher, ["/generated/:path*"], "the proxy must only match legacy generated paths");
assert.equal(proxyModule.proxy().status, 404, "legacy public/generated files must never be served");
// The dev stack starts the Expo server for the phone app (docker-compose.dev.yml `mobile` service). It needs the
// host network to detect the LAN address, a terminal so Expo prints its QR code, and no CI mode (which disables
// reloads); the entrypoint must exist and wire the packager hostname and API URL from that address.
const devCompose = read("docker-compose.dev.yml");
const mobileService = devCompose.slice(devCompose.indexOf("\n  mobile:\n"));
assert.ok(mobileService.length > 20, "docker-compose.dev.yml must define a mobile service");
assert.match(mobileService, /network_mode: host/, "mobile must use the host network to find the LAN address");
assert.match(mobileService, /tty: true/, "mobile needs a terminal so Expo prints its QR code");
assert.doesNotMatch(mobileService, /CI=/, "CI mode disables reloads in the Expo dev server");
assert.match(mobileService, /\.:\/app:z/, "mobile must mount the source with the SELinux relabel");
const mobileEntry = read("mobile/dev-container.sh");
assert.match(mobileEntry, /REACT_NATIVE_PACKAGER_HOSTNAME/, "the packager hostname must be the LAN address");
assert.match(mobileEntry, /EXPO_PUBLIC_API_BASE_URL/, "the app must be pointed at the LAN address");
assert.match(mobileEntry, /^set -eu$/m, "the entrypoint must fail fast");
assert.match(read("mobile/tsconfig.json"), /\.expo\/types/, "Expo adds this include on start; keep it committed so it does not rewrite the file");
// The Stripe CLI forwarder is its own test-mode stack on the shared edge network, like the tunnel.
const stripeListen = read("docker-compose.stripe-listen.yml");
assert.match(stripeListen, /image: stripe\/stripe-cli:v\d+\.\d+\.\d+\n/, "the Stripe CLI image must be pinned to a version");
assert.match(stripeListen, /STRIPE_API_KEY=\$\{STRIPE_SECRET_KEY:\?/, "the key must be required and reach the CLI through its environment, not the command line");
assert.doesNotMatch(stripeListen, /--api-key|^\s+(build|ports):/m, "the forwarder takes no key argument, build or published port");
assert.match(stripeListen, /http:\/\/praiseloop-web:3000\/api\/billing\/webhook/, "events go to web over the edge alias");
assert.match(stripeListen, /name: \$\{EDGE_NETWORK:-edge\}\n {4}external: true/, "it joins the shared external edge network");
assert.doesNotMatch(stripeListen, /sk_(live|test)_[A-Za-z0-9]{8,}/, "no Stripe key in the repo");
console.log("tooling regression tests passed");
