import { pool } from "../lib/db";
import { errorFields, log, logLevel, logTick } from "../lib/log";
import { pushTick } from "../lib/services/push";
import { generationQueue, generationTick } from "../lib/services/generationQueue";
import { postingMode, postingTick } from "../lib/services/bufferPosting";
const { queue,worker } = generationQueue();
let active: Promise<void> | undefined, stopped = false;
// A tick is quiet (debug) when nothing happened and an info line when something did. A failure is
// always logged, with the error's name and code (its message too in development).
const step = <T extends Record<string, unknown>>(name: string, run: () => Promise<T>) =>
  run().then(result => { logTick(`${name}_tick`, result); }).catch(error => { log.error(`${name}_tick_failed`, errorFields(error)); });
function tick() {
  if (stopped || active) return;
  active = step("generation", () => generationTick(queue))
    .then(() => step("posting", () => postingTick()))
    .then(() => step("push", () => pushTick()))
    .finally(() => { active = undefined; });
}
const configured = Number(process.env.DRAFT_PIPELINE_INTERVAL_MS ?? 60000);
const interval = Number.isFinite(configured) ? Math.max(5000,configured) : 60000;
const timer = setInterval(tick,interval);
// What the worker was started with. Presence only: never a value, never a secret.
log.info("worker_started", {
  logLevel: logLevel(), appEnv: process.env.APP_ENV || "prod", intervalMs: interval,
  postingMode: postingMode(),
  bufferConfigured: !!(process.env.BUFFER_CLIENT_ID && process.env.BUFFER_CLIENT_SECRET && process.env.CREDENTIAL_ENCRYPTION_KEY),
  mediaBaseIsHttps: (process.env.NEXTAUTH_URL ?? "").startsWith("https://"),
  mailTransport: process.env.EMAIL_TRANSPORT || "default"
});
tick();
async function stop() {
  if (stopped) return; stopped=true; clearInterval(timer);
  await active; await worker.close(); await queue.close(); await pool.end();
}
process.on("SIGTERM",()=>{void stop();}); process.on("SIGINT",()=>{void stop();});
