import test from "node:test";
import assert from "node:assert/strict";
import { processD1NativeApprovedJobs } from "../src/d1-agent-dispatch.mjs";

test("scheduled dispatcher performs no D1 reads or inference while execution is disabled", async () => {
  let calls=0;
  const env={TELEGRAM_OWNER_ID:"owner-123",DB:{prepare(){calls++;throw new Error("must not query while locked");}}};
  const result=await processD1NativeApprovedJobs(env,Date.now(),new Date().toISOString());
  assert.equal(result.dispatched,0);
  assert.equal(result.reason,"agent_execution_disabled");
  assert.equal(calls,0);
});
