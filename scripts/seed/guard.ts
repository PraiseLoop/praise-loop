import { devAuthEnabled, DEV_OWNER_PASSWORD } from "../../lib/devAuth";
import { passwordProblem } from "../../lib/passwordAuth";

// Hosts a development database can have: the host machine, or the Compose service
// name that the web, worker and migrate containers use. Anything else (a managed
// database, a VPS, another machine on the LAN) is refused, even if it is empty.
const LOCAL_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "postgres"]);

// Public hosts that are production. The deploy seed refuses them even when
// DEMO_SEED_HOSTS lists them, so a copied environment cannot reset real owners' app.
const PRODUCTION_HOSTS = new Set(["praiseloop.ca", "www.praiseloop.ca", "app.praiseloop.ca"]);

function assertLocalDatabase(env: Record<string, string | undefined>): void {
  const raw = env.DATABASE_URL;
  if (!raw) throw new Error("Refusing to seed: DATABASE_URL is not set");
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    throw new Error("Refusing to seed: DATABASE_URL is not a valid URL");
  }
  // An empty host is a local Unix socket (postgres:///db).
  if (host && !LOCAL_DATABASE_HOSTS.has(host)) {
    throw new Error(`Refusing to seed: DATABASE_URL points at ${host}, which is not a local development database`);
  }
}

export function assertSeedable(env: Record<string, string | undefined> = process.env): void {
  if (!devAuthEnabled(env)) {
    throw new Error("Refusing to seed: set MOBILE_DEV_AUTH=1 and run in a development process (not a production build)");
  }
  assertLocalDatabase(env);
}

// The deploy-time seed (#300) runs inside the dev stack's production-built images, so
// NODE_ENV is "production" and the local-process rule above cannot apply. Instead every
// one of these must hold: the explicit flag, APP_ENV=dev, a public URL whose host is
// listed in DEMO_SEED_HOSTS and is not a production host, the stack's own database,
// and a strong password from the environment that is not the one documented in the repo.
// Returns that password. Callers check DEMO_SEED first and skip quietly when it is unset.
export function assertDeploySeedable(env: Record<string, string | undefined> = process.env): string {
  if (env.DEMO_SEED !== "1") throw new Error("Refusing to seed: DEMO_SEED is not 1");
  if ((env.APP_ENV ?? "").trim().toLowerCase() !== "dev") {
    throw new Error("Refusing to seed: APP_ENV must be dev");
  }
  let host: string;
  try {
    host = new URL(env.NEXTAUTH_URL ?? "").hostname.toLowerCase();
  } catch {
    throw new Error("Refusing to seed: NEXTAUTH_URL is not a valid URL");
  }
  if (PRODUCTION_HOSTS.has(host)) throw new Error(`Refusing to seed: ${host} is a production host`);
  const allowed = new Set((env.DEMO_SEED_HOSTS ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean));
  if (!allowed.has(host)) throw new Error(`Refusing to seed: ${host} is not listed in DEMO_SEED_HOSTS`);
  assertLocalDatabase(env);
  const password = env.DEMO_SEED_PASSWORD ?? "";
  if (password === DEV_OWNER_PASSWORD) {
    throw new Error("Refusing to seed: DEMO_SEED_PASSWORD must not be the demo password documented in the repo");
  }
  if (passwordProblem(password)) throw new Error("Refusing to seed: DEMO_SEED_PASSWORD does not meet the password rules");
  return password;
}
