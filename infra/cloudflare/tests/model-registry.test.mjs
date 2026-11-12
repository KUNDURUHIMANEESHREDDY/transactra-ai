import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { completeRegisteredModel, hasRegisteredTaskModel, MODEL_REGISTRY_LIMITS } from "../src/model-registry.mjs";
import { createOrchestratorPlan } from "../src/orchestrator.mjs";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const secret = "model-registry-test-secret-with-more-than-thirty-two-bytes";
const owner = "123456";

async function encrypt(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("transactra-model-key-v1:" + secret));
  const key = await crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
  const packed = new Uint8Array([...iv, ...new Uint8Array(ciphertext)]);
  return btoa(String.fromCharCode(...packed)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function dbFor(route, providers) {
  return {
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...args) { values = args; return statement; },
        async first() {
          if (sql.includes("SELECT p.id FROM task_model_routes")) return route?.model_provider_id ? { id: route.model_provider_id } : null;
          if (sql.includes("SELECT model_provider_id,fallback_provider_id")) return route;
          if (sql.includes("SELECT id,name,provider,base_url,model_id,encrypted_api_key,max_output_tokens")) return providers[values[0]] || null;
          if (sql.includes("INSERT INTO model_usage_daily")) return { usage_date: values[2] };
          if (sql.includes("UPDATE model_usage_daily")) return { requests_used: 1, tokens_used: values[1] };
          return null;
        }
      };
      return statement;
    }
  };
}

test("no registered task route preserves the existing CloudPilot fallback path", async () => {
  const db = dbFor(null, {});
  assert.equal(await hasRegisteredTaskModel(db, owner, "general"), false);
  assert.equal(await completeRegisteredModel({ TELEGRAM_OWNER_ID: owner }, db, { input: "hello", maxOutputTokens: 20 }, "general"), null);
});

test("registered model uses the encrypted key and routes to the task-selected provider", async () => {
  const encrypted = await encrypt("test-provider-api-key");
  const provider = { id: "model-1", name: "Test", provider: "openai-compatible", base_url: "https://api.openai.com/v1", model_id: "gpt-test", encrypted_api_key: encrypted, max_output_tokens: 512 };
  const db = dbFor({ model_provider_id: provider.id, fallback_provider_id: null }, { [provider.id]: provider });
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init };
    return new Response(JSON.stringify({ model: "gpt-test", choices: [{ message: { content: "MODEL_OK" } }], usage: { prompt_tokens: 10, completion_tokens: 4 } }), { status: 200 });
  };
  try {
    const result = await completeRegisteredModel({ TELEGRAM_OWNER_ID: owner, MODEL_REGISTRY_ENCRYPTION_KEY: secret }, db, {
      systemPrompt: "Be concise", input: "hello", maxOutputTokens: 64
    }, "general");
    assert.equal(result.output, "MODEL_OK");
    assert.equal(result.provider, "openai-compatible");
    assert.equal(result.model, "gpt-test");
    assert.equal(request.url, "https://api.openai.com/v1/chat/completions");
    assert.equal(request.init.headers.authorization, "Bearer test-provider-api-key");
    assert.equal(JSON.parse(request.init.body).model, "gpt-test");
    assert.equal(JSON.parse(request.init.body).max_tokens, 64);
    assert.equal(request.init.redirect, "error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("daily model usage limits are bounded and explicit", () => {
  assert.equal(MODEL_REGISTRY_LIMITS.maxDailyRequests, 100);
  assert.equal(MODEL_REGISTRY_LIMITS.maxDailyTokens, 50000);
  assert.equal(MODEL_REGISTRY_LIMITS.maxOutputTokens, 1000);
});

test("model registry fails closed when the encryption key is absent", async () => {
  const encrypted = await encrypt("test-provider-api-key");
  const provider = { id: "model-1", name: "Test", provider: "openai-compatible", base_url: "https://api.openai.com/v1", model_id: "gpt-test", encrypted_api_key: encrypted, max_output_tokens: 512 };
  const db = dbFor({ model_provider_id: provider.id, fallback_provider_id: null }, { [provider.id]: provider });
  await assert.rejects(() => completeRegisteredModel({ TELEGRAM_OWNER_ID: owner }, db, { input: "hello", maxOutputTokens: 20 }, "general"), /encryption key is unavailable/);
});

test("orchestrator planning uses the model assigned to orchestration in D1", async () => {
  const encrypted = await encrypt("test-provider-api-key");
  const provider = { id: "model-1", name: "Test", provider: "openai-compatible", base_url: "https://api.openai.com/v1", model_id: "gpt-test", encrypted_api_key: encrypted, max_output_tokens: 512 };
  const db = dbFor({ model_provider_id: provider.id, fallback_provider_id: null }, { [provider.id]: provider });
  const originalFetch = globalThis.fetch;
  let requestedModel = null;
  globalThis.fetch = async (_url, init) => {
    requestedModel = JSON.parse(init.body).model;
    return new Response(JSON.stringify({
      model: "gpt-test",
      choices: [{ message: { content: JSON.stringify({
        title: "Staging plan",
        objective: "Build a staging plan",
        steps: [{ agent: "analyst", tool: "none", tool_input: {}, description: "Review staging readiness", acceptance_criteria: "Return a readiness assessment", risk: "low", depends_on: [] }]
      }) } }],
      usage: { prompt_tokens: 20, completion_tokens: 40 }
    }), { status: 200 });
  };
  try {
    const plan = await createOrchestratorPlan({
      TELEGRAM_OWNER_ID: owner,
      MODEL_REGISTRY_ENCRYPTION_KEY: secret
    }, db, "Build a staging plan");
    assert.equal(requestedModel, "gpt-test");
    assert.equal(plan.mode, "model_proposed");
    assert.equal(plan.model_provider, "openai-compatible");
    assert.equal(plan.model, "gpt-test");
    assert.equal(plan.model_task_type, "orchestration");
    assert.equal(plan.execution.enabled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
