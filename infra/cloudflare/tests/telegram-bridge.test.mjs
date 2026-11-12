import test from "node:test";
import assert from "node:assert/strict";
import edgeWorker from "../src/index.mjs";
import telegramWorker from "../telegram-worker/index.mjs";

const OWNER = "8593447241";
const BRIDGE = "bridge-secret-for-tests-with-at-least-32-bytes";

test("Telegram Worker forwards owner messages to the D1 orchestrator through the authenticated service binding", async () => {
  let forwarded = null;
  const env = {
    TELEGRAM_BOT_TOKEN: "123456:test-token",
    TELEGRAM_WEBHOOK_SECRET: "telegram-webhook-secret",
    TELEGRAM_OWNER_ID: OWNER,
    TRANSACTRA_TELEGRAM_BRIDGE_SECRET: BRIDGE,
    ORCHESTRATOR: {
      async fetch(request) {
        forwarded = request;
        return new Response(JSON.stringify({ ok: true, queued: true }), { status: 202 });
      }
    }
  };
  const update = {
    update_id: 771,
    message: {
      message_id: 22,
      text: "Build a model registry integration test",
      from: { id: Number(OWNER) },
      chat: { id: Number(OWNER), type: "private" }
    }
  };
  const response = await telegramWorker.fetch(new Request("https://telegram.test/telegram/webhook", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "telegram-webhook-secret", "content-type": "application/json" },
    body: JSON.stringify(update)
  }), env);
  assert.equal(response.status, 200);
  assert.ok(forwarded instanceof Request);
  assert.equal(new URL(forwarded.url).pathname, "/internal/telegram/update");
  assert.equal(forwarded.headers.get("x-transactra-bridge-secret"), BRIDGE);
  assert.deepEqual(await forwarded.json(), update);
});

test("Telegram Worker does not forward a non-owner update to the orchestrator", async () => {
  let forwarded = false;
  const env = {
    TELEGRAM_BOT_TOKEN: "123456:test-token",
    TELEGRAM_WEBHOOK_SECRET: "telegram-webhook-secret",
    TELEGRAM_OWNER_ID: OWNER,
    TRANSACTRA_TELEGRAM_BRIDGE_SECRET: BRIDGE,
    ORCHESTRATOR: { async fetch() { forwarded = true; return new Response("{}", { status: 202 }); } }
  };
  const update = { update_id: 772, message: { text: "do something", from: { id: 999 }, chat: { id: 999, type: "private" } } };
  await telegramWorker.fetch(new Request("https://telegram.test/telegram/webhook", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "telegram-webhook-secret", "content-type": "application/json" },
    body: JSON.stringify(update)
  }), env);
  assert.equal(forwarded, false);
});

test("Telegram internal send endpoint requires a high-entropy bridge secret", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new Error("Telegram must not be called"); };
  try {
    const response = await telegramWorker.fetch(new Request("https://telegram.test/internal/telegram/send", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: OWNER, text: "hello" })
    }), { TELEGRAM_BOT_TOKEN: "123456:test-token", TRANSACTRA_TELEGRAM_BRIDGE_SECRET: "" });
    assert.equal(response.status, 401);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Telegram internal send endpoint relays only bounded messages to the Bot API", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), payload: JSON.parse(init.body) };
    return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), { status: 200 });
  };
  try {
    const response = await telegramWorker.fetch(new Request("https://telegram.test/internal/telegram/send", {
      method: "POST",
      headers: { "content-type": "application/json", "x-transactra-bridge-secret": BRIDGE },
      body: JSON.stringify({ chat_id: OWNER, text: "Orchestrator reply", message_thread_id: 3 })
    }), { TELEGRAM_BOT_TOKEN: "123456:test-token", TRANSACTRA_TELEGRAM_BRIDGE_SECRET: BRIDGE });
    assert.equal(response.status, 200);
    assert.match(request.url, /\/bot123456:test-token\/sendMessage$/);
    assert.equal(request.payload.chat_id, OWNER);
    assert.equal(request.payload.text, "Orchestrator reply");
    assert.equal(request.payload.message_thread_id, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("staging orchestrator accepts only owner Telegram updates through the shared bridge", async () => {
  const events = [];
  const env = {
    TELEGRAM_OWNER_ID: OWNER,
    TRANSACTRA_TELEGRAM_BRIDGE_SECRET: BRIDGE,
    TELEGRAM_GATEWAY: { async fetch() { return new Response(JSON.stringify({ ok: true }), { status: 200 }); } },
    EVENTS: { async send(event) { events.push(event); } },
    DB: { prepare() { throw new Error("D1 is not read by the internal ingress endpoint"); } }
  };
  const update = { update_id: 773, message: { text: "/goal Build a dashboard", from: { id: Number(OWNER) }, chat: { id: Number(OWNER), type: "private" } } };
  const accepted = await edgeWorker.fetch(new Request("https://edge.test/internal/telegram/update", {
    method: "POST", headers: { "content-type": "application/json", "x-transactra-bridge-secret": BRIDGE }, body: JSON.stringify(update)
  }), env);
  assert.equal(accepted.status, 202);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "telegram.update");
  assert.deepEqual(events[0].payload, update);

  const denied = await edgeWorker.fetch(new Request("https://edge.test/internal/telegram/update", {
    method: "POST", headers: { "content-type": "application/json", "x-transactra-bridge-secret": "wrong" }, body: JSON.stringify(update)
  }), env);
  assert.equal(denied.status, 401);

  const nonOwner = { ...update, update_id: 774, message: { ...update.message, from: { id: 999 }, chat: { id: 999, type: "private" } } };
  const forbidden = await edgeWorker.fetch(new Request("https://edge.test/internal/telegram/update", {
    method: "POST", headers: { "content-type": "application/json", "x-transactra-bridge-secret": BRIDGE }, body: JSON.stringify(nonOwner)
  }), env);
  assert.equal(forbidden.status, 403);
  assert.equal(events.length, 1);
});
