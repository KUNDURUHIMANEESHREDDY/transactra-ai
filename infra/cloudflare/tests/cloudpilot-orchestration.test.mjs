import test from "node:test";
import assert from "node:assert/strict";
import { createOrchestratorPlan } from "../src/orchestrator.mjs";
import { completeCloudPilot, isCloudPilotConfigured } from "../src/cloudpilot.mjs";

const cloudPilotEnv = {
  NVIDIA_NIM_FREE_TIER_VERIFIED_AT: new Date().toISOString(),
  NVIDIA_NIM_MODEL: "stepfun-ai/step-5-preview",
  CLOUDPILOT_INFERENCE_URL: "https://cloudpilot-edge.himaneeshreddyk.workers.dev/chat/completions",
  CLOUDPILOT_INFERENCE_SECRET: "x".repeat(40),
};

test("CloudPilot configuration is allowlisted and requires a strong shared secret", () => {
  assert.equal(isCloudPilotConfigured(cloudPilotEnv), true);
  assert.equal(isCloudPilotConfigured({ ...cloudPilotEnv, CLOUDPILOT_INFERENCE_SECRET: "short" }), false);
  assert.equal(isCloudPilotConfigured({ ...cloudPilotEnv, CLOUDPILOT_INFERENCE_URL: "https://attacker.example/chat/completions" }), false);
});

test("CloudPilot refuses non-zero cost estimates before making a network request", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected request"); };
  try {
    await assert.rejects(
      completeCloudPilot(cloudPilotEnv, { input: "plan", maxOutputTokens: 20, estimatedCostInr: 1 }),
      /exact INR 0 cost estimate/
    );
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("general task planning uses CloudPilot and remains a proposal until approved", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let requestBody;
  globalThis.fetch = async (url, options) => {
    requestUrl = String(url);
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      model: "stepfun-ai/step-5-preview",
      choices: [{ message: { content: JSON.stringify({
        title: "Research and report",
        objective: "Research AI agents and prepare a report",
        steps: [{
          agent: "researcher",
          tool: "web_research",
          tool_input: { query: "AI agent orchestration systems" },
          description: "Research current agent orchestration systems",
          acceptance_criteria: "Return sourced findings",
          risk: "low",
          depends_on: []
        }]
      }) } }],
      usage: { prompt_tokens: 120, completion_tokens: 80 }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const plan = await createOrchestratorPlan({
      ...cloudPilotEnv,
      TRANSACTRA_MODEL_ORCHESTRATOR_ENABLED: "true",
      NVIDIA_NIM_PLANNING_ENABLED: "true",
    }, {}, "Research AI agent orchestration systems and prepare a report");
    assert.equal(plan.mode, "model_proposed");
    assert.equal(plan.steps[0].agent, "researcher");
    assert.equal(plan.steps[0].tool, "web_research");
    assert.equal(plan.execution.enabled, false);
    assert.equal(requestUrl, cloudPilotEnv.CLOUDPILOT_INFERENCE_URL);
    assert.equal(requestBody.model, "stepfun-ai/step-5-preview");
    assert.equal(requestBody.max_tokens, 512);
  } finally { globalThis.fetch = originalFetch; }
});
