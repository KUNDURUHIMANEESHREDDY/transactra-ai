import test from "node:test";
import assert from "node:assert/strict";
import { completeNvidiaNim, NVIDIA_NIM_LIMITS } from "../infra/cloudflare/src/nvidia-nim.mjs";

const request = { input: "Verify the NVIDIA-only Transactra inference path.", systemPrompt: "Be concise.", maxOutputTokens: 64, estimatedCostInr: 0 };

function fakeDb({ quotaAvailable = true } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return { bind(...params) { return { async first() {
        calls.push({ sql, params });
        if (sql.includes("SELECT enabled FROM nvidia_runtime_control")) return { enabled: 1 };
        if (sql.includes("INSERT INTO inference_quota_daily")) return quotaAvailable ? { requests_reserved: 1, tokens_reserved: params[2] } : null;
        if (sql.includes("UPDATE inference_quota_daily")) return { requests_used: 1, tokens_used: 20 };
        return null;
      } }; } };
    }
  };
}
function verifiedEnv(DB) {
  return { TELEGRAM_OWNER_ID: "test-owner", NVIDIA_NIM_API_KEY: "test-nvidia-key", NVIDIA_NIM_MODEL: "stepfun-ai/step-5-preview", NVIDIA_NIM_FALLBACK_MODELS: "", NVIDIA_NIM_ZERO_COST_LIMIT_INR: "0", NVIDIA_NIM_FREE_TIER_VERIFIED_AT: new Date().toISOString(), NVIDIA_NIM_TIMEOUT_MS: "1000", DB };
}
function sseResponse(model, content, usage) {
  const chunks = [
    { model, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] },
    { model, choices: [], usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens } }
  ];
  const body = chunks.map(chunk => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("NVIDIA-only adapter sends one authenticated request and settles quota", async () => {
  const originalFetch = globalThis.fetch, calls = [], DB = fakeDb();
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return sseResponse("stepfun-ai/step-5-preview", "NVIDIA NIM response", { prompt_tokens: 12, completion_tokens: 8 });
  };
  try {
    const result = await completeNvidiaNim(verifiedEnv(DB), request);
    assert.equal(result.output, "NVIDIA NIM response");
    assert.equal(result.provider, "nvidia-nim");
    assert.equal(result.model, "stepfun-ai/step-5-preview");
    assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 8 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://integrate.api.nvidia.com/v1/chat/completions");
    assert.equal(calls[0].init.headers.authorization, "Bearer test-nvidia-key");
    assert.equal(calls[0].init.headers.accept, "text/event-stream");
    assert.equal(JSON.parse(calls[0].init.body).stream, true);
    assert.deepEqual(JSON.parse(calls[0].init.body).stream_options, { include_usage: true });
    assert.equal(DB.calls.length, 3);
    assert.match(DB.calls[0].sql, /SELECT enabled FROM nvidia_runtime_control/);
    assert.match(DB.calls[1].sql, /INSERT INTO inference_quota_daily/);
    assert.match(DB.calls[2].sql, /UPDATE inference_quota_daily/);
  } finally { globalThis.fetch = originalFetch; }
});

test("missing free-entitlement verification blocks before network access", async () => {
  const originalFetch = globalThis.fetch; let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error("must not be called"); };
  try {
    const env = verifiedEnv(fakeDb()); delete env.NVIDIA_NIM_FREE_TIER_VERIFIED_AT;
    await assert.rejects(completeNvidiaNim(env, request), /fresh NVIDIA Developer Program access verification is required/);
    assert.equal(fetchCalls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("quota exhaustion blocks before contacting NVIDIA", async () => {
  const originalFetch = globalThis.fetch; let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error("must not be called"); };
  try {
    await assert.rejects(completeNvidiaNim(verifiedEnv(fakeDb({ quotaAvailable: false })), request), /zero-cost quota is paused or unavailable/);
    assert.equal(fetchCalls, 0);
  } finally { globalThis.fetch = originalFetch; }
});


test("NVIDIA NIM retries one explicit HTTP 429 rejection on the same model", async () => {
  const originalFetch = globalThis.fetch, calls = [];
  globalThis.fetch = async (_url, init = {}) => {
    const model = JSON.parse(init.body).model;
    calls.push(model);
    if (calls.length === 1) return new Response("rate limited", { status: 429 });
    return sseResponse("stepfun-ai/step-5-preview", "retried response", { prompt_tokens: 9, completion_tokens: 6 });
  };
  try {
    const result = await completeNvidiaNim(verifiedEnv(fakeDb()), request);
    assert.equal(result.output, "retried response");
    assert.deepEqual(calls, ["stepfun-ai/step-5-preview", "stepfun-ai/step-5-preview"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("streamed completion without verified token usage keeps its reservation and is never replayed", async () => {
  const originalFetch = globalThis.fetch, calls = [], DB = fakeDb();
  globalThis.fetch = async (_url, init = {}) => {
    calls.push(init);
    const body = [
      "data: " + JSON.stringify({ model: "stepfun-ai/step-5-preview", choices: [{ delta: { content: "partial" } }] }),
      "data: [DONE]"
    ].join("\n\n") + "\n\n";
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    await assert.rejects(
      completeNvidiaNim(verifiedEnv(DB), request),
      /request failed or timed out; reservation retained and replay blocked/
    );
    assert.equal(calls.length, 1);
    assert.equal(DB.calls.filter(call => call.sql.includes("UPDATE inference_quota_daily")).length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("NVIDIA outage is not retried and never switches providers", async () => {
  const originalFetch = globalThis.fetch, calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return new Response("unavailable", { status: 503 }); };
  try {
    await assert.rejects(completeNvidiaNim(verifiedEnv(fakeDb()), request), /NVIDIA NIM inference failed with HTTP 503/);
    assert.deepEqual(calls, ["https://integrate.api.nvidia.com/v1/chat/completions"]);
  } finally { globalThis.fetch = originalFetch; }
});


test("NVIDIA NIM never switches models after an explicit model-not-found rejection", async () => {
  const originalFetch = globalThis.fetch, calls = [];
  globalThis.fetch = async (_url, init = {}) => {
    calls.push(JSON.parse(init.body).model);
    return new Response("model unavailable", { status: 404 });
  };
  try {
    await assert.rejects(
      completeNvidiaNim(verifiedEnv(fakeDb()), request),
      /Step 5 Preview endpoint rejected the request; no model or provider fallback was attempted/
    );
    assert.deepEqual(calls, ["stepfun-ai/step-5-preview"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("positive estimated cost is rejected before reservation or network access", async () => {
  const originalFetch = globalThis.fetch, DB = fakeDb(); let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error("must not be called"); };
  try {
    await assert.rejects(completeNvidiaNim(verifiedEnv(DB), { ...request, estimatedCostInr: 0.01 }), /estimated cost must be exactly INR 0/);
    assert.equal(fetchCalls, 0); assert.equal(DB.calls.length, 1);
    assert.match(DB.calls[0].sql, /SELECT enabled FROM nvidia_runtime_control/);
  } finally { globalThis.fetch = originalFetch; }
});

test("NVIDIA limits remain bounded", () => {
  assert.equal(NVIDIA_NIM_LIMITS.maxRequestsPerDay, Number.MAX_SAFE_INTEGER);
  assert.equal(NVIDIA_NIM_LIMITS.maxTokensPerDay, Number.MAX_SAFE_INTEGER);
  assert.equal(NVIDIA_NIM_LIMITS.maxInputBytes, 8000);
  assert.equal(NVIDIA_NIM_LIMITS.maxOutputTokens, 1000);
  assert.equal(NVIDIA_NIM_LIMITS.maxTimeoutMs, 120000);
});
