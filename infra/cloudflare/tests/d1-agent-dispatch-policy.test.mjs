import test from "node:test";
import assert from "node:assert/strict";
import { hasAcceptedStepEvidence, processD1NativeApprovedJobs } from "../src/d1-agent-dispatch.mjs";

function enabledEnv(ownerId) {
  return {
    TELEGRAM_OWNER_ID: ownerId,
    TRANSACTRA_AGENT_EXECUTION_ENABLED: "true",
    NVIDIA_NIM_EXECUTION_ENABLED: "true",
    NVIDIA_NIM_FREE_TIER_VERIFIED_AT: new Date().toISOString(),
    NVIDIA_NIM_ZERO_COST_LIMIT_INR: "0",
    NVIDIA_NIM_API_KEY: "test-key",
    NVIDIA_NIM_MODEL: "stepfun-ai/step-5-preview",
    CLOUDPILOT_INFERENCE_SECRET: "x".repeat(40),
  };
}

test("dispatcher fails closed when owner identity is unavailable", async () => {
  let calls = 0;
  const env = enabledEnv("");
  env.DB = { prepare() { calls++; throw new Error("must not query without owner identity"); } };
  const result = await processD1NativeApprovedJobs(env, Date.now(), new Date().toISOString());
  assert.deepEqual(result, { dispatched: 0, reason: "owner_identity_unavailable" });
  assert.equal(calls, 0);
});

test("dispatcher query is scoped to the configured owner and executable task lifecycle", async () => {
  let query = "";
  let bindings = [];
  const env = enabledEnv("owner-123");
  env.DB = {
    prepare(sql) {
      query = sql;
      return {
        bind(...values) {
          bindings = values;
          return { async all() { return { results: [] }; } };
        },
      };
    },
  };
  const now = new Date().toISOString();
  const result = await processD1NativeApprovedJobs(env, Date.now(), now);
  assert.deepEqual(result, { dispatched: 0 });
  assert.match(query, /a\.status='approved' AND a\.owner_id=\?/);
  assert.match(query, /p\.status='approved'/);
  assert.match(query, /t\.status IN \('awaiting_provider','running'\)/);
  assert.deepEqual(bindings, ["owner-123", now]);
});

test("dispatcher performs no D1 reads while execution flags are disabled", async () => {
  let calls = 0;
  const env = {
    TELEGRAM_OWNER_ID: "owner-123",
    TRANSACTRA_AGENT_EXECUTION_ENABLED: "false",
    NVIDIA_NIM_EXECUTION_ENABLED: "false",
    DB: { prepare() { calls++; throw new Error("must not query while locked"); } },
  };
  const result = await processD1NativeApprovedJobs(env, Date.now(), new Date().toISOString());
  assert.equal(result.dispatched, 0);
  assert.equal(result.reason, "agent_execution_disabled");
  assert.equal(calls, 0);
});

test("completion requires non-empty result plus persisted accepted evaluator evidence", () => {
  assert.equal(hasAcceptedStepEvidence([{
    status: "succeeded",
    result_text: "A verified adapter artifact",
    evaluation_json: JSON.stringify({ decision: "accepted", accepted: true, rationale: "Acceptance criteria directly verified." }),
  }]), true);
  assert.equal(hasAcceptedStepEvidence([{
    status: "succeeded",
    result_text: "The model said the task is complete.",
    evaluation_json: null,
  }]), false, "a successful model response is not accepted evidence");
  assert.equal(hasAcceptedStepEvidence([{
    status: "succeeded",
    result_text: "Output exists",
    evaluation_json: JSON.stringify({ decision: "retry", accepted: false, rationale: "Evidence is incomplete." }),
  }]), false, "a non-accepted evaluator decision cannot complete a step");
  assert.equal(hasAcceptedStepEvidence([{
    status: "succeeded",
    result_text: "Output exists",
    evaluation_json: JSON.stringify({ decision: "accepted", accepted: true, rationale: " " }),
  }]), false, "an empty evaluator rationale is not auditable evidence");
  assert.equal(hasAcceptedStepEvidence([{
    status: "needs_review",
    result_text: "Verified",
    evaluation_json: JSON.stringify({ decision: "accepted", accepted: true, rationale: "Accepted." }),
  }]), false, "the step ledger must also be in succeeded state");
  assert.equal(hasAcceptedStepEvidence([]), false);
});
