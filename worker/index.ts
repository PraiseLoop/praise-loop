import { pool } from "../lib/db";
import { pushTick } from "../lib/services/push";
import { generationQueue, generationTick } from "../lib/services/generationQueue";
import { postingTick } from "../lib/services/bufferPosting";
const { queue,worker } = generationQueue();
let active: Promise<void> | undefined, stopped = false;
function tick() {
  if (stopped || active) return;
  active = generationTick(queue).then(result=>{console.log(JSON.stringify({event:"generation_tick",...result}));})
    .catch(()=>console.error("generation_tick_failed"))
    .then(()=>postingTick()).then(result=>{console.log(JSON.stringify({event:"posting_tick",...result}));}).catch(()=>console.error("posting_tick_failed"))
    .then(()=>pushTick()).then(result=>{console.log(JSON.stringify({event:"push_tick",...result}));}).catch(()=>console.error("push_tick_failed")).finally(()=>{active=undefined;});
}
const configured = Number(process.env.DRAFT_PIPELINE_INTERVAL_MS ?? 60000);
const timer = setInterval(tick,Number.isFinite(configured) ? Math.max(5000,configured) : 60000);
tick();
async function stop() {
  if (stopped) return; stopped=true; clearInterval(timer);
  await active; await worker.close(); await queue.close(); await pool.end();
}
process.on("SIGTERM",()=>{void stop();}); process.on("SIGINT",()=>{void stop();});
