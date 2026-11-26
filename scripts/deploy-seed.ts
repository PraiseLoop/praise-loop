import { pool } from "../lib/db";
import { runSeed } from "./seed/seed";

// Runs once per deploy as the dev stack's `seed` service (#300), after migrations.
// Without DEMO_SEED=1 it does nothing and exits 0, so the same image and compose file
// are safe on production. With it, the deploy guard in scripts/seed/guard.ts must pass
// (APP_ENV=dev, an allow-listed non-production host, the stack's own database and a
// strong DEMO_SEED_PASSWORD), or the service exits 1 and seeds nothing. The web and
// worker services do not wait for it, so a refused or failed seed never blocks a deploy.
async function main() {
  if (process.env.DEMO_SEED !== "1") {
    console.log(JSON.stringify({ event: "demo_seed_skipped", reason: "DEMO_SEED not set" }));
    return;
  }
  const summary = await runSeed(process.env, "deploy");
  console.log(JSON.stringify({
    event: "demo_seed_complete",
    owners: Object.keys(summary.owners).length,
    businesses: summary.businesses.map(business => ({ name: business.name, reviews: business.reviews }))
  }));
}

main().catch(error => {
  console.error(JSON.stringify({ event: "demo_seed_refused", error: error instanceof Error ? error.message : "Demo seed failed" }));
  process.exitCode = 1;
}).finally(() => pool.end());
