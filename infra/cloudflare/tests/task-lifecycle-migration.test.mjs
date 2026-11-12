import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../migrations");
const migrationFiles = [
  "0001_initial.sql",
  "0002_telegram_reply_outbox.sql",
  "0003_task_inbox.sql",
  "0004_task_run_ledger.sql",
  "0005_execution_plans_and_inference_quota.sql",
  "0006_pipeline_bridge.sql",
  "0007_task_lifecycle_states.sql",
  "0008_orchestrator_memory_recovery.sql",
  "0009_d1_native_approvals.sql",
  "0010_orchestrator_step_runs.sql",
  "0011_orchestrator_step_approvals.sql",
  "0012_telegram_business_message_outbox.sql",
  "0013_memory_lifecycle.sql",
  "0014_nvidia_runtime_control.sql",
  "0015_orchestrator_step_evidence.sql",
];

test("task lifecycle migration preserves ledger data, bridge metadata, indexes and foreign keys", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    for (const file of migrationFiles.slice(0, 6)) {
      db.exec(readFileSync(resolve(migrationsDir, file), "utf8"));
    }

    db.prepare(`INSERT INTO tasks
      (id,source,source_event_id,owner_id,description,status,created_at,updated_at,
       pipeline_task_id,approval_id,pipeline_status,pipeline_synced_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        "task-1", "telegram", "event-1", "owner-1", "migration fixture",
        "awaiting_provider", "2026-01-01", "2026-01-01",
        "planner-task-1", "approval-1", "pending", "2026-01-01"
      );
    db.prepare(`INSERT INTO task_runs
      (id,task_id,state,attempt_count,max_attempts,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(
        "run-1", "task-1", "queued", 1, 3, "2026-01-01", "2026-01-01"
      );
    db.prepare(`INSERT INTO task_events (task_id,event_type,detail,created_at)
      VALUES (?,?,?,?)`).run("task-1", "received", "persisted", "2026-01-01");
    db.prepare(`INSERT INTO task_run_events (run_id,event_type,detail,created_at)
      VALUES (?,?,?,?)`).run("run-1", "queued", "persisted", "2026-01-01");

    db.exec(readFileSync(resolve(migrationsDir, migrationFiles[6]), "utf8"));

    const preservedTask = db.prepare("SELECT id,pipeline_task_id,approval_id,pipeline_status,pipeline_synced_at FROM tasks WHERE id='task-1'").get();
    assert.equal(preservedTask.id, "task-1");
    assert.equal(preservedTask.pipeline_task_id, "planner-task-1");
    assert.equal(preservedTask.approval_id, "approval-1");
    assert.equal(preservedTask.pipeline_status, "pending");
    assert.equal(preservedTask.pipeline_synced_at, "2026-01-01");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_runs WHERE id='run-1' AND task_id='task-1' AND state='queued'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_events WHERE task_id='task-1' AND event_type='received'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_run_events WHERE run_id='run-1' AND event_type='queued'").get().count, 1);

    db.prepare("UPDATE tasks SET status=? WHERE id=?").run("waiting_approval", "task-1");
    db.prepare("UPDATE task_runs SET state=? WHERE id=?").run("awaiting_pipeline", "run-1");
    assert.equal(db.prepare("SELECT status FROM tasks WHERE id='task-1'").get().status, "waiting_approval");
    assert.equal(db.prepare("SELECT state FROM task_runs WHERE id='run-1'").get().state, "awaiting_pipeline");

    const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(row => row.name));
    for (const name of [
      "idx_tasks_status_created",
      "idx_tasks_pipeline_task_id",
      "idx_tasks_approval_id",
      "idx_task_runs_state_updated",
      "idx_task_events_task_created",
      "idx_task_events_task_type",
      "idx_task_run_events_run_created",
    ]) assert.ok(indexes.has(name), `missing index: ${name}`);

    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});

test("orchestrator and memory migration supports durable context, idempotent jobs and recovery leases", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    for (const file of migrationFiles) db.exec(readFileSync(resolve(migrationsDir, file), "utf8"));
    db.prepare(`INSERT INTO tasks (id,source,source_event_id,owner_id,description,status,created_at,updated_at)
      VALUES ('task-memory','telegram','event-memory','owner-1','memory fixture','awaiting_provider','2026-01-01','2026-01-01')`).run();
    db.prepare(`INSERT INTO agent_memory (id,owner_id,memory_key,memory_value,source,created_at,updated_at)
      VALUES ('mem-1','owner-1','project.preference','Use Cloudflare Free','telegram','2026-01-01','2026-01-01')`).run();
    db.prepare(`INSERT INTO task_memory (task_id,memory_id,memory_key,memory_value,captured_at)
      VALUES ('task-memory','mem-1','project.preference','Use Cloudflare Free','2026-01-01')`).run();
    db.prepare(`INSERT INTO orchestrator_jobs (id,task_id,status,attempt_count,max_attempts,next_attempt_at,created_at,updated_at)
      VALUES ('orch-1','task-memory','pending',0,5,'2026-01-01','2026-01-01','2026-01-01')`).run();
    db.prepare(`INSERT INTO orchestrator_events (job_id,task_id,event_type,detail,created_at)
      VALUES ('orch-1','task-memory','accepted','persisted','2026-01-01')`).run();

    const snapshot = db.prepare("SELECT memory_value FROM task_memory WHERE task_id='task-memory' AND memory_key='project.preference'").get();
    assert.equal(snapshot.memory_value, "Use Cloudflare Free");
    const job = db.prepare("SELECT status,attempt_count,max_attempts FROM orchestrator_jobs WHERE id='orch-1'").get();
    assert.deepEqual({ ...job }, { status: "pending", attempt_count: 0, max_attempts: 5 });

    db.prepare("UPDATE orchestrator_jobs SET status='leased',lease_token='lease-1',lease_until='2026-01-01T00:05:00Z',attempt_count=attempt_count+1 WHERE id='orch-1'").run();
    assert.equal(db.prepare("SELECT lease_token FROM orchestrator_jobs WHERE id='orch-1'").get().lease_token, "lease-1");
    db.prepare("UPDATE orchestrator_jobs SET status='retry',lease_token=NULL,lease_until=NULL,last_error='temporary',next_attempt_at='2026-01-01T00:10:00Z' WHERE id='orch-1' AND lease_token='lease-1'").run();
    assert.equal(db.prepare("SELECT status FROM orchestrator_jobs WHERE id='orch-1'").get().status, "retry");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});


test("step approval migration binds owner decisions to immutable durable actions", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    for (const file of migrationFiles) db.exec(readFileSync(resolve(migrationsDir, file), "utf8"));
    db.prepare(`INSERT INTO tasks (id,source,source_event_id,owner_id,description,status,created_at,updated_at)
      VALUES ('task-step','telegram','event-step','owner-1','step approval fixture','awaiting_provider','2026-01-01','2026-01-01')`).run();
    db.prepare(`INSERT INTO orchestrator_step_runs
      (id,task_id,step_id,sequence_no,agent,tool,status,attempt_count,input_json,created_at,updated_at)
      VALUES ('task-step:step-1','task-step','step-1',1,'builder','repository_write','needs_review',0,'{}','2026-01-01','2026-01-01')`).run();
    db.prepare(`INSERT INTO orchestrator_step_approvals
      (id,task_id,step_id,owner_id,status,action_hash,action_json,created_at,expires_at)
      VALUES ('approval-step-1','task-step','step-1','owner-1','pending',?,'{"version":1,"tool":"repository_write","input":{"path":"packages/example.ts"}}','2026-01-01','2026-01-02')`).run("a".repeat(64));
    assert.equal(db.prepare("SELECT status FROM orchestrator_step_approvals WHERE id='approval-step-1'").get().status, "pending");
    assert.throws(() => db.prepare(`INSERT INTO orchestrator_step_approvals
      (id,task_id,step_id,owner_id,status,action_hash,action_json,created_at,expires_at)
      VALUES ('approval-step-duplicate','task-step','step-1','owner-1','pending',?,'{}','2026-01-01','2026-01-02')`).run("b".repeat(64)), /UNIQUE constraint failed/);
    assert.throws(() => db.prepare(`INSERT INTO orchestrator_step_approvals
      (id,task_id,step_id,owner_id,status,action_hash,action_json,created_at,expires_at)
      VALUES ('approval-step-invalid','task-step','step-missing','owner-1','pending',?,'{}','2026-01-01','2026-01-02')`).run("c".repeat(64)), /FOREIGN KEY constraint failed/);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});
