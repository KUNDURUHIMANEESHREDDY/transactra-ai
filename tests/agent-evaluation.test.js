import test from "node:test";
import assert from "node:assert/strict";
import { summarizeAgentPerformance } from "../dist/packages/agents/src/evaluation.js";

test("agent performance reports success rate and confidence from finalized steps", () => {
  const [summary] = summarizeAgentPerformance([{
    agent_id:"software-engineer",
    finalized_steps:"10",
    completed_steps:"8",
    failed_steps:"2",
    approval_waits:"3",
    open_attempts:"1",
    avg_latency_ms:"1250.5"
  }]);
  assert.equal(summary.agentId,"software-engineer");
  assert.equal(summary.sampleSize,10);
  assert.equal(summary.successRate,80);
  assert.equal(summary.confidence,"medium");
  assert.equal(summary.approvalWaits,3);
  assert.equal(summary.openAttempts,1);
  assert.equal(summary.averageSuccessfulLatencyMs,1250.5);
});

test("agent performance with no finalized steps has no success score", () => {
  const [summary] = summarizeAgentPerformance([{
    agent_id:"product-researcher",
    finalized_steps:"0",
    completed_steps:"0",
    failed_steps:"0",
    approval_waits:"2",
    open_attempts:"1",
    avg_latency_ms:null
  }]);
  assert.equal(summary.successRate,null);
  assert.equal(summary.confidence,"low");
  assert.equal(summary.averageSuccessfulLatencyMs,null);
});

test("agent performance rejects inconsistent counts", () => {
  assert.throws(() => summarizeAgentPerformance([{
    agent_id:"bad-agent",
    finalized_steps:"5",
    completed_steps:"4",
    failed_steps:"0",
    approval_waits:"0",
    open_attempts:"0",
    avg_latency_ms:null
  }]),/do not reconcile/);
});
