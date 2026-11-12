import test from "node:test";
import assert from "node:assert/strict";
import worker from "../infra/cloudflare/src/index.mjs";

const OWNER_ID = "123456";
const BOT_TOKEN = "test-bot-token";
const WEBHOOK_SECRET = "test-webhook-secret";

function createDb({ tableCount = 11, outboxStatus = "pending", taskColumnCount = 4, outboxColumnCount = 1 } = {}) {
  const statements = [];
  const db = {
    prepare(sql) {
      const entry = { sql, values: [] };
      const statement = {
        bind(...values) {
          entry.values = values;
          return statement;
        },
        async run() {
          if (sql.startsWith("UPDATE tasks SET status=?") && !["awaiting_provider", "cancelled"].includes(entry.values[0])) {
            throw new Error("CHECK constraint failed: tasks.status");
          }
          if (sql.startsWith("UPDATE task_runs SET state=?") && !["awaiting_provider", "queued", "running", "succeeded", "failed", "cancelled"].includes(entry.values[0])) {
            throw new Error("CHECK constraint failed: task_runs.state");
          }
          statements.push(entry);
          return { success: true };
        },
        async all() {
          statements.push(entry);
          if (sql.includes("SELECT id,memory_key,memory_value FROM agent_memory")) return { results: [{ id: "mem-fixture", memory_key: "deployment.region", memory_value: "Bengaluru" }] };
          return { results: [] };
        },
        async first() {
          statements.push(entry);
          if (sql.includes("pragma_table_info('telegram_reply_outbox')")) return { total: outboxColumnCount };
          if (sql.includes("pragma_table_info('tasks')")) return { total: taskColumnCount };
          if (sql.includes("sqlite_master")) return { total: tableCount };
          if (sql.includes("SELECT COUNT(*) AS total, MAX(received_at)")) {
            return { total: 5, latest: "2026-11-09T05:54:38.807Z" };
          }
          if (sql.includes("SELECT scheduled_at")) {
            return { scheduled_at: "2026-11-09T05:45:29.175Z" };
          }
          if (sql.includes("SELECT chat_id,thread_id,reply_text,status,business_connection_id")) {
            const inserted = statements.findLast((item) =>
              item.sql.includes("INSERT OR IGNORE INTO telegram_reply_outbox"));
            if (!inserted) return null;
            return {
              chat_id: inserted.values[1],
              thread_id: inserted.values[2],
              reply_text: inserted.values[3],
              status: outboxStatus,
              business_connection_id: inserted.values[5] ?? null,
            };
          }
          return null;
        },
      };
      return statement;
    },
  };
  return { db, statements };
}

function configuredEnv(db, overrides = {}) {
  return {
    DB: db,
    EVENTS: { send: async () => {} },
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_OWNER_ID: OWNER_ID,
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TRANSACTRA_PIPELINE_URL: "https://pipeline.test",
    TRANSACTRA_PIPELINE_API_TOKEN: "test-api-token",
    TRANSACTRA_PIPELINE_APPROVAL_TOKEN: "test-approval-token",
    ...overrides,
  };
}

function telegramUpdate({
  updateId = 42,
  text = "hello Transactra",
  senderId = OWNER_ID,
  chatId = OWNER_ID,
  threadId = 7,
} = {}) {
  return {
    update_id: updateId,
    message: {
      text,
      from: { id: senderId },
      chat: { id: chatId, type: "private" },
      message_thread_id: threadId,
    },
  };
}

function queueMessage(update) {
  let acknowledged = false;
  return {
    message: {
      body: {
        type: "telegram.update",
        updateId: update.update_id,
        receivedAt: "2026-11-09T05:54:38.807Z",
        payload: update,
      },
      ack() {
        acknowledged = true;
      },
    },
    acknowledged: () => acknowledged,
  };
}

test("health endpoint remains a liveness check without secrets", async () => {
  const response = await worker.fetch(new Request("https://transactra.test/health"), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "transactra-edge",
    telegram: "webhook",
  });
});

test("readiness endpoint fails closed when required bindings are missing", async () => {
  const response = await worker.fetch(new Request("https://transactra.test/ready"), {});
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    service: "transactra-edge",
    ready: false,
  });
});

test("D1-native readiness requires the complete local schema and configured bindings without a control-plane call", async () => {
  const originalFetch = globalThis.fetch;
  let externalCalls = 0;
  globalThis.fetch = async () => {
    externalCalls += 1;
    throw new Error("D1-native readiness must not call the legacy control plane");
  };
  try {
    const healthy = createDb({ tableCount: 19 });
    const ready = await worker.fetch(
      new Request("https://transactra.test/ready"),
      configuredEnv(healthy.db, { TRANSACTRA_PLANNER_MODE: "d1-native" }),
    );
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), {
      ok: true,
      service: "transactra-edge",
      ready: true,
      planner: "d1-native",
      inference: {
        status: "disabled",
        configured: false,
        runtime_enabled: false,
        developer_access_verified: false,
        zero_cost_verified: false,
        billing_mode: "nvidia_developer_program_free_endpoint",
        models: [],
        reason: "developer_access_unverified",
      },
      memory: { provider: "d1-fallback", mem0: "stale", checked_at: null },
    });

    const missingTable = createDb({ tableCount: 18 });
    const notReady = await worker.fetch(
      new Request("https://transactra.test/ready"),
      configuredEnv(missingTable.db, { TRANSACTRA_PLANNER_MODE: "d1-native" }),
    );
    assert.equal(notReady.status, 503);

    const missingBridgeColumns = createDb({ tableCount: 19, taskColumnCount: 0 });
    const columnsNotReady = await worker.fetch(
      new Request("https://transactra.test/ready"),
      configuredEnv(missingBridgeColumns.db, { TRANSACTRA_PLANNER_MODE: "d1-native" }),
    );
    assert.equal(columnsNotReady.status, 503);

    const missingBusinessOutboxColumn = createDb({ tableCount: 19, outboxColumnCount: 0 });
    const outboxNotReady = await worker.fetch(
      new Request("https://transactra.test/ready"),
      configuredEnv(missingBusinessOutboxColumn.db, { TRANSACTRA_PLANNER_MODE: "d1-native" }),
    );
    assert.equal(outboxNotReady.status, 503);

    const missingTelegramSecret = await worker.fetch(
      new Request("https://transactra.test/ready"),
      configuredEnv(healthy.db, {
        TRANSACTRA_PLANNER_MODE: "d1-native",
        TELEGRAM_WEBHOOK_SECRET: "",
      }),
    );
    assert.equal(missingTelegramSecret.status, 503);
    assert.equal(externalCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("D1-native readiness fails closed when local schema inspection is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  let externalCalls = 0;
  globalThis.fetch = async () => {
    externalCalls += 1;
    throw new Error("D1-native readiness must not call the legacy control plane");
  };
  try {
    const unavailableDb = {
      prepare() {
        return {
          bind() { return this; },
          async first() { throw new Error("D1 unavailable"); },
        };
      },
    };
    const response = await worker.fetch(
      new Request("https://transactra.test/ready"),
      configuredEnv(unavailableDb, { TRANSACTRA_PLANNER_MODE: "d1-native" }),
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      ok: false,
      service: "transactra-edge",
      ready: false,
      planner: "d1-native",
    });
    assert.equal(externalCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Telegram webhook rejects missing owner-response bindings as not configured", async () => {
  const { db } = createDb();
  const env = configuredEnv(db);
  delete env.TELEGRAM_OWNER_ID;
  const response = await worker.fetch(new Request("https://transactra.test/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": WEBHOOK_SECRET,
    },
    body: JSON.stringify({ update_id: 1 }),
  }), env);
  assert.equal(response.status, 503);
});

test("Telegram webhook rejects an invalid secret when all bindings are configured", async () => {
  const { db } = createDb();
  let enqueued = false;
  const env = configuredEnv(db, {
    EVENTS: { send: async () => { enqueued = true; } },
  });
  const response = await worker.fetch(new Request("https://transactra.test/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "wrong",
    },
    body: JSON.stringify({ update_id: 1 }),
  }), env);
  assert.equal(response.status, 401);
  assert.equal(enqueued, false);
});

test("Telegram webhook queues a validated update without returning its payload", async () => {
  const { db } = createDb();
  let queued;
  const env = configuredEnv(db, {
    EVENTS: { send: async (value) => { queued = value; } },
  });
  const update = telegramUpdate();
  const response = await worker.fetch(new Request("https://transactra.test/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": WEBHOOK_SECRET,
    },
    body: JSON.stringify(update),
  }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(queued.type, "telegram.update");
  assert.equal(queued.updateId, update.update_id);
  assert.deepEqual(queued.payload, update);
});

test("Telegram webhook rejects malformed and invalid updates without enqueueing", async () => {
  const { db } = createDb();
  let enqueueCount = 0;
  const env = configuredEnv(db, {
    EVENTS: { send: async () => { enqueueCount += 1; } },
  });
  const malformed = await worker.fetch(new Request("https://transactra.test/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": WEBHOOK_SECRET,
    },
    body: "{",
  }), env);
  assert.equal(malformed.status, 400);

  const invalid = await worker.fetch(new Request("https://transactra.test/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": WEBHOOK_SECRET,
    },
    body: JSON.stringify({ update_id: "not-an-integer" }),
  }), env);
  assert.equal(invalid.status, 400);
  assert.equal(enqueueCount, 0);
});

test("queue consumer persists an owner update and sends a threaded reply through the outbox", async () => {
  const { db, statements } = createDb();
  const update = telegramUpdate();
  const queued = queueMessage(update);
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    assert.equal(init.method, "POST");
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await worker.queue({ messages: [queued.message] }, configuredEnv(db));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(queued.acknowledged(), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, OWNER_ID);
  assert.equal(sent[0].message_thread_id, 7);
  assert.match(sent[0].text, /chat is paused by its service, entitlement, or execution gate/);
  assert.match(sent[0].text, /No model request was sent and no paid fallback is configured/);
  assert.ok(statements.some((item) =>
    item.sql.includes("INSERT OR IGNORE INTO inbound_events") && item.values[1] === "42"));
  assert.ok(statements.some((item) =>
    item.sql.includes("INSERT OR IGNORE INTO telegram_reply_outbox")));
  assert.ok(statements.some((item) =>
    item.sql.includes("UPDATE telegram_reply_outbox SET status='sent'")));
});


test("owner /task creates a durable D1 record and hands off to the existing planner behind owner approval", async () => {
  const { db, statements } = createDb();
  const update = telegramUpdate({ text: "/task Build a secure task scheduler" });
  const queued = queueMessage(update);
  const sent = [];
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), headers: init.headers, body: init.body });
    if (String(url) === "https://pipeline.test/v1/telegram/tasks") {
      return new Response(JSON.stringify({
        task: { id: "11111111-1111-4111-8111-111111111111" },
        approval: { id: "22222222-2222-4222-8222-222222222222", status: "pending" },
        created: true
      }), { status: 201, headers: { "content-type": "application/json" } });
    }
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 101 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await worker.queue({ messages: [queued.message] }, configuredEnv(db));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(queued.acknowledged(), true);
  assert.equal(requests[0].url, "https://pipeline.test/v1/telegram/tasks");
  assert.equal(JSON.parse(requests[0].body).sourceEventId, "42");
  assert.match(JSON.parse(requests[0].body).objective, /^Build a secure task scheduler/);
  assert.match(JSON.parse(requests[0].body).objective, /deployment.region: Bengaluru/);
  assert.match(sent[0].text, /Task submitted to Transactra planner/);
  assert.match(sent[0].text, /waiting_approval/);
  assert.match(sent[0].text, /No task execution will begin until you explicitly approve/);
  assert.ok(statements.some((item) => item.sql.includes("INSERT OR IGNORE INTO tasks") && item.values[4] === "Build a secure task scheduler"));
  assert.ok(statements.some((item) => item.sql.includes("INSERT OR IGNORE INTO task_events") && item.values[1] === "task.accepted"));
  assert.ok(statements.some((item) => item.sql.includes("INSERT OR IGNORE INTO tasks") && item.sql.includes("'awaiting_provider'")));
  assert.ok(statements.some((item) => item.sql.includes("UPDATE tasks SET status=?") && item.values[0] === "awaiting_provider" && item.values[3] === "pending"));
  assert.ok(statements.some((item) => item.sql.includes("UPDATE task_runs SET state=?") && item.values[0] === "awaiting_provider"));
  assert.ok(statements.some((item) => item.sql.includes("INSERT OR IGNORE INTO task_run_events") && item.values[1] === "run.created"));
  assert.ok(statements.some((item) => item.sql.includes("INSERT OR IGNORE INTO orchestrator_jobs") && item.values[1] === "tg-42"));
  assert.ok(statements.some((item) => item.sql.includes("INSERT OR IGNORE INTO orchestrator_events") && item.values[2] === "orchestrator.accepted"));
  assert.ok(statements.some((item) => item.sql.includes("INSERT OR IGNORE INTO task_memory")));
});

test("owner /remember stores owner-scoped durable memory without exposing it in the reply", async () => {
  const { db, statements } = createDb();
  const queued = queueMessage(telegramUpdate({ text: "/remember deployment.region Bengaluru" }));
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 120 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try { await worker.queue({ messages: [queued.message] }, configuredEnv(db)); }
  finally { globalThis.fetch = originalFetch; }
  assert.equal(queued.acknowledged(), true);
  assert.match(sent[0].text, /Saved durable memory: deployment.region/);
  assert.ok(statements.some((item) => item.sql.includes("INSERT INTO agent_memory") && item.values[1] === OWNER_ID && item.values[2] === "deployment.region" && item.values[3] === "Bengaluru"));
});

test("owner /forget deletes only the requesting owner's selected memory key", async () => {
  const { db, statements } = createDb();
  const queued = queueMessage(telegramUpdate({ text: "/forget deployment.region" }));
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 121 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try { await worker.queue({ messages: [queued.message] }, configuredEnv(db)); }
  finally { globalThis.fetch = originalFetch; }
  assert.equal(queued.acknowledged(), true);
  assert.ok(statements.some((item) => item.sql.includes("DELETE FROM agent_memory WHERE owner_id=? AND memory_key=?") && item.values[0] === OWNER_ID && item.values[1] === "deployment.region"));
});

test("owner /approve forwards the separate approval credential and resumes the linked D1 ledger", async () => {
  const { db, statements } = createDb();
  const update = telegramUpdate({ text: "/approve 22222222-2222-4222-8222-222222222222 reviewed-and-approved" });
  const queued = queueMessage(update);
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) === "https://pipeline.test/v1/approvals/22222222-2222-4222-8222-222222222222/decision") {
      assert.equal(init.headers["x-transactra-approval-token"], "test-approval-token");
      assert.equal(JSON.parse(init.body).decision, "approved");
      return new Response(JSON.stringify({ approval: { id: "22222222-2222-4222-8222-222222222222", task_id: "11111111-1111-4111-8111-111111111111", status: "approved" } }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 102 } }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  };
  try {
    await worker.queue({ messages: [queued.message] }, configuredEnv(db));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(queued.acknowledged(), true);
  assert.match(sent[0].text, /Task execution approved/);
  assert.ok(statements.some((item) => item.sql.includes("UPDATE tasks SET status=?") && item.values[0] === "awaiting_provider" && item.values[1] === "approved"));
  assert.ok(statements.some((item) => item.sql.includes("UPDATE task_runs SET state=?") && item.values[0] === "queued"));
});

test("owner /approve leaves the D1 ledger unchanged when the planner does not confirm the requested decision", async () => {
  const { db, statements } = createDb();
  const queued = queueMessage(telegramUpdate({
    text: "/approve 22222222-2222-4222-8222-222222222222 reviewed-and-approved"
  }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) === "https://pipeline.test/v1/approvals/22222222-2222-4222-8222-222222222222/decision") {
      return new Response(JSON.stringify({
        approval: {
          id: "22222222-2222-4222-8222-222222222222",
          task_id: "11111111-1111-4111-8111-111111111111",
          status: "pending"
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 106 } }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  };
  try {
    await assert.rejects(
      worker.queue({ messages: [queued.message] }, configuredEnv(db)),
      /did not confirm the requested decision/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(queued.acknowledged(), false);
  assert.ok(!statements.some((item) => item.sql.includes("UPDATE tasks SET status=?")));
  assert.ok(!statements.some((item) => item.sql.includes("UPDATE task_runs SET state=?")));
});

test("owner /reject forwards the decision and marks the D1 task ledger failed", async () => {
  const { db, statements } = createDb();
  const update = telegramUpdate({ text: "/reject 22222222-2222-4222-8222-222222222222 not-authorized" });
  const queued = queueMessage(update);
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) === "https://pipeline.test/v1/approvals/22222222-2222-4222-8222-222222222222/decision") {
      assert.equal(init.headers["x-transactra-approval-token"], "test-approval-token");
      assert.equal(JSON.parse(init.body).decision, "rejected");
      return new Response(JSON.stringify({ approval: { id: "22222222-2222-4222-8222-222222222222", task_id: "11111111-1111-4111-8111-111111111111", status: "rejected" } }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 103 } }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  };
  try {
    await worker.queue({ messages: [queued.message] }, configuredEnv(db));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(queued.acknowledged(), true);
  assert.match(sent[0].text, /Task execution rejected/);
  assert.ok(statements.some((item) => item.sql.includes("UPDATE tasks SET status=?") && item.values[0] === "cancelled" && item.values[1] === "rejected"));
  assert.ok(statements.some((item) => item.sql.includes("UPDATE task_runs SET state=?") && item.values[0] === "cancelled"));
});

test("missing pipeline credentials save a held D1 task without calling the planner", async () => {
  const { db, statements } = createDb();
  const queued = queueMessage(telegramUpdate({ text: "/task Do not execute without approval" }));
  const env = configuredEnv(db, { TRANSACTRA_PIPELINE_API_TOKEN: "" });
  let sent;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 104 } }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  };
  try {
    await worker.queue({ messages: [queued.message] }, env);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(queued.acknowledged(), true);
  assert.match(sent.text, /Task saved to D1 but not sent/);
  assert.ok(statements.some((item) => item.sql.includes("INSERT OR IGNORE INTO tasks") && item.sql.includes("'awaiting_provider'")));
  assert.ok(statements.some((item) => item.sql.includes("INSERT OR IGNORE INTO task_events") && item.values[1] === "task.pipeline_blocked"));
  assert.ok(!statements.some((item) => item.sql.includes("UPDATE tasks SET status=?")));
});

test("missing D1 bridge migration preserves the task and never calls the planner", async () => {
  const { db, statements } = createDb({ taskColumnCount: 0 });
  const queued = queueMessage(telegramUpdate({ text: "/task Preserve this task until migration" }));
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 105 } }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  };
  try {
    await worker.queue({ messages: [queued.message] }, configuredEnv(db));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(queued.acknowledged(), true);
  assert.match(sent[0].text, /D1 pipeline bridge migration 0006 is not applied/);
  assert.ok(statements.some((item) => item.sql.includes("INSERT OR IGNORE INTO tasks") && item.sql.includes("'awaiting_provider'")));
  assert.ok(statements.some((item) => item.sql.includes("INSERT OR IGNORE INTO task_run_events") && item.values[1] === "run.pipeline_blocked"));
  assert.ok(!statements.some((item) => item.sql.includes("UPDATE tasks SET status=?")));
});

test("queue consumer reports live event and scheduler state for /status", async () => {
  const { db } = createDb();
  const update = telegramUpdate({ text: "/status", threadId: null });
  const queued = queueMessage(update);
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 100 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await worker.queue({ messages: [queued.message] }, configuredEnv(db));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(queued.acknowledged(), true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Webhook: stale; last update/);
  assert.match(sent[0].text, /Telegram updates stored: 5/);
  assert.match(sent[0].text, /Scheduler heartbeat: 2026-11-09T05:45:29.175Z/);
  assert.match(sent[0].text, /Task planner: legacy bridge configured; live readiness not yet verified/);
  assert.match(sent[0].text, /NVIDIA planning: locked by configuration or entitlement/);
  assert.match(sent[0].text, /Agent execution: LOCKED/);
  assert.match(sent[0].text, /Execution remains subject to owner approval/);
});

test("queue consumer stores but does not reply to a non-owner message", async () => {
  const { db, statements } = createDb();
  const update = telegramUpdate({ senderId: "999", chatId: "999" });
  const queued = queueMessage(update);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("non-owner messages must not trigger Telegram sends");
  };
  try {
    await worker.queue({ messages: [queued.message] }, configuredEnv(db));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(queued.acknowledged(), true);
  assert.ok(statements.some((item) => item.sql.includes("INSERT OR IGNORE INTO inbound_events")));
  assert.equal(statements.some((item) =>
    item.sql.includes("INSERT OR IGNORE INTO telegram_reply_outbox")), false);
});

test("queue consumer does not resend an outbox entry already marked sent", async () => {
  const { db } = createDb({ outboxStatus: "sent" });
  const queued = queueMessage(telegramUpdate());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("sent outbox entries must not be sent again");
  };
  try {
    await worker.queue({ messages: [queued.message] }, configuredEnv(db));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(queued.acknowledged(), true);
});

test("queue consumer leaves failed Telegram sends unacknowledged for retry", async () => {
  const { db } = createDb();
  const queued = queueMessage(telegramUpdate());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ ok: false, description: "temporarily unavailable" }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
  try {
    await assert.rejects(
      worker.queue({ messages: [queued.message] }, configuredEnv(db)),
      /Telegram sendMessage failed: temporarily unavailable/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(queued.acknowledged(), false);
});

test("provider command reports NVIDIA NIM and remains fail-closed until zero-cost eligibility is verified", async () => {
  const { db } = createDb();
  const update = telegramUpdate({ text: "/provider" });
  const queued = queueMessage(update);
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 102 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await worker.queue({ messages: [queued.message] }, configuredEnv(db, { AI: { run: async () => { throw new Error("must not run"); } } }));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.match(sent[0].text, /Provider: NVIDIA NIM/);
  assert.match(sent[0].text, /API key secret: missing/);
  assert.match(sent[0].text, /Model configured: no/);
  assert.match(sent[0].text, /Zero-cost eligibility: not confirmed/);
  assert.match(sent[0].text, /Inference: LOCKED by a missing configuration or runtime gate/);
  assert.match(sent[0].text, /Paid\/external fallback: none/);
});


test("owner /nvidia_status reports secret presence without revealing its value or invoking inference", async () => {
  const { db } = createDb();
  const update = telegramUpdate({ text: "/nvidia_status" });
  const queued = queueMessage(update);
  const sent = [];
  const secret = "never-print-this-nvidia-key";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 103 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await worker.queue({ messages: [queued.message] }, configuredEnv(db, {
      NVIDIA_NIM_API_KEY: secret,
      NVIDIA_NIM_MODEL: "test-model",
    }));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(queued.acknowledged(), true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /API key secret: present/);
  assert.match(sent[0].text, /Model: configured/);
  assert.match(sent[0].text, /Developer access review: missing or expired/);
  assert.match(sent[0].text, /Service: OFF \(default; fail-closed\)/);
  assert.doesNotMatch(sent[0].text, new RegExp(secret));
});


test("owner /remember accepts Telegram bot-addressed commands", async () => {
  const { db, statements } = createDb();
  const queued = queueMessage(telegramUpdate({
    text: "/remember@TransactraBot deployment.region Bengaluru",
  }));
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 122 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await worker.queue({ messages: [queued.message] }, configuredEnv(db));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(queued.acknowledged(), true);
  assert.match(sent[0].text, /Saved durable memory: deployment\.region/);
  assert.match(sent[0].text, /deployment\.region\nStored in Transactra D1/);
  assert.ok(statements.some((item) =>
    item.sql.includes("INSERT INTO agent_memory")
    && item.values[1] === OWNER_ID
    && item.values[2] === "deployment.region"
    && item.values[3] === "Bengaluru"));
});
