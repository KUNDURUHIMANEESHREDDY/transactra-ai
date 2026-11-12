import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../src/index.mjs";
import { finalizeD1NativeCompletedJobs, processD1NativeApprovedJobs } from "../src/d1-agent-dispatch.mjs";
import { buildToolAction, hashToolAction } from "../src/tool-adapters.mjs";

function streamedNimResponse(content, promptTokens = 12, completionTokens = 5) {
  const model = "stepfun-ai/step-5-preview";
  const chunks = [
    { model, choices: [{ delta: { role: "assistant", content } }] },
    { model, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } }
  ];
  return new Response(JSON.stringify({ model, choices: [{ message: { content } }], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } }), { status: 200, headers: { "content-type": "application/json" } });
}

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../migrations");
const OWNER = "123456";
const BOT = "staging-test-bot";
const SECRET = "staging-test-secret";

function createD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const migrations = readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const migration of migrations) {
    sqlite.exec(readFileSync(resolve(migrationsDir, migration), "utf8"));
  }

  const DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let values = [];
      const wrapped = {
        bind(...nextValues) {
          values = nextValues;
          return wrapped;
        },
        async run() {
          const result = statement.run(...values);
          return {
            success: true,
            meta: {
              changes: Number(result.changes),
              last_row_id: Number(result.lastInsertRowid || 0),
            },
          };
        },
        async first() {
          return statement.get(...values) ?? null;
        },
        async all() {
          return { results: statement.all(...values) };
        },
        _statement: statement,
        _values: () => values,
      };
      return wrapped;
    },
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((item) => {
          const result = item._statement.run(...item._values());
          return {
            success: true,
            meta: {
              changes: Number(result.changes),
              last_row_id: Number(result.lastInsertRowid || 0),
            },
          };
        });
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };

  return { DB, sqlite, close: () => sqlite.close() };
}

function makeEnv(DB) {
  return {
    DB,
    EVENTS: { send: async () => {} },
    TELEGRAM_BOT_TOKEN: BOT,
    TELEGRAM_OWNER_ID: OWNER,
    TELEGRAM_WEBHOOK_SECRET: SECRET,
    TRANSACTRA_PLANNER_MODE: "d1-native",
  };
}

function queueMessage(text, updateId, extraMessage = {}) {
  let acknowledged = false;
  return {
    message: {
      body: {
        type: "telegram.update",
        updateId,
        receivedAt: new Date().toISOString(),
        payload: {
          update_id: updateId,
          message: {
            text,
            from: { id: OWNER },
            chat: { id: OWNER, type: "private" },
            ...extraMessage,
          },
        },
      },
      ack() {
        acknowledged = true;
      },
    },
    acknowledged: () => acknowledged,
  };
}

async function processTelegram(DB, text, updateId, fetchHandler, extraMessage = {}) {
  const item = queueMessage(text, updateId, extraMessage);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchHandler;
  try {
    await worker.queue({ messages: [item.message] }, makeEnv(DB));
  } finally {
    globalThis.fetch = originalFetch;
  }
  return item;
}

function telegramOk(sent) {
  return async (url, init) => {
    assert.equal(String(url), `https://api.telegram.org/bot${BOT}/sendMessage`);
    assert.equal(init.method, "POST");
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

async function createTask(DB, updateId, sent) {
  const item = await processTelegram(
    DB,
    "/task Verify the staging approval workflow",
    updateId,
    telegramOk(sent),
  );
  assert.equal(item.acknowledged(), true);
  const taskId = `tg-${updateId}`;
  const approval = DB.prepare("SELECT id,status FROM task_approvals WHERE task_id=?").bind(taskId);
  const result = await approval.first();
  assert.ok(result?.id);
  assert.equal(result.status, "pending");
  return { taskId, approvalId: result.id };
}

test("private topic routing: reply follows the topic created immediately before the message", async () => {
  const { DB, sqlite, close } = createD1();
  try {
    const sent = [];
    const topic = queueMessage(null, 700, {
      message_thread_id: 746,
      forum_topic_created: { name: "/help" },
    });
    await worker.queue({ messages: [topic.message] }, makeEnv(DB));
    assert.equal(topic.acknowledged(), true);

    const reply = await processTelegram(DB, "/help", 701, telegramOk(sent));
    assert.equal(reply.acknowledged(), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chat_id, OWNER);
    assert.equal(sent[0].message_thread_id, 746);
    assert.equal(sqlite.prepare("SELECT thread_id FROM telegram_reply_outbox WHERE update_id='701'").get().thread_id, 746);
  } finally {
    close();
  }
});

test("Telegram Business updates preserve the connection ID for replies", async () => {
  const { DB, sqlite, close } = createD1();
  try {
    const sent = [];
    const updateId = 709;
    const businessConnectionId = "business-connection-test";
    const item = queueMessage(null, updateId);
    item.message.body.payload = {
      update_id: updateId,
      business_message: {
        text: "/help",
        from: { id: OWNER },
        chat: { id: OWNER, type: "private" },
        business_connection_id: businessConnectionId,
      },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = telegramOk(sent);
    try {
      await worker.queue({ messages: [item.message] }, makeEnv(DB));
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(item.acknowledged(), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chat_id, OWNER);
    assert.equal(sent[0].business_connection_id, businessConnectionId);
    assert.equal(
      sqlite.prepare("SELECT business_connection_id FROM telegram_reply_outbox WHERE update_id=?").get(String(updateId)).business_connection_id,
      businessConnectionId,
    );
  } finally {
    close();
  }
});

test("status distinguishes stale Telegram ingress from configured NVIDIA planning and locked execution", async () => {
  const { DB, close } = createD1();
  try {
    const env = makeEnv(DB);
    env.TRANSACTRA_MODEL_ORCHESTRATOR_ENABLED = "true";
    env.NVIDIA_NIM_PLANNING_ENABLED = "true";
    env.NVIDIA_NIM_FREE_TIER_VERIFIED_AT = new Date().toISOString();
    env.NVIDIA_NIM_API_KEY = "test-key";
    env.NVIDIA_NIM_MODEL = "test-model";
    env.CLOUDPILOT_INFERENCE_URL = "https://cloudpilot-edge.himaneeshreddyk.workers.dev/chat/completions";
    env.CLOUDPILOT_INFERENCE_SECRET = "test-shared-secret-that-is-at-least-32-bytes";
    env.NVIDIA_NIM_EXECUTION_ENABLED = "false";
    env.TRANSACTRA_AGENT_EXECUTION_ENABLED = "false";
    const item = queueMessage("/status", 710);
    item.message.body.receivedAt = "2000-01-01T00:00:00.000Z";
    const sent = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = telegramOk(sent);
    try {
      await worker.queue({ messages: [item.message] }, env);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(item.acknowledged(), true);
    assert.match(sent[0].text, /Webhook: stale/);
    assert.match(sent[0].text, /CloudPilot inference: configured; live inference not yet proven/);
    assert.match(sent[0].text, /Agent execution: LOCKED/);
  } finally {
    close();
  }
});

test("live-path contract: duplicate Telegram delivery creates one task, approval, run, plan and orchestrator job", async () => {
  const { DB, sqlite, close } = createD1();
  try {
    const sent = [];
    const first = await processTelegram(
      DB,
      "/task Build a safe staging release checklist",
      701,
      telegramOk(sent),
    );
    const duplicate = await processTelegram(
      DB,
      "/task Build a safe staging release checklist",
      701,
      telegramOk(sent),
    );
    assert.equal(first.acknowledged(), true);
    assert.equal(duplicate.acknowledged(), true);
    assert.equal(sent.length, 1, "a sent outbox entry must not be delivered twice");

    for (const table of ["tasks", "task_approvals", "task_runs", "execution_plans", "orchestrator_jobs", "telegram_reply_outbox", "inbound_events"]) {
      const row = sqlite.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get();
      assert.equal(Number(row.total), 1, `${table} must contain exactly one idempotent record`);
    }
    assert.equal(sqlite.prepare("SELECT status FROM tasks WHERE id='tg-701'").get().status, "waiting_approval");
    assert.equal(sqlite.prepare("SELECT status FROM task_approvals WHERE task_id='tg-701'").get().status, "pending");
    assert.equal(sqlite.prepare("SELECT state FROM task_runs WHERE task_id='tg-701'").get().state, "waiting_approval");
    assert.equal(sqlite.prepare("SELECT status FROM orchestrator_jobs WHERE task_id='tg-701'").get().status, "blocked");
  } finally {
    close();
  }
});

test("approval acceptance: owner approval is atomic, audited and still cannot dispatch inference", async () => {
  const { DB, sqlite, close } = createD1();
  try {
    const sent = [];
    const { taskId, approvalId } = await createTask(DB, 702, sent);
    const decision = await processTelegram(
      DB,
      `/approve ${approvalId} staging-review-passed`,
      703,
      telegramOk(sent),
    );
    assert.equal(decision.acknowledged(), true);
    assert.match(sent.at(-1).text, /Execution remains blocked/);
    assert.equal(sqlite.prepare("SELECT status FROM task_approvals WHERE id=?").get(approvalId).status, "approved");
    assert.equal(sqlite.prepare("SELECT status FROM tasks WHERE id=?").get(taskId).status, "awaiting_provider");
    assert.equal(sqlite.prepare("SELECT state FROM task_runs WHERE task_id=?").get(taskId).state, "awaiting_provider");
    assert.equal(sqlite.prepare("SELECT status FROM execution_plans WHERE task_id=?").get(taskId).status, "approved");
    assert.equal(sqlite.prepare("SELECT status FROM orchestrator_jobs WHERE task_id=?").get(taskId).status, "blocked");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM task_events WHERE task_id=? AND event_type='task.approval_approved'").get(taskId).total, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM orchestrator_events WHERE task_id=? AND event_type='orchestrator.approval_approved'").get(taskId).total, 1);
  } finally {
    close();
  }
});

test("rejection acceptance: owner rejection cancels task, run, plan and orchestration job", async () => {
  const { DB, sqlite, close } = createD1();
  try {
    const sent = [];
    const { taskId, approvalId } = await createTask(DB, 704, sent);
    const decision = await processTelegram(
      DB,
      `/reject ${approvalId} rejected-during-staging-review`,
      705,
      telegramOk(sent),
    );
    assert.equal(decision.acknowledged(), true);
    assert.match(sent.at(-1).text, /task is cancelled/);
    assert.equal(sqlite.prepare("SELECT status FROM task_approvals WHERE id=?").get(approvalId).status, "rejected");
    assert.equal(sqlite.prepare("SELECT status FROM tasks WHERE id=?").get(taskId).status, "cancelled");
    assert.equal(sqlite.prepare("SELECT state FROM task_runs WHERE task_id=?").get(taskId).state, "cancelled");
    assert.equal(sqlite.prepare("SELECT status FROM execution_plans WHERE task_id=?").get(taskId).status, "rejected");
    assert.equal(sqlite.prepare("SELECT status FROM orchestrator_jobs WHERE task_id=?").get(taskId).status, "cancelled");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM task_events WHERE task_id=? AND event_type='task.approval_rejected'").get(taskId).total, 1);
  } finally {
    close();
  }
});

test("recovery acceptance: transient Telegram delivery failure is retried without duplicating task state", async () => {
  const { DB, sqlite, close } = createD1();
  try {
    const failed = queueMessage("/task Retry a failed Telegram delivery", 706);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      JSON.stringify({ ok: false, description: "temporary staging transport failure" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    try {
      await assert.rejects(
        worker.queue({ messages: [failed.message] }, makeEnv(DB)),
        /Telegram sendMessage failed/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(failed.acknowledged(), false);
    assert.equal(sqlite.prepare("SELECT status FROM telegram_reply_outbox WHERE update_id='706'").get().status, "pending");

    const sent = [];
    const retried = await processTelegram(
      DB,
      "/task Retry a failed Telegram delivery",
      706,
      telegramOk(sent),
    );
    assert.equal(retried.acknowledged(), true);
    assert.equal(sent.length, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM tasks WHERE id='tg-706'").get().total, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM task_approvals WHERE task_id='tg-706'").get().total, 1);
    assert.equal(sqlite.prepare("SELECT status FROM telegram_reply_outbox WHERE update_id='706'").get().status, "sent");
  } finally {
    close();
  }
});

test("recovery acceptance: expired owner approval is atomically expired and cannot execute", async () => {
  const { DB, sqlite, close } = createD1();
  try {
    const sent = [];
    const { taskId, approvalId } = await createTask(DB, 707, sent);
    const scheduledTime = Date.now() + 48 * 60 * 60 * 1000;
    let scheduledPromise;
    await worker.scheduled(
      { scheduledTime },
      makeEnv(DB),
      { waitUntil(promise) { scheduledPromise = promise; } },
    );
    await scheduledPromise;

    assert.equal(sqlite.prepare("SELECT status FROM task_approvals WHERE id=?").get(approvalId).status, "expired");
    assert.equal(sqlite.prepare("SELECT status FROM tasks WHERE id=?").get(taskId).status, "cancelled");
    assert.equal(sqlite.prepare("SELECT state FROM task_runs WHERE task_id=?").get(taskId).state, "cancelled");
    assert.equal(sqlite.prepare("SELECT status FROM execution_plans WHERE task_id=?").get(taskId).status, "rejected");
    assert.equal(sqlite.prepare("SELECT status FROM orchestrator_jobs WHERE task_id=?").get(taskId).status, "cancelled");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM task_events WHERE task_id=? AND event_type='task.approval_expired'").get(taskId).total, 1);
  } finally {
    close();
  }
});

test("staging readiness stays fail-closed until the D1-native approvals migration is present", async () => {
  const { DB, close } = createD1();
  try {
    const response = await worker.fetch(
      new Request("https://staging.test/ready"),
      makeEnv(DB),
    );
    const readinessBody = await response.json();
    assert.equal(response.status, 200, JSON.stringify(readinessBody));
    assert.deepEqual(readinessBody, {
      ok: true,
      service: "transactra-edge",
      ready: true,
      planner: "d1-native",
      inference: { status: "disabled", configured: false, runtime_enabled: false, developer_access_verified: false, zero_cost_verified: false, billing_mode: "nvidia_developer_program_free_endpoint", models: [], reason: "developer_access_unverified" },
      memory: { provider: "d1-fallback", mem0: "stale", checked_at: null },
    });
  } finally {
    close();
  }
});

function createStepApprovalFixture(sqlite, approvalId, taskId) {
  const now = new Date().toISOString();
  const action = {
    version: 1, step_id: "step-1", agent: "builder",
    description: "Write an approved source file",
    acceptance_criteria: "The exact file content is committed",
    risk: "high", tool: "repository_write",
    input: { path: "packages/example.ts", content: "export const value = 1;", message: "Add example", branch: "main" },
  };
  const actionJson = JSON.stringify(action);
  const actionHash = "a".repeat(64);
  sqlite.prepare(`INSERT INTO tasks (id,source,source_event_id,owner_id,description,status,created_at,updated_at)
    VALUES (?,?,?,?,?,'running',?,?)`).run(taskId,"telegram","step-"+taskId,OWNER,"Step approval acceptance fixture",now,now);
  sqlite.prepare(`INSERT INTO task_runs (id,task_id,state,attempt_count,max_attempts,created_at,updated_at)
    VALUES (?,?, 'running',0,3,?,?)`).run("run-"+taskId,taskId,now,now);
  sqlite.prepare(`INSERT INTO orchestrator_jobs (id,task_id,status,attempt_count,max_attempts,next_attempt_at,created_at,updated_at)
    VALUES (?,?, 'blocked',0,5,?,?,?)`).run("orch-"+taskId,taskId,now,now,now);
  sqlite.prepare(`INSERT INTO orchestrator_step_runs
    (id,task_id,step_id,sequence_no,agent,tool,status,attempt_count,input_json,created_at,updated_at)
    VALUES (?,?, 'step-1',1,'builder','repository_write','needs_review',0,?,?,?)`).run(taskId+":step-1",taskId,JSON.stringify({tool_input:action.input}),now,now);
  sqlite.prepare(`INSERT INTO orchestrator_step_approvals
    (id,task_id,step_id,owner_id,status,action_hash,action_json,created_at,expires_at)
    VALUES (?,?,'step-1',?,'pending',?,?,?,?)`).run(approvalId,taskId,OWNER,actionHash,actionJson,now,"2099-01-01T00:00:00.000Z");
  return { actionHash, actionJson };
}

test("step approval inspection returns the exact immutable action and its hash", async () => {
  const { DB, sqlite, close } = createD1();
  try {
    const approvalId = "81111111-1111-4111-8111-111111111111";
    const taskId = "tg-step-inspect";
    const { actionJson, actionHash } = createStepApprovalFixture(sqlite,approvalId,taskId);
    const sent = [];
    const item = await processTelegram(DB,"/step-approval "+approvalId,801,telegramOk(sent));
    assert.equal(item.acknowledged(),true);
    assert.match(sent.at(-1).text,/Exact immutable action:/);
    assert.ok(sent.at(-1).text.includes("packages/example.ts"));
    assert.ok(sent.at(-1).text.includes(actionJson));
    assert.match(sent.at(-1).text,new RegExp(actionHash));
  } finally { close(); }
});

test("step approval acceptance: hash-bound owner approval resumes only the reviewed step", async () => {
  const { DB, sqlite, close } = createD1();
  try {
    const approvalId = "82222222-2222-4222-8222-222222222222";
    const taskId = "tg-step-approved";
    const { actionHash } = createStepApprovalFixture(sqlite,approvalId,taskId);
    const sent = [];
    const item = await processTelegram(DB,"/approve-step "+approvalId+" "+actionHash.slice(0,16)+" reviewed-exact-file-write",802,telegramOk(sent));
    assert.equal(item.acknowledged(),true);
    assert.match(sent.at(-1).text,/Step approved/);
    assert.equal(sqlite.prepare("SELECT status FROM orchestrator_step_approvals WHERE id=?").get(approvalId).status,"approved");
    assert.equal(sqlite.prepare("SELECT status FROM orchestrator_step_runs WHERE task_id=? AND step_id='step-1'").get(taskId).status,"retry");
    assert.equal(sqlite.prepare("SELECT status FROM orchestrator_jobs WHERE task_id=?").get(taskId).status,"blocked");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM orchestrator_events WHERE task_id=? AND event_type='orchestrator.step_approved'").get(taskId).total,1);
  } finally { close(); }
});

test("step approval acceptance: wrong hash cannot approve and rejection cancels remaining execution", async () => {
  const { DB, sqlite, close } = createD1();
  try {
    const approvalId = "83333333-3333-4333-8333-333333333333";
    const taskId = "tg-step-rejected";
    const { actionHash } = createStepApprovalFixture(sqlite,approvalId,taskId);
    const sent = [];
    const wrong = await processTelegram(DB,"/approve-step "+approvalId+" "+"b".repeat(16)+" wrong-hash",803,telegramOk(sent));
    assert.equal(wrong.acknowledged(),true);
    assert.match(sent.at(-1).text,/Action hash does not match/);
    assert.equal(sqlite.prepare("SELECT status FROM orchestrator_step_approvals WHERE id=?").get(approvalId).status,"pending");

    const rejected = await processTelegram(DB,"/reject-step "+approvalId+" "+actionHash.slice(0,16)+" owner-rejected",804,telegramOk(sent));
    assert.equal(rejected.acknowledged(),true);
    assert.match(sent.at(-1).text,/remaining task execution are cancelled/);
    assert.equal(sqlite.prepare("SELECT status FROM orchestrator_step_approvals WHERE id=?").get(approvalId).status,"rejected");
    assert.equal(sqlite.prepare("SELECT status FROM orchestrator_step_runs WHERE task_id=? AND step_id='step-1'").get(taskId).status,"failed");
    assert.equal(sqlite.prepare("SELECT status FROM tasks WHERE id=?").get(taskId).status,"cancelled");
    assert.equal(sqlite.prepare("SELECT state FROM task_runs WHERE task_id=?").get(taskId).state,"cancelled");
    assert.equal(sqlite.prepare("SELECT status FROM orchestrator_jobs WHERE task_id=?").get(taskId).status,"cancelled");
  } finally { close(); }
});

test("step approval expiry keeps the step blocked and never dispatches its action", async () => {
  const { DB, sqlite, close } = createD1();
  try {
    const approvalId = "84444444-4444-4444-8444-444444444444";
    const taskId = "tg-step-expired";
    createStepApprovalFixture(sqlite,approvalId,taskId);
    sqlite.prepare("UPDATE orchestrator_step_approvals SET expires_at='2026-11-01T00:00:00.000Z' WHERE id=?").run(approvalId);
    let scheduledPromise;
    await worker.scheduled(
      { scheduledTime: Date.now() },
      makeEnv(DB),
      { waitUntil(promise) { scheduledPromise = promise; } },
    );
    await scheduledPromise;
    assert.equal(sqlite.prepare("SELECT status FROM orchestrator_step_approvals WHERE id=?").get(approvalId).status,"expired");
    assert.equal(sqlite.prepare("SELECT status FROM orchestrator_step_runs WHERE task_id=? AND step_id='step-1'").get(taskId).status,"needs_review");
    assert.equal(sqlite.prepare("SELECT status FROM orchestrator_jobs WHERE task_id=?").get(taskId).status,"blocked");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM orchestrator_events WHERE task_id=? AND event_type='orchestrator.step_approval_expired'").get(taskId).total,1);
  } finally { close(); }
});

function seedEvidenceFinalizationFixture(sqlite, taskId, acceptedEvidence) {
  const now = new Date().toISOString();
  const plan = {
    version: 2,
    title: "Evidence-backed completion fixture",
    objective: "Verify finalization requires persisted accepted evidence",
    steps: [{
      id: "step-1", agent: "analyst", tool: "none",
      description: "Verify a persisted result",
      acceptance_criteria: "A non-empty result has explicit accepted evaluator evidence",
      risk: "low", depends_on: [], tool_input: {},
    }],
  };
  sqlite.prepare("INSERT INTO tasks (id,source,source_event_id,owner_id,description,status,created_at,updated_at) VALUES (?,?,?,?,?,'running',?,?)")
    .run(taskId,"telegram","finalize-"+taskId,OWNER,"Evidence-backed completion fixture",now,now);
  sqlite.prepare("INSERT INTO task_approvals (id,task_id,owner_id,status,created_at,expires_at,decided_at) VALUES (?,?,?,'approved',?,?,?)")
    .run("approval-"+taskId,taskId,OWNER,now,"2099-01-01T00:00:00.000Z",now);
  sqlite.prepare("INSERT INTO task_runs (id,task_id,state,attempt_count,max_attempts,created_at,updated_at,started_at) VALUES (?,?, 'running',1,3,?,?,?)")
    .run("run-"+taskId,taskId,now,now,now);
  sqlite.prepare("INSERT INTO execution_plans (id,task_id,plan_version,provider,model,status,plan_json,created_at,updated_at) VALUES (?,?,1,'nvidia-nim','stepfun-ai/step-5-preview','approved',?,?,?)")
    .run("plan-"+taskId,taskId,JSON.stringify(plan),now,now);
  sqlite.prepare("INSERT INTO orchestrator_jobs (id,task_id,status,attempt_count,max_attempts,next_attempt_at,created_at,updated_at) VALUES (?,?,'blocked',0,5,?,?,?)")
    .run("job-"+taskId,taskId,now,now,now);
  sqlite.prepare("INSERT INTO orchestrator_step_runs (id,task_id,step_id,sequence_no,agent,tool,status,attempt_count,input_json,result_text,evaluation_json,created_at,updated_at,completed_at) VALUES (?,?, 'step-1',1,'analyst','none','succeeded',1,'{}','Verified result',?,?,?,?)")
    .run(taskId+":step-1",taskId,acceptedEvidence ? JSON.stringify({decision:"accepted",accepted:true,rationale:"Acceptance criteria verified against persisted result."}) : null,now,now,now);
}

test("evidence-backed finalizer completes approved tasks even while agent execution is locked", async () => {
  const { DB, sqlite, close } = createD1();
  try {
    seedEvidenceFinalizationFixture(sqlite,"tg-finalize-accepted",true);
    const result = await finalizeD1NativeCompletedJobs({DB,TELEGRAM_OWNER_ID:OWNER},new Date().toISOString());
    assert.deepEqual(result,{finalized:1});
    assert.equal(sqlite.prepare("SELECT status FROM tasks WHERE id=?").get("tg-finalize-accepted").status,"succeeded");
    assert.equal(sqlite.prepare("SELECT state FROM task_runs WHERE task_id=?").get("tg-finalize-accepted").state,"succeeded");
    assert.equal(sqlite.prepare("SELECT status FROM execution_plans WHERE task_id=?").get("tg-finalize-accepted").status,"completed");
    assert.equal(sqlite.prepare("SELECT status FROM orchestrator_jobs WHERE task_id=?").get("tg-finalize-accepted").status,"linked");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM orchestrator_events WHERE task_id=? AND event_type='orchestrator.completed'").get("tg-finalize-accepted").total,1);
  } finally { close(); }
});

test("duplicate scheduler finalizers cannot claim or complete the same task twice", async () => {
  const { DB, sqlite, close } = createD1();
  try {
    seedEvidenceFinalizationFixture(sqlite,"tg-finalize-concurrent",true);
    const now = new Date().toISOString();
    const [first,second] = await Promise.all([
      finalizeD1NativeCompletedJobs({DB,TELEGRAM_OWNER_ID:OWNER},now),
      finalizeD1NativeCompletedJobs({DB,TELEGRAM_OWNER_ID:OWNER},now),
    ]);
    assert.equal(first.finalized + second.finalized,1);
    assert.equal(sqlite.prepare("SELECT status FROM tasks WHERE id=?").get("tg-finalize-concurrent").status,"succeeded");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM orchestrator_events WHERE task_id=? AND event_type='orchestrator.completed'").get("tg-finalize-concurrent").total,1);
  } finally { close(); }
});

test("evidence-backed finalizer refuses a succeeded step without accepted evaluator evidence", async () => {
  const { DB, sqlite, close } = createD1();
  try {
    seedEvidenceFinalizationFixture(sqlite,"tg-finalize-missing-evidence",false);
    const result = await finalizeD1NativeCompletedJobs({DB,TELEGRAM_OWNER_ID:OWNER},new Date().toISOString());
    assert.deepEqual(result,{finalized:0});
    assert.equal(sqlite.prepare("SELECT status FROM tasks WHERE id=?").get("tg-finalize-missing-evidence").status,"running");
    assert.equal(sqlite.prepare("SELECT status FROM execution_plans WHERE task_id=?").get("tg-finalize-missing-evidence").status,"approved");
    assert.equal(sqlite.prepare("SELECT status FROM orchestrator_jobs WHERE task_id=?").get("tg-finalize-missing-evidence").status,"blocked");
  } finally { close(); }
});

async function seedApprovedDispatchFixture(sqlite, taskId, { expiredLease = false, approvalId = "step-approval-" + taskId, stepApprovalStatus = expiredLease ? "consumed" : "approved", stepStatus = "retry" } = {}) {
  const now = new Date().toISOString();
  const expiredAt = "2026-11-01T00:00:00.000Z";
  const step = {
    id: "step-1",
    agent: "builder",
    tool: "repository_write",
    description: "Write a reviewed staging test fixture",
    acceptance_criteria: "The approved source file is committed exactly once",
    risk: "high",
    depends_on: [],
    tool_input: {
      path: "packages/ambiguous-outcome-fixture.ts",
      content: "export const ambiguousOutcomeFixture = true;",
      message: "Add ambiguous outcome fixture",
      branch: "main",
      expected_sha: null,
    },
  };
  const plan = {
    version: 2,
    title: "Approved side-effect recovery fixture",
    objective: "Verify an ambiguous side effect is never replayed",
    steps: [step],
  };
  const action = buildToolAction(step);
  const actionJson = JSON.stringify(action);
  const actionHash = await hashToolAction(action);
  sqlite.prepare("INSERT INTO tasks (id,source,source_event_id,owner_id,description,status,created_at,updated_at) VALUES (?,'telegram',?,?,?,'awaiting_provider',?,?)")
    .run(taskId, "dispatch-" + taskId, OWNER, plan.objective, now, now);
  sqlite.prepare("INSERT INTO task_approvals (id,task_id,owner_id,status,created_at,expires_at,decided_at) VALUES (?,?,?,'approved',?,?,?)")
    .run("approval-" + taskId, taskId, OWNER, now, "2099-01-01T00:00:00.000Z", now);
  sqlite.prepare("INSERT INTO task_runs (id,task_id,state,attempt_count,max_attempts,created_at,updated_at,started_at) VALUES (?,?, 'awaiting_provider',0,3,?,?,?)")
    .run("run-" + taskId, taskId, now, now, now);
  sqlite.prepare("INSERT INTO execution_plans (id,task_id,plan_version,provider,model,status,plan_json,created_at,updated_at) VALUES (?,?,2,'nvidia-nim','stepfun-ai/step-5-preview','approved',?,?,?)")
    .run("plan-" + taskId, taskId, JSON.stringify(plan), now, now);
  sqlite.prepare("INSERT INTO orchestrator_jobs (id,task_id,status,attempt_count,max_attempts,next_attempt_at,created_at,updated_at) VALUES (?,?,'blocked',0,5,?,?,?)")
    .run("job-" + taskId, taskId, now, now, now);
  sqlite.prepare("INSERT INTO orchestrator_step_runs (id,task_id,step_id,sequence_no,agent,tool,status,attempt_count,input_json,created_at,updated_at) VALUES (?,?,?,1,?,?,?,0,?,?,?)")
    .run(taskId + ":step-1", taskId, step.id, step.agent, step.tool, stepStatus, JSON.stringify({ description: step.description, acceptance_criteria: step.acceptance_criteria, risk: step.risk, depends_on: [], tool_input: step.tool_input }), now, now);
  sqlite.prepare("INSERT INTO orchestrator_step_approvals (id,task_id,step_id,owner_id,status,action_hash,action_json,created_at,expires_at) VALUES (?,?,?,? ,?,?, ?,?,?)")
    .run(approvalId, taskId, step.id, OWNER, stepApprovalStatus, actionHash, actionJson, now, "2099-01-01T00:00:00.000Z");
  sqlite.prepare("INSERT INTO nvidia_runtime_control (owner_id,enabled,updated_by,updated_at) VALUES (?,1,?,?)")
    .run(OWNER, OWNER, now);
  if (expiredLease) {
    sqlite.prepare("UPDATE orchestrator_jobs SET status='leased',lease_token='expired-job-lease',lease_until=? WHERE task_id=?")
      .run(expiredAt, taskId);
    sqlite.prepare("UPDATE orchestrator_step_runs SET status='leased',lease_token='expired-step-lease',lease_until=? WHERE task_id=?")
      .run(expiredAt, taskId);
  }
  return { step, actionHash, approvalId };
}

const { privateKey: controlledGithubPrivateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

function controlledInferenceEnv(DB) {
  return {
    ...makeEnv(DB),
    TRANSACTRA_AGENT_EXECUTION_ENABLED: "true",
    NVIDIA_NIM_EXECUTION_ENABLED: "true",
    NVIDIA_NIM_API_KEY: "controlled-test-key",
    NVIDIA_NIM_MODEL: "stepfun-ai/step-5-preview",
    NVIDIA_NIM_ZERO_COST_LIMIT_INR: "0",
    NVIDIA_NIM_FREE_TIER_VERIFIED_AT: new Date().toISOString(),
    NVIDIA_NIM_TIMEOUT_MS: "1000",
    CLOUDPILOT_INFERENCE_SECRET: "x".repeat(40),
    GITHUB_APP_ID: "12345",
    GITHUB_APP_INSTALLATION_ID: "98765",
    GITHUB_APP_PRIVATE_KEY: controlledGithubPrivateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

test("rejected high-risk step remains terminal across duplicate scheduler invocations", async () => {
  const { DB, sqlite, close } = createD1();
  const originalFetch = globalThis.fetch;
  try {
    const taskId = "tg-rejected-step-no-resume";
    const approvalId = "85555555-5555-4555-8555-555555555555";
    const { actionHash } = await seedApprovedDispatchFixture(sqlite, taskId, { approvalId, stepApprovalStatus: "pending", stepStatus: "needs_review" });
    const sent = [];
    const rejected = await processTelegram(
      DB,
      "/reject-step " + approvalId + " " + actionHash.slice(0, 16) + " owner-rejected-high-risk-action",
      850,
      telegramOk(sent),
    );
    assert.equal(rejected.acknowledged(), true);
    assert.match(sent.at(-1).text, /remaining task execution are cancelled/);
    assert.equal(sqlite.prepare("SELECT status FROM orchestrator_step_approvals WHERE id=?").get(approvalId).status, "rejected");
    assert.equal(sqlite.prepare("SELECT status FROM orchestrator_step_runs WHERE task_id=?").get(taskId).status, "failed");
    assert.equal(sqlite.prepare("SELECT status FROM tasks WHERE id=?").get(taskId).status, "cancelled");
    assert.equal(sqlite.prepare("SELECT status FROM execution_plans WHERE task_id=?").get(taskId).status, "rejected");
    assert.equal(sqlite.prepare("SELECT status FROM orchestrator_jobs WHERE task_id=?").get(taskId).status, "cancelled");

    let outboundCalls = 0;
    globalThis.fetch = async () => {
      outboundCalls++;
      throw new Error("Rejected action must never reach inference or a tool adapter");
    };
    const env = controlledInferenceEnv(DB);
    await Promise.all([
      processD1NativeApprovedJobs(env, Date.now(), new Date().toISOString()),
      processD1NativeApprovedJobs(env, Date.now(), new Date().toISOString()),
    ]);
    assert.equal(outboundCalls, 0, "duplicate scheduler invocations must not revive a rejected step");
    assert.equal(sqlite.prepare("SELECT attempt_count FROM orchestrator_step_runs WHERE task_id=?").get(taskId).attempt_count, 0);
    assert.equal(sqlite.prepare("SELECT status FROM orchestrator_step_approvals WHERE id=?").get(approvalId).status, "rejected");
    assert.equal(sqlite.prepare("SELECT status FROM orchestrator_jobs WHERE task_id=?").get(taskId).status, "cancelled");
  } finally {
    globalThis.fetch = originalFetch;
    close();
  }
});

test("ambiguous approved side-effect outcomes are never replayed by duplicate or later scheduler runs", async () => {
  const { DB, sqlite, close } = createD1();
  const originalFetch = globalThis.fetch;
  try {
    const taskId = "tg-ambiguous-side-effect";
    await seedApprovedDispatchFixture(sqlite, taskId);
    const env = controlledInferenceEnv(DB);
    let inferenceCalls = 0;
    let prewriteChecks = 0;
    let writeAttempts = 0;
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.includes("/app/installations/")) return new Response(JSON.stringify({ token: "controlled-installation-token", permissions: { contents: "write", actions: "write" }, repositories: [{ full_name: "KUNDURUHIMANEESHREDDY/transactra" }] }), { status: 201 });
      if (url === "https://cloudpilot-edge.himaneeshreddyk.workers.dev/chat/completions") {
        inferenceCalls++;
        return streamedNimResponse("Preflight accepted for the already approved action.", 4, 3);
      }
      if (url.includes("/contents/packages/ambiguous-outcome-fixture.ts") && init.method === "GET") {
        prewriteChecks++;
        return new Response("Not Found", { status: 404 });
      }
      if (url.includes("/contents/packages/ambiguous-outcome-fixture.ts") && init.method === "PUT") {
        writeAttempts++;
        throw new TypeError("connection reset after GitHub may have accepted the write");
      }
      throw new Error("Unexpected outbound request in controlled inference test");
    };

    const now = new Date().toISOString();
    await Promise.all([
      processD1NativeApprovedJobs(env, Date.now(), now),
      processD1NativeApprovedJobs(env, Date.now(), now),
    ]);
    assert.equal(inferenceCalls, 1, "concurrent scheduler invocations must produce one provider preflight");
    assert.equal(prewriteChecks, 1, "the approved adapter action must be checked once");
    assert.equal(writeAttempts, 1, "the ambiguous write must be attempted once");
    assert.equal(sqlite.prepare("SELECT status FROM orchestrator_step_approvals WHERE task_id=?").get(taskId).status, "consumed");
    assert.equal(sqlite.prepare("SELECT status,attempt_count FROM orchestrator_step_runs WHERE task_id=?").get(taskId).status, "needs_review");
    assert.equal(sqlite.prepare("SELECT status FROM orchestrator_jobs WHERE task_id=?").get(taskId).status, "blocked");

    await processD1NativeApprovedJobs(env, Date.now(), new Date(Date.now() + 1000).toISOString());
    assert.equal(inferenceCalls, 1, "a later scheduler retry must not repeat an ambiguous provider request");
    assert.equal(writeAttempts, 1, "a later scheduler retry must not repeat the possibly completed side effect");
    assert.equal(sqlite.prepare("SELECT attempt_count FROM orchestrator_step_runs WHERE task_id=?").get(taskId).attempt_count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM orchestrator_events WHERE task_id=? AND event_type='orchestrator.agent_blocked'").get(taskId).total, 1);
  } finally {
    globalThis.fetch = originalFetch;
    close();
  }
});

test("expired orchestrator and step leases move in-flight work to review without replay", async () => {
  const { DB, sqlite, close } = createD1();
  const originalFetch = globalThis.fetch;
  try {
    const taskId = "tg-expired-agent-lease";
    await seedApprovedDispatchFixture(sqlite, taskId, { expiredLease: true });
    const env = controlledInferenceEnv(DB);
    let outboundCalls = 0;
    globalThis.fetch = async () => {
      outboundCalls++;
      throw new Error("No inference or tool request is expected after an expired lease");
    };

    const result = await processD1NativeApprovedJobs(env, Date.now(), new Date().toISOString());
    assert.deepEqual(result, { dispatched: 0 });
    assert.equal(sqlite.prepare("SELECT status FROM orchestrator_step_runs WHERE task_id=?").get(taskId).status, "needs_review");
    assert.equal(sqlite.prepare("SELECT status FROM orchestrator_jobs WHERE task_id=?").get(taskId).status, "blocked");
    assert.equal(sqlite.prepare("SELECT status FROM orchestrator_step_approvals WHERE task_id=?").get(taskId).status, "consumed");
    assert.equal(outboundCalls, 0, "expired leases must never trigger inference or a tool adapter");
  } finally {
    globalThis.fetch = originalFetch;
    close();
  }
});

test("controlled inference executes the exact owner-approved agent action and finalizes accepted evidence", async () => {
  const { DB, sqlite, close } = createD1();
  const originalFetch = globalThis.fetch;
  try {
    const taskId = "tg-controlled-approved-execution";
    await seedApprovedDispatchFixture(sqlite, taskId);
    const env = controlledInferenceEnv(DB);
    let inferenceCalls = 0;
    let prewriteChecks = 0;
    let writeCompletions = 0;
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.includes("/app/installations/")) return new Response(JSON.stringify({ token: "controlled-installation-token", permissions: { contents: "write", actions: "write" }, repositories: [{ full_name: "KUNDURUHIMANEESHREDDY/transactra" }] }), { status: 201 });
      if (url === "https://cloudpilot-edge.himaneeshreddyk.workers.dev/chat/completions") {
        inferenceCalls++;
        return streamedNimResponse("Provider preflight accepted for the owner-approved action.", 4, 3);
      }
      if (url.includes("/contents/packages/ambiguous-outcome-fixture.ts") && init.method === "GET") {
        prewriteChecks++;
        return new Response("Not Found", { status: 404 });
      }
      if (url.includes("/contents/packages/ambiguous-outcome-fixture.ts") && init.method === "PUT") {
        writeCompletions++;
        return new Response(JSON.stringify({
          commit: { sha: "a".repeat(40) },
          content: { html_url: "https://github.com/KUNDURUHIMANEESHREDDY/transactra/blob/main/packages/ambiguous-outcome-fixture.ts" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error("Unexpected outbound request in controlled inference test");
    };

    const now = new Date().toISOString();
    const dispatch = await processD1NativeApprovedJobs(env, Date.now(), now);
    assert.deepEqual(dispatch, { dispatched: 1 });
    assert.equal(inferenceCalls, 1);
    assert.equal(prewriteChecks, 1);
    assert.equal(writeCompletions, 1);
    const step = sqlite.prepare("SELECT status,attempt_count,result_text,evaluation_json FROM orchestrator_step_runs WHERE task_id=?").get(taskId);
    assert.equal(step.status, "succeeded");
    assert.equal(step.attempt_count, 1);
    assert.match(step.result_text, /repository_write/);
    assert.deepEqual(JSON.parse(step.evaluation_json), {
      decision: "accepted",
      accepted: true,
      rationale: "The exact owner-approved tool action completed and returned a verifiable adapter response.",
      evidence_required: [],
    });
    assert.equal(sqlite.prepare("SELECT status FROM orchestrator_step_approvals WHERE task_id=?").get(taskId).status, "consumed");
    assert.equal(sqlite.prepare("SELECT status FROM tasks WHERE id=?").get(taskId).status, "running");

    const finalized = await finalizeD1NativeCompletedJobs({ DB, TELEGRAM_OWNER_ID: OWNER }, new Date(Date.now() + 1000).toISOString());
    assert.deepEqual(finalized, { finalized: 1 });
    assert.equal(sqlite.prepare("SELECT status FROM tasks WHERE id=?").get(taskId).status, "succeeded");
    assert.equal(sqlite.prepare("SELECT status FROM execution_plans WHERE task_id=?").get(taskId).status, "completed");
    assert.equal(sqlite.prepare("SELECT status FROM orchestrator_jobs WHERE task_id=?").get(taskId).status, "linked");
  } finally {
    globalThis.fetch = originalFetch;
    close();
  }
});
