import { pool } from "../lib/db";
import { runSeed } from "./seed/seed";

// Synthetic data for walking the phone flow end to end without OpenAI, Google
// OAuth or a review provider: businesses with imported reviews and drafts in
// every status, Pro, Business, Free and email-only owners, a push token and a
// Google connection stub.
// Refuses to run against a production process or a non-local DATABASE_URL, and
// replaces only the four demo owners' rows, so no real owner's data is touched.
// The data lives in scripts/seed/fixtures.ts and sample-data/csv/.
async function main() {
  // `docker compose exec` inherits only the container environment (the Compose
  // files pass variables explicitly), and Next's .env loading does not apply to a
  // standalone script. Fall back to .env so a flag placed there also works when
  // the seed runs on the host.
  if (!process.env.MOBILE_DEV_AUTH) {
    try {
      process.loadEnvFile();
    } catch {
      // No .env beside the working directory; the exported environment decides.
    }
  }

  const summary = await runSeed();
  console.log(JSON.stringify({ event: "demo_seed_complete", ...summary }));
  console.log("Sign in on the phone with the demo button (MOBILE_DEV_AUTH=1, development process).");
  console.log('Free owner: curl -X POST -H "Content-Type: application/json" -d \'{"owner":"free"}\' http://localhost:3000/api/mobile/session/dev');
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "Demo seed failed");
  process.exitCode = 1;
}).finally(() => pool.end());
