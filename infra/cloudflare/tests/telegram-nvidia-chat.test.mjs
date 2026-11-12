import test from "node:test";
import assert from "node:assert/strict";
import { makeReply } from "../src/index.mjs";

function streamedNimResponse(content, promptTokens = 12, completionTokens = 5) {
  const model = "stepfun-ai/step-5-preview";
  const chunks = [
    { model, choices: [{ delta: { role: "assistant", content } }] },
    { model, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } }
  ];
  const body = chunks.map(chunk => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function cloudPilotResponse(content, promptTokens = 12, completionTokens = 5) {
  return new Response(JSON.stringify({
    model: "stepfun-ai/step-5-preview",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function fakeDb() {
  const quota = { requests_reserved: 0, requests_used: 0, tokens_reserved: 0, tokens_used: 0, cost_microunits: 0 };
  return {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async all() { return { results: [] }; },
        async first() {
          if (sql.includes("SELECT enabled FROM nvidia_runtime_control")) return { enabled: 1 };
          if (sql.includes("SELECT requests_reserved,requests_used,tokens_reserved,tokens_used,cost_microunits")) return { ...quota };
          if (sql.includes("INSERT INTO inference_quota_daily")) {
            quota.requests_reserved += 1;
            quota.tokens_reserved += Number(values[2] || 0);
            return { requests_reserved: quota.requests_reserved };
          }
          if (sql.includes("UPDATE inference_quota_daily")) {
            quota.requests_reserved -= 1;
            quota.requests_used += 1;
            quota.tokens_reserved -= Number(values[0] || 0);
            quota.tokens_used += Number(values[1] || 0);
            return { requests_used: quota.requests_used, tokens_used: quota.tokens_used };
          }
          return null;
        }
      };
    }
  };
}

test("ordinary Telegram messages fail closed until zero-cost NVIDIA entitlement is verified", async () => {
  const reply = await makeReply({
    update_id: 101,
    message: { text: "Hello Transactra", from: { id: 12345 }, chat: { id: 12345, type: "private" } }
  }, {
    TELEGRAM_OWNER_ID: "12345",
    NVIDIA_NIM_EXECUTION_ENABLED: "true",
    NVIDIA_NIM_API_KEY: "test-key",
    NVIDIA_NIM_MODEL: "test-model"
  });

  assert.match(reply, /chat is paused by its service, entitlement, or execution gate/);
  assert.match(reply, /No model request was sent/);
});

test("ordinary owner messages are sent through authenticated CloudPilot inference when every safety gate passes", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  let requestUrl;
  globalThis.fetch = async (url, options) => {
    requestUrl = String(url);
    requestBody = JSON.parse(options.body);
    return cloudPilotResponse("Hello from CloudPilot", 12, 5);
  };
  try {
    const reply = await makeReply({
      update_id: 103,
      message: { text: "What can you do?", from: { id: 12345 }, chat: { id: 12345, type: "private" } }
    }, {
      TELEGRAM_OWNER_ID: "12345",
      NVIDIA_NIM_EXECUTION_ENABLED: "true",
      NVIDIA_NIM_FREE_TIER_VERIFIED_AT: new Date().toISOString(),
      NVIDIA_NIM_ZERO_COST_LIMIT_INR: "0",
      NVIDIA_NIM_API_KEY: "test-key",
      NVIDIA_NIM_MODEL: "stepfun-ai/step-5-preview",
      CLOUDPILOT_INFERENCE_URL: "https://cloudpilot-edge.himaneeshreddyk.workers.dev/chat/completions",
      CLOUDPILOT_INFERENCE_SECRET: "test-shared-secret-that-is-at-least-32-bytes",
      DB: fakeDb()
    });

    assert.equal(reply, "Hello from CloudPilot");
    assert.equal(requestUrl, "https://cloudpilot-edge.himaneeshreddyk.workers.dev/chat/completions");
    assert.match(requestBody.messages.at(-1).content, /What can you do\?/);
    assert.equal(requestBody.model, "stepfun-ai/step-5-preview");
    assert.equal(requestBody.max_tokens, 256);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unique CloudPilot live-check command confirms returned model, latency, and usage", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return cloudPilotResponse("CLOUDPILOT_OK", 9, 2);
  };
  try {
    const reply = await makeReply({
      update_id: 104,
      message: { text: "TRANSACTRA_CLOUDPILOT_LIVE_CHECK_20261110_TEST1234", from: { id: 12345 }, chat: { id: 12345, type: "private" } }
    }, {
      TELEGRAM_OWNER_ID: "12345",
      NVIDIA_NIM_EXECUTION_ENABLED: "true",
      NVIDIA_NIM_FREE_TIER_VERIFIED_AT: new Date().toISOString(),
      NVIDIA_NIM_ZERO_COST_LIMIT_INR: "0",
      NVIDIA_NIM_API_KEY: "test-key",
      NVIDIA_NIM_MODEL: "stepfun-ai/step-5-preview",
      NVIDIA_NIM_FALLBACK_MODELS: "",
      CLOUDPILOT_INFERENCE_URL: "https://cloudpilot-edge.himaneeshreddyk.workers.dev/chat/completions",
      CLOUDPILOT_INFERENCE_SECRET: "test-shared-secret-that-is-at-least-32-bytes",
      DB: fakeDb()
    });
    assert.match(reply, /Result: CLOUDPILOT_OK/);
    assert.match(reply, /Returned model: stepfun-ai\/step-5-preview/);
    assert.match(reply, /Latency: \d+ ms/);
    assert.match(reply, /Quota settlement: handled by CloudPilot/);
    assert.equal(requestBody.max_tokens, 64);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("owner-only model command toggles runtime control without sending inference", async () => {
  let enabled = 0;
  const db = {
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...args) { values = args; return statement; },
        async first() {
          if (sql.includes("SELECT enabled FROM nvidia_runtime_control")) return { enabled };
          return null;
        },
        async run() {
          if (sql.includes("INSERT INTO nvidia_runtime_control")) enabled = Number(values[1]);
          return { meta: { changes: 1 } };
        }
      };
      return statement;
    }
  };
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error("control commands must not call NVIDIA"); };
  const env = {
    TELEGRAM_OWNER_ID: "12345",
    NVIDIA_NIM_EXECUTION_ENABLED: "true",
    NVIDIA_NIM_FREE_TIER_VERIFIED_AT: new Date().toISOString(),
    NVIDIA_NIM_ZERO_COST_LIMIT_INR: "0",
    NVIDIA_NIM_API_KEY: "test-key",
    NVIDIA_NIM_MODEL: "stepfun-ai/step-5-preview",
    CLOUDPILOT_INFERENCE_URL: "https://cloudpilot-edge.himaneeshreddyk.workers.dev/chat/completions",
    CLOUDPILOT_INFERENCE_SECRET: "test-shared-secret-that-is-at-least-32-bytes",
    DB: db
  };
  try {
    const onReply = await makeReply({
      update_id: 201,
      message: { text: "/nvidia on", from: { id: 12345 }, chat: { id: 12345, type: "private" } }
    }, env);
    assert.match(onReply, /service is ON/);
    assert.equal(enabled, 1);

    const offReply = await makeReply({
      update_id: 202,
      message: { text: "/nvidia off", from: { id: 12345 }, chat: { id: 12345, type: "private" } }
    }, env);
    assert.match(offReply, /service is OFF/);
    assert.equal(enabled, 0);

    const unauthorized = await makeReply({
      update_id: 203,
      message: { text: "/nvidia on", from: { id: 99999 }, chat: { id: 99999, type: "private" } }
    }, env);
    assert.equal(unauthorized, null);
    assert.equal(enabled, 0);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unknown slash commands remain control-plane messages, not model prompts", async () => {
  const reply = await makeReply({
    update_id: 102,
    message: { text: "/not-a-command", from: { id: 12345 }, chat: { id: 12345, type: "private" } }
  }, { TELEGRAM_OWNER_ID: "12345" });

  assert.match(reply, /not connected to the Cloudflare Telegram runtime yet/);
});

test("saved owner memory is injected into chat prompt context", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return cloudPilotResponse("I recall your project memory", 15, 6);
  };
  const db = fakeDb();
  const originalPrepare = db.prepare;
  db.prepare = (sql) => {
    const stmt = originalPrepare(sql);
    if (sql.includes("SELECT memory_key,memory_value FROM agent_memory")) {
      return {
        bind() {
          return {
            async all() {
              return { results: [{ memory_key: "project", memory_value: "Transactra autonomous assistant" }] };
            }
          };
        }
      };
    }
    return stmt;
  };
  try {
    const reply = await makeReply({
      update_id: 301,
      message: { text: "What is my project?", from: { id: 12345 }, chat: { id: 12345, type: "private" } }
    }, {
      TELEGRAM_OWNER_ID: "12345",
      NVIDIA_NIM_EXECUTION_ENABLED: "true",
      NVIDIA_NIM_FREE_TIER_VERIFIED_AT: new Date().toISOString(),
      NVIDIA_NIM_ZERO_COST_LIMIT_INR: "0",
      NVIDIA_NIM_API_KEY: "test-key",
      NVIDIA_NIM_MODEL: "stepfun-ai/step-5-preview",
      CLOUDPILOT_INFERENCE_URL: "https://cloudpilot-edge.himaneeshreddyk.workers.dev/chat/completions",
      CLOUDPILOT_INFERENCE_SECRET: "test-shared-secret-that-is-at-least-32-bytes",
      DB: db
    });
    assert.equal(reply, "I recall your project memory");
    const prompt = requestBody.messages.at(-1).content;
    assert.match(prompt, /\[Saved owner memory\]/);
    assert.match(prompt, /project: Transactra autonomous assistant/);
    assert.match(prompt, /What is my project\?/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

