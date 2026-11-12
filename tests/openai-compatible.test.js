import test from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleProvider } from "../dist/packages/providers/src/openai-compatible.js";

const config = () => ({
  id:"secondary-free",
  apiKey:"test-api-key-value",
  model:"verified-model",
  baseUrl:"https://api.example.test/openai/v1",
  freeTierVerifiedAt:new Date().toISOString()
});

test("OpenAI-compatible adapter verifies model, reserves quota and completes", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const reservations = [];
  globalThis.fetch = async (url,init = {}) => {
    calls.push({ url:String(url),init });
    if (init.method === "GET") return new Response(JSON.stringify({ data:[{ id:"verified-model" }] }),{ status:200,headers:{ "content-type":"application/json" } });
    return new Response(JSON.stringify({ choices:[{ message:{ content:"completed" } }],usage:{ prompt_tokens:12,completion_tokens:4 } }),{ status:200,headers:{ "content-type":"application/json" } });
  };
  try {
    const provider = new OpenAICompatibleProvider(config(),{ reserve:async (tokens) => { reservations.push(tokens); } });
    const result = await provider.complete({ input:"hello",systemPrompt:"be precise",maxOutputTokens:100,estimatedCostInr:0 });
    assert.equal(provider.id,"secondary-free");
    assert.equal(provider.zeroCostAuthorized,true);
    assert.equal(result.provider,"secondary-free");
    assert.equal(result.model,"verified-model");
    assert.equal(result.output,"completed");
    assert.equal(result.usage.inputTokens,12);
    assert.equal(calls[0].url,"https://api.example.test/openai/v1/models");
    assert.equal(calls[1].url,"https://api.example.test/openai/v1/chat/completions");
    assert.equal(reservations.length,1);
    assert.ok(reservations[0] > 100);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("secondary adapter blocks positive-cost inference before network or quota use", async () => {
  let calls = 0;
  let reservations = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; return new Response("{}",{ status:200 }); };
  try {
    const provider = new OpenAICompatibleProvider(config(),{ reserve:async () => { reservations += 1; } });
    await assert.rejects(() => provider.complete({ input:"hello",maxOutputTokens:10,estimatedCostInr:1 }),/INR 0/);
    assert.equal(calls,0);
    assert.equal(reservations,0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("secondary adapter rejects stale free-tier verification and unsafe endpoints", () => {
  assert.throws(() => new OpenAICompatibleProvider({ ...config(),freeTierVerifiedAt:"2020-01-01T00:00:00.000Z" },{ reserve:async () => {} }),/verified within the last 30 days/);
  assert.throws(() => new OpenAICompatibleProvider({ ...config(),baseUrl:"http://api.example.test/v1" },{ reserve:async () => {} }),/must use HTTPS/);
  assert.throws(() => new OpenAICompatibleProvider({ ...config(),baseUrl:"https://api.example.test" },{ reserve:async () => {} }),/must end in \/v1/);
});

test("secondary adapter does not reserve quota when configured model is absent", async () => {
  let reservations = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data:[{ id:"different-model" }] }),{ status:200,headers:{ "content-type":"application/json" } });
  try {
    const provider = new OpenAICompatibleProvider(config(),{ reserve:async () => { reservations += 1; } });
    await assert.rejects(() => provider.complete({ input:"hello",maxOutputTokens:10,estimatedCostInr:0 }),/not listed/);
    assert.equal(reservations,0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
