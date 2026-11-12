import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const baseUrl = required("CLOUDFLARE_STAGING_BASE_URL").replace(/\/$/, "");
const botToken = required("TELEGRAM_BOT_TOKEN");
const webhookSecret = required("TELEGRAM_WEBHOOK_SECRET");
const accountId = required("CLOUDFLARE_ACCOUNT_ID");
const apiToken = required("CLOUDFLARE_API_TOKEN");
const databaseId = "e7292f55-c90e-4d34-8b77-c97c3e5ec15a";
const ownerId = Number(required("TELEGRAM_OWNER_ID"));
assert.ok(Number.isSafeInteger(ownerId) && ownerId > 0, "TELEGRAM_OWNER_ID must be a positive Telegram numeric ID");

let nextUpdateId = Date.now() * 10;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error("Missing required staging environment variable: " + name);
  return value.trim();
}

async function d1(sql, params = []) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer " + apiToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) throw new Error("Staging D1 query failed with HTTP " + response.status);
  const payload = await response.json();
  if (!payload.success) throw new Error("Staging D1 rejected an acceptance query");
  return payload.result?.[0]?.results ?? [];
}

async function waitFor(label, read, verify, timeoutMs = 30000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await read();
    if (verify(last)) return last;
    await pause(500);
  }
  throw new Error("Timed out waiting for staging acceptance condition: " + label + "; last state=" + JSON.stringify(last));
}

async function postTelegramUpdate(text, updateId) {
  const update = {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: ownerId, is_bot: false, first_name: "Transactra staging acceptance" },
      chat: { id: ownerId, type: "private" },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
  const response = await fetch(baseUrl + "/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": webhookSecret,
    },
    body: JSON.stringify(update),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 202, "staging webhook must accept a signed synthetic Telegram update");
  const payload = await response.json();
  assert.equal(payload.ok, true);
}

async function postCommand(text) {
  const updateId = ++nextUpdateId;
  await postTelegramUpdate(text, updateId);
  await waitFor("Telegram command reply delivered " + updateId, async () =>
    d1("SELECT status FROM telegram_reply_outbox WHERE update_id=?", [String(updateId)]),
    (rows) => rows.length === 1 && rows[0].status === "sent");
  return updateId;
}

async function createTask(label, duplicate = false) {
  const updateId = ++nextUpdateId;
  const taskId = "tg-" + updateId;
  const text = "/task " + label + " [" + updateId + "]";
  await postTelegramUpdate(text, updateId);
  if (duplicate) await postTelegramUpdate(text, updateId);

  const joined = await waitFor("task and approval persistence " + taskId, async () =>
    d1(
      "SELECT t.id,t.status,a.id AS approval_id,a.status AS approval_status FROM tasks t JOIN task_approvals a ON a.task_id=t.id WHERE t.id=?",
      [taskId],
    ), (rows) => rows.length === 1 && rows[0].approval_id);
  assert.equal(joined.length, 1);
  assert.equal(joined[0].status, "waiting_approval");
  assert.equal(joined[0].approval_status, "pending");

  await waitFor("Telegram reply outbox sent " + updateId, async () =>
    d1("SELECT status FROM telegram_reply_outbox WHERE update_id=?", [String(updateId)]),
    (rows) => rows.length === 1 && rows[0].status === "sent");

  if (duplicate) {
    const countChecks = [
      ["tasks", "SELECT COUNT(*) AS total FROM tasks WHERE id=?", taskId],
      ["task_approvals", "SELECT COUNT(*) AS total FROM task_approvals WHERE task_id=?", taskId],
      ["task_runs", "SELECT COUNT(*) AS total FROM task_runs WHERE task_id=?", taskId],
      ["execution_plans", "SELECT COUNT(*) AS total FROM execution_plans WHERE task_id=?", taskId],
      ["orchestrator_jobs", "SELECT COUNT(*) AS total FROM orchestrator_jobs WHERE task_id=?", taskId],
      ["telegram_reply_outbox", "SELECT COUNT(*) AS total FROM telegram_reply_outbox WHERE update_id=?", String(updateId)],
      ["inbound_events", "SELECT COUNT(*) AS total FROM inbound_events WHERE source='telegram' AND source_event_id=?", String(updateId)],
    ];
    for (const [table, sql, value] of countChecks) {
      const rows = await d1(sql, [value]);
      assert.equal(Number(rows[0]?.total), 1, "duplicate delivery must create exactly one " + table + " record");
    }
  }
  return { taskId, approvalId: joined[0].approval_id };
}

async function createPendingStepApproval(taskId, stepId, sequenceNo) {
  const now = new Date().toISOString();
  const approvalId = randomUUID();
  const description = "Create an owner-reviewed staging acceptance fixture";
  const acceptanceCriteria = "The exact approved action is recorded without execution";
  const toolInput = {
    path: "packages/staging-acceptance-" + stepId + ".ts",
    content: "export const stagingAcceptance = true;",
    message: "Add staging acceptance fixture",
    branch: "main",
    expected_sha: null,
  };
  const action = {
    version: 1,
    step_id: stepId,
    agent: "builder",
    description,
    acceptance_criteria: acceptanceCriteria,
    risk: "high",
    tool: "repository_write",
    input: toolInput,
  };
  const actionJson = JSON.stringify(action);
  const actionHash = createHash("sha256").update(actionJson, "utf8").digest("hex");
  const inputJson = JSON.stringify({
    description,
    acceptance_criteria: acceptanceCriteria,
    risk: "high",
    depends_on: sequenceNo > 1 ? [sequenceNo - 1] : [],
    tool_input: toolInput,
  });
  await d1(
    "INSERT INTO orchestrator_step_runs (id,task_id,step_id,sequence_no,agent,tool,status,attempt_count,input_json,created_at,updated_at) VALUES (?,?,?,?,?,?,'needs_review',0,?,?,?)",
    [taskId + ":" + stepId, taskId, stepId, sequenceNo, "builder", "repository_write", inputJson, now, now],
  );
  await d1(
    "INSERT INTO orchestrator_step_approvals (id,task_id,step_id,owner_id,status,action_hash,action_json,created_at,expires_at) VALUES (?,?,?,?,'pending',?,?,?,?)",
    [approvalId, taskId, stepId, String(ownerId), actionHash, actionJson, now, new Date(Date.now() + 86400000).toISOString()],
  );
  return { approvalId, actionHash, actionJson };
}

async function main() {
  const chatResponse = await fetch(
    `https://api.telegram.org/bot${botToken}/getChat?chat_id=${ownerId}`,
    { signal: AbortSignal.timeout(10000) },
  );
  const chatPayload = await chatResponse.json();
  if (!chatResponse.ok || chatPayload.ok !== true) {
    throw new Error("Open the dedicated staging bot in Telegram and send /start before running staging acceptance");
  }

  const health = await fetch(baseUrl + "/health", { signal: AbortSignal.timeout(10000) });
  assert.equal(health.status, 200, "staging /health must return 200");
  const ready = await fetch(baseUrl + "/ready", { signal: AbortSignal.timeout(10000) });
  assert.equal(ready.status, 200, "staging /ready must return 200 after migrations 0001–0015");
  const readiness = await ready.json();
  assert.equal(readiness.ready, true);
  assert.equal(readiness.planner, "d1-native");
  assert.equal(readiness.inference, "disabled");

  const memoryTables = await d1("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('memory_usage_monthly','memory_compaction_state','memory_archives','memory_sync_outbox') ORDER BY name");
  assert.deepEqual(memoryTables.map((row) => row.name), ["memory_archives", "memory_compaction_state", "memory_sync_outbox", "memory_usage_monthly"], "memory lifecycle migration 0013 must be applied");

  const memoryKey = "staging.acceptance." + randomUUID().replaceAll("-", "").slice(0, 12);
  const rememberUpdate = await postCommand("/remember " + memoryKey + " Staging memory lifecycle acceptance fixture");
  const savedMemory = await waitFor("D1 owner memory write " + memoryKey, async () =>
    d1("SELECT memory_key,memory_value FROM agent_memory WHERE owner_id=? AND memory_key=?", [String(ownerId), memoryKey]),
    (rows) => rows.length === 1 && rows[0].memory_value === "Staging memory lifecycle acceptance fixture");
  assert.equal(savedMemory[0].memory_key, memoryKey);
  const syncRows = await d1("SELECT status FROM memory_sync_outbox WHERE owner_id=? AND memory_key=? ORDER BY created_at DESC LIMIT 1", [String(ownerId), memoryKey]);
  assert.equal(syncRows.length, 1, "D1 memory writes must create a durable Mem0 sync outbox row");
  const memoryStatusUpdate = await postCommand("/memory-status");
  const memoryStatusReply = await d1("SELECT reply_text FROM telegram_reply_outbox WHERE update_id=?", [String(memoryStatusUpdate)]);
  assert.equal(memoryStatusReply.length, 1);
  assert.match(memoryStatusReply[0].reply_text, /D1 remains canonical/);
  assert.ok(rememberUpdate > 0);

  const duplicateTask = await createTask("staging duplicate-delivery recovery acceptance", true);
  await postCommand("/approve " + duplicateTask.approvalId + " staging-acceptance-approved");
  const approved = await waitFor("approved task remains blocked " + duplicateTask.taskId, async () =>
    d1(
      "SELECT t.status,a.status AS approval_status,r.state AS run_state,p.status AS plan_status,j.status AS job_status FROM tasks t JOIN task_approvals a ON a.task_id=t.id JOIN task_runs r ON r.task_id=t.id JOIN execution_plans p ON p.task_id=t.id JOIN orchestrator_jobs j ON j.task_id=t.id WHERE t.id=?",
      [duplicateTask.taskId],
    ), (rows) => rows.length === 1 && rows[0].approval_status === "approved");
  assert.deepEqual(
    {
      task: approved[0].status,
      approval: approved[0].approval_status,
      run: approved[0].run_state,
      plan: approved[0].plan_status,
      job: approved[0].job_status,
    },
    { task: "awaiting_provider", approval: "approved", run: "awaiting_provider", plan: "approved", job: "blocked" },
    "approval must be recorded but must not dispatch execution while inference is disabled",
  );

  const stepLedger = await d1("SELECT COUNT(*) AS total FROM orchestrator_step_runs WHERE task_id=?", [duplicateTask.taskId]);
  assert.equal(Number(stepLedger[0]?.total), 0, "approval must not create or dispatch agent steps while execution gates are disabled");

  const stepOne = await createPendingStepApproval(duplicateTask.taskId, "step-1", 1);
  const listUpdate = await postCommand("/step-approvals");
  const listReply = await d1("SELECT reply_text FROM telegram_reply_outbox WHERE update_id=?", [String(listUpdate)]);
  assert.ok(String(listReply[0]?.reply_text || "").includes(stepOne.approvalId), "step approval list must show the pending approval");

  const inspectUpdate = await postCommand("/step-approval " + stepOne.approvalId);
  const inspectReply = await d1("SELECT reply_text FROM telegram_reply_outbox WHERE update_id=?", [String(inspectUpdate)]);
  assert.ok(String(inspectReply[0]?.reply_text || "").includes(stepOne.actionJson), "step inspection must return the exact immutable action");
  assert.ok(String(inspectReply[0]?.reply_text || "").includes(stepOne.actionHash), "step inspection must return the exact action hash");

  const wrongHashUpdate = await postCommand("/approve-step " + stepOne.approvalId + " " + "b".repeat(16) + " wrong-hash-test");
  const wrongHashReply = await d1("SELECT reply_text FROM telegram_reply_outbox WHERE update_id=?", [String(wrongHashUpdate)]);
  assert.match(String(wrongHashReply[0]?.reply_text || ""), /Action hash does not match/);
  const unchangedStep = await d1("SELECT status FROM orchestrator_step_approvals WHERE id=?", [stepOne.approvalId]);
  assert.equal(unchangedStep[0]?.status, "pending", "a mismatched hash must not approve the action");

  const approveStepUpdate = await postCommand("/approve-step " + stepOne.approvalId + " " + stepOne.actionHash.slice(0, 16) + " staging-step-approved");
  const approveStepReply = await d1("SELECT reply_text FROM telegram_reply_outbox WHERE update_id=?", [String(approveStepUpdate)]);
  assert.match(String(approveStepReply[0]?.reply_text || ""), /exact approved action is queued/);
  await waitFor("per-step owner approval and resume state", async () =>
    d1("SELECT a.status,s.status AS step_status,j.status AS job_status FROM orchestrator_step_approvals a JOIN orchestrator_step_runs s ON s.task_id=a.task_id AND s.step_id=a.step_id JOIN orchestrator_jobs j ON j.task_id=a.task_id WHERE a.id=?", [stepOne.approvalId]),
    (rows) => rows.length === 1 && rows[0].status === "approved" && rows[0].step_status === "retry" && rows[0].job_status === "blocked");

  const stepTwo = await createPendingStepApproval(duplicateTask.taskId, "step-2", 2);
  const rejectStepUpdate = await postCommand("/reject-step " + stepTwo.approvalId + " " + stepTwo.actionHash.slice(0, 16) + " staging-step-rejected");
  const rejectStepReply = await d1("SELECT reply_text FROM telegram_reply_outbox WHERE update_id=?", [String(rejectStepUpdate)]);
  assert.match(String(rejectStepReply[0]?.reply_text || ""), /remaining task execution are cancelled/);
  const stepRejected = await waitFor("per-step rejection cancels remaining task work", async () =>
    d1("SELECT a.status,s.status AS step_status,t.status AS task_status,r.state AS run_state,p.status AS plan_status,j.status AS job_status FROM orchestrator_step_approvals a JOIN orchestrator_step_runs s ON s.task_id=a.task_id AND s.step_id=a.step_id JOIN tasks t ON t.id=a.task_id JOIN task_runs r ON r.task_id=t.id JOIN execution_plans p ON p.task_id=t.id JOIN orchestrator_jobs j ON j.task_id=t.id WHERE a.id=?", [stepTwo.approvalId]),
    (rows) => rows.length === 1 && rows[0].status === "rejected");
  assert.deepEqual({
    approval: stepRejected[0].status,
    step: stepRejected[0].step_status,
    task: stepRejected[0].task_status,
    run: stepRejected[0].run_state,
    plan: stepRejected[0].plan_status,
    job: stepRejected[0].job_status,
  }, {
    approval: "rejected", step: "failed", task: "cancelled", run: "cancelled", plan: "rejected", job: "cancelled",
  });

  const rejectedTask = await createTask("staging rejection acceptance");
  await postCommand("/reject " + rejectedTask.approvalId + " staging-acceptance-rejected");
  const rejected = await waitFor("rejected task is cancelled " + rejectedTask.taskId, async () =>
    d1(
      "SELECT t.status,a.status AS approval_status,r.state AS run_state,p.status AS plan_status,j.status AS job_status FROM tasks t JOIN task_approvals a ON a.task_id=t.id JOIN task_runs r ON r.task_id=t.id JOIN execution_plans p ON p.task_id=t.id JOIN orchestrator_jobs j ON j.task_id=t.id WHERE t.id=?",
      [rejectedTask.taskId],
    ), (rows) => rows.length === 1 && rows[0].approval_status === "rejected");
  assert.deepEqual(
    {
      task: rejected[0].status,
      approval: rejected[0].approval_status,
      run: rejected[0].run_state,
      plan: rejected[0].plan_status,
      job: rejected[0].job_status,
    },
    { task: "cancelled", approval: "rejected", run: "cancelled", plan: "rejected", job: "cancelled" },
  );

  console.log("STAGING_ACCEPTANCE_OK: health, readiness, task creation, task approval/rejection, per-step inspection/hash approval/resume/rejection, duplicate-delivery recovery, D1 persistence and execution lock verified.");
  console.log("Synthetic acceptance messages were delivered to the staging Telegram chat. No inference or production resource was used; agent dispatch remained locked.");
}

main().catch((error) => {
  console.error("STAGING_ACCEPTANCE_FAILED:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
