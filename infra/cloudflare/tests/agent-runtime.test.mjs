import test from "node:test";
import assert from "node:assert/strict";
import { runAgentWorker, isAgentExecutionEnabled } from "../src/agent-runtime.mjs";

function streamedNimResponse(content, promptTokens = 12, completionTokens = 5) {
  const model = "stepfun-ai/step-5-preview";
  const chunks = [
    { model, choices: [{ delta: { role: "assistant", content } }] },
    { model, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } }
  ];
  return new Response(JSON.stringify({ model, choices: [{ message: { content } }], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } }), { status: 200, headers: { "content-type": "application/json" } });
}

function nimEnv() {
  return {
    TRANSACTRA_AGENT_EXECUTION_ENABLED: "true",
    NVIDIA_NIM_EXECUTION_ENABLED: "true",
    NVIDIA_NIM_FREE_TIER_VERIFIED_AT: new Date().toISOString(),
    NVIDIA_NIM_ZERO_COST_LIMIT_INR: "0",
    NVIDIA_NIM_API_KEY: "test-key",
    NVIDIA_NIM_MODEL: "stepfun-ai/step-5-preview",
    CLOUDPILOT_INFERENCE_URL: "https://cloudpilot-edge.himaneeshreddyk.workers.dev/chat/completions",
    CLOUDPILOT_INFERENCE_SECRET: "x".repeat(40),
    TELEGRAM_OWNER_ID: "12345",
    DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes("SELECT enabled FROM nvidia_runtime_control")) return { enabled: 1 };
                return sql.includes("INSERT INTO inference_quota_daily")
                  ? { quota_date: "2026-11-10", requests_reserved: 1, tokens_reserved: 100 }
                  : { requests_used: 1, tokens_used: 28 };
              },
            };
          },
        };
      },
    },
  };
}

test("agent execution remains locked unless explicit flags, current entitlement, key and model are present", () => {
  assert.equal(isAgentExecutionEnabled({}), false);
  assert.equal(isAgentExecutionEnabled({
    TRANSACTRA_AGENT_EXECUTION_ENABLED: "true",
    NVIDIA_NIM_EXECUTION_ENABLED: "true",
    NVIDIA_NIM_FREE_TIER_VERIFIED_AT: new Date().toISOString(),
  }), false);
  const missingCloudPilot = nimEnv();
  delete missingCloudPilot.CLOUDPILOT_INFERENCE_SECRET;
  assert.equal(isAgentExecutionEnabled(missingCloudPilot), false);
  assert.equal(isAgentExecutionEnabled(nimEnv()), true);
});

test("side-effect tools are blocked without a separate owner approval", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected network request"); };
  try {
    const result = await runAgentWorker(nimEnv(), {
      id: "step-1", agent: "builder", tool: "repository_write",
      description: "edit a file", acceptance_criteria: "file is updated",
      risk: "high",
      tool_input: { path: "packages/example.ts", content: "export const x = 1;", message: "Update example", expected_sha: null },
    }, { objective: "test" });
    assert.equal(result.status, "blocked");
    assert.match(result.error, /separate owner approval/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("tool=none agent fails closed when execution gate is disabled", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected network request"); };
  try {
    const result = await runAgentWorker({}, {
      id: "step-1", agent: "analyst", tool: "none",
      description: "analyze", acceptance_criteria: "evidence", risk: "medium", tool_input: {},
    }, { objective: "test" });
    assert.equal(result.status, "blocked");
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("data_analysis adapter is deterministic, bounded and read-only", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return streamedNimResponse("Evidence summary: one prior result.", 20, 8);
  };
  try {
    const result = await runAgentWorker(nimEnv(), {
      id: "step-2", agent: "analyst", tool: "data_analysis",
      description: "Analyze prior evidence", acceptance_criteria: "Report evidence counts",
      risk: "medium", tool_input: {},
    }, {
      objective: "Summarize evidence",
      priorResults: [{ step_id: "step-1", result_text: "Verified test output" }],
    });
    assert.equal(result.status, "completed");
    const userMessage = requestBody.messages.find((message) => message.role === "user").content;
    const input = JSON.parse(userMessage);
    assert.equal(input.adapter_result.tool, "data_analysis");
    assert.equal(input.adapter_result.status, "completed");
    const evidence = JSON.parse(input.adapter_result.output);
    assert.equal(evidence.evidence_items, 1);
    assert.equal(evidence.non_empty_results, 1);
    assert.deepEqual(evidence.completed_step_ids, ["step-1"]);
    assert.match(evidence.limitation, /no external data source was accessed/);
  } finally { globalThis.fetch = originalFetch; }
});

test("all agent workers remain blocked before adapter execution when inference is disabled", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected network request"); };
  try {
    const cases = [
      { tool: "web_research", tool_input: { query: "Transactra autonomous agents" } },
      { tool: "repository_read", tool_input: { path: "README.md" } },
      { tool: "repository_write", risk: "high", tool_input: { path: "packages/example.ts", content: "export const x=1;", message: "Add example" } },
      { tool: "cloudflare_staging", risk: "high", tool_input: { environment: "staging" } },
      { tool: "telegram_notify", risk: "high", tool_input: { message: "Owner update" } },
    ];
    for (const item of cases) {
      const result = await runAgentWorker({}, {
        id: "step-1", agent: "operator", tool: item.tool, description: "test",
        acceptance_criteria: "test result", risk: item.risk || "low", tool_input: item.tool_input,
      }, { objective: "test" });
      assert.equal(result.status, "blocked", item.tool);
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});
