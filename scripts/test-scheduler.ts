import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { StubSchedulerAdapter } from "../lib/integrations/scheduler";
async function main(){
  const payload={draftPostId:1,businessId:1,captionText:"SYNTHETIC_PRIVATE_CAPTION",mediaUrl:"https://media.example/api/public-media/x.png"};
  const fake=await new StubSchedulerAdapter().submitPost(payload);
  assert.deepEqual([fake.provider,fake.status],["fake","draft"],"the fake never reports a sent post");
  assert.equal((await new StubSchedulerAdapter().getPostStatus()).status,"draft");
  const result=spawnSync(process.execPath,["-r","ts-node/register","scripts/schedule-worker.ts"],{encoding:"utf8",env:{...process.env,DATABASE_URL:"postgres://invalid.invalid/must-not-connect"}});
  assert.equal(result.status,1);assert.doesNotMatch(result.stdout+result.stderr,/SYNTHETIC_PRIVATE|scheduledCount|scheduler\.stub/);
  console.log("fake receipts/retired CLI fail-closed tests passed");
}
main().catch(err=>{console.error(err);process.exitCode=1;});
