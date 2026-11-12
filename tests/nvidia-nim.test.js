import test from "node:test";
import assert from "node:assert/strict";
import { NvidiaNimProvider } from "../dist/packages/providers/src/nvidia-nim.js";

const config = {
  apiKey: "test-nim-key",
  model: "nvidia/test-model",
  baseUrl: "https://nim.test",
  freeTierVerifiedAt: new Date().toISOString(),
  timeoutMs: 1000
};
const request = {
  input: "Explain a database index briefly.",
  systemPrompt: "Be concise.",
  maxOutputTokens: 64,
  estimatedCostInr: 0
};
const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { "content-type": "application/json" }
});
function quota() {
  const reservations = [];
  return { reservations, reserve: async (tokens) => { reservations.push(tokens); } };
}

test("NVIDIA NIM discovers the configured model and performs authenticated inference", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/v1/models")) {
      return json({ data: [{ id: "nvidia/test-model" }] });
    }
    return json({
      choices: [{ message: { content: "An index speeds up data lookup." } }],
      usage: { prompt_tokens: 12, completion_tokens: 9 }
    });
  };
  const q = quota();
  try {
    const provider = new NvidiaNimProvider(config, q);
    const result = await provider.complete(request);
    assert.equal(result.output, "An index speeds up data lookup.");
    assert.equal(result.provider, "nvidia-nim");
    assert.equal(result.model, config.model);
    assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 9 });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.headers.authorization, "Bearer test-nim-key");
    assert.equal(calls[1].init.headers.authorization, "Bearer test-nim-key");
    assert.equal(JSON.parse(calls[1].init.body).model, config.model);
    assert.equal(q.reservations.length, 1);
    assert.ok(q.reservations[0] >= request.input.length + request.maxOutputTokens);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("NVIDIA NIM refuses positive-cost requests before making network calls", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return json({ data: [{ id: config.model }] }); };
  try {
    const provider = new NvidiaNimProvider(config, quota());
    await assert.rejects(
      () => provider.complete({ ...request, estimatedCostInr: 0.01 }),
      /estimated cost must be exactly INR 0/
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("NVIDIA NIM refuses an unlisted model and does not reserve quota", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => json({ data: [{ id: "some/other-model" }] });
  const q = quota();
  try {
    const provider = new NvidiaNimProvider(config, q);
    await assert.rejects(() => provider.complete(request), /not listed as available/);
    assert.equal(q.reservations.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("NVIDIA NIM stops before inference when the persistent quota reservation fails", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return json({ data: [{ id: config.model }] });
  };
  const q = { reserve: async () => { throw new Error("Configured no-cost provider quota exhausted"); } };
  try {
    const provider = new NvidiaNimProvider(config, q);
    await assert.rejects(() => provider.complete(request), /quota exhausted/);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].endsWith("/v1/models"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("NVIDIA NIM requires a recent explicit free-tier verification", () => {
  assert.throws(() => new NvidiaNimProvider({
    ...config,
    freeTierVerifiedAt: "2020-01-01T00:00:00.000Z"
  }, quota()), /verified within the last 30 days/);
  assert.throws(() => new NvidiaNimProvider({
    ...config,
    freeTierVerifiedAt: "not-a-date"
  }, quota()), /verified within the last 30 days/);
});
