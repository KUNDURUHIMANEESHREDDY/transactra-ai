import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { compactOwnerMemory, getMemoryStatus, enqueueMem0Memory, processMemorySyncOutbox, searchMem0Memory, forgetMem0Memory } from "../src/memory-lifecycle.mjs";

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

function asD1(database) {
  return {
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...args) { values = args; return statement; },
        async run() {
          const result = database.prepare(sql).run(...values);
          return { success: true, meta: { changes: result.changes } };
        },
        async all() { return { results: database.prepare(sql).all(...values) }; },
        async first() { return database.prepare(sql).get(...values) ?? null; },
      };
      return statement;
    },
  };
}

function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  for (const file of migrationFiles) database.exec(readFileSync(resolve(migrationsDir, file), "utf8"));
  database.prepare(`INSERT INTO tasks
    (id,source,source_event_id,owner_id,description,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
      "task-1", "telegram", "event-1", "owner-1", "Finish Transactra memory lifecycle",
      "awaiting_provider", "2026-11-01T00:00:00.000Z", "2026-11-09T00:00:00.000Z"
    );
  database.prepare("INSERT INTO agent_memory (id,owner_id,memory_key,memory_value,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run("mem-1", "owner-1", "project.database", "Cloudflare D1 is canonical; API_KEY=should-not-leak", "telegram", "2026-11-01", "2026-11-09");
  database.prepare("INSERT INTO task_memory (task_id,memory_id,memory_key,memory_value,captured_at) VALUES (?,?,?,?,?)")
    .run("task-1", "mem-1", "project.database", "Cloudflare D1 is canonical; API_KEY=should-not-leak", "2026-11-02");
  database.prepare("INSERT INTO agent_memory (id,owner_id,memory_key,memory_value,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run("mem-old-summary", "owner-1", "transactra.compacted_summary", "OLD SUMMARY MUST NOT RECURSE", "automatic_compaction", "2026-11-01", "2026-11-08");
  database.prepare("INSERT INTO task_events (task_id,event_type,detail,created_at) VALUES (?,?,?,?)")
    .run("task-1", "task.completed", "Memory lifecycle implementation was verified", "2026-11-09T00:00:00.000Z");
  database.prepare("INSERT INTO orchestrator_jobs (id,task_id,status,attempt_count,max_attempts,next_attempt_at,created_at,updated_at) VALUES (?,?,?,0,5,?,?,?)")
    .run("job-1", "task-1", "blocked", "2026-11-09", "2026-11-09", "2026-11-09");
  return { database, db: asD1(database) };
}

test("memory lifecycle migration is additive and preserves archived generations", () => {
  const migration = readFileSync(resolve(migrationsDir, "0013_memory_lifecycle.sql"), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS memory_usage_monthly/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS memory_compaction_state/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS memory_archives/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS memory_sync_outbox/);
  assert.match(migration, /processing/);
  assert.match(migration, /provider_event_id TEXT/);
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM|ALTER TABLE .*DROP/i);
});

test("threshold compaction archives a complete D1 snapshot before replacing active memory", async () => {
  const { database, db } = fixture();
  try {
    database.prepare("INSERT INTO memory_usage_monthly (owner_id,month_key,additions,retrievals) VALUES (?,?,?,?)")
      .run("owner-1", "2026-11", 7000, 0);
    const result = await compactOwnerMemory(db, {
      MEM0_MONTHLY_ADDITION_LIMIT: "10000",
      MEM0_MONTHLY_RETRIEVAL_LIMIT: "1000",
      MEM0_COMPACTION_THRESHOLD_PERCENT: "70",
    }, "owner-1", "2026-11-09T12:00:00.000Z");
    assert.equal(result.compacted, true);
    assert.equal(result.generation, 2);
    assert.equal(result.counts.tasks, 1);
    assert.equal(result.counts.task_events, 1);
    assert.equal(result.mem0Seed, "queued_for_next_month");

    const archive = database.prepare("SELECT summary,summary_hash FROM memory_archives WHERE owner_id='owner-1' AND generation=2").get();
    assert.match(archive.summary, /Finish Transactra memory lifecycle/);
    assert.match(archive.summary, /Memory lifecycle implementation was verified/);
    assert.match(archive.summary, /Cloudflare D1 is canonical/);
    assert.doesNotMatch(archive.summary, /OLD SUMMARY MUST NOT RECURSE/);
    assert.match(archive.summary, /API_KEY=\[REDACTED_SECRET\]/);
    assert.doesNotMatch(archive.summary, /should-not-leak/);
    assert.match(archive.summary, /task-1 project.database/);
    assert.ok(archive.summary_hash.length >= 16);
    assert.equal(database.prepare("SELECT COUNT(*) AS total FROM task_events WHERE task_id='task-1'").get().total, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS total FROM memory_archives WHERE owner_id='owner-1'").get().total, 1);
    const active = database.prepare("SELECT memory_value,source FROM agent_memory WHERE owner_id='owner-1' AND memory_key='transactra.compacted_summary'").get();
    assert.match(active.memory_value, /Transactra compacted operational memory/);
    assert.equal(active.source, "automatic_compaction");
    const status = await getMemoryStatus(db, {}, "owner-1", "2026-11-09T12:00:00.000Z");
    assert.equal(status.mem0Paused, true);
    assert.equal(status.activeGeneration, 2);
    assert.equal(status.archives, 1);
    const repeated = await compactOwnerMemory(db, {
      MEM0_MONTHLY_ADDITION_LIMIT: "10000",
      MEM0_MONTHLY_RETRIEVAL_LIMIT: "1000",
      MEM0_COMPACTION_THRESHOLD_PERCENT: "70",
    }, "owner-1", "2026-11-09T12:01:00.000Z");
    assert.equal(repeated.compacted, false);
    assert.equal(database.prepare("SELECT COUNT(*) AS total FROM memory_archives WHERE owner_id=?").get("owner-1").total, 1);
  } finally {
    database.close();
  }
});

test("compaction resumes from an existing archive after an interrupted prior attempt", async () => {
  const { database, db } = fixture();
  try {
    database.prepare("INSERT INTO memory_usage_monthly (owner_id,month_key,additions,retrievals) VALUES (?,?,?,?)")
      .run("owner-1", "2026-11", 7000, 0);
    database.prepare("INSERT INTO memory_archives (id,owner_id,generation,summary,summary_hash,source_counts_json,created_at) VALUES (?,?,?,?,?,?,?)")
      .run("archive-existing", "owner-1", 2, "# Previously committed snapshot", "existing-digest", "{}", "2026-11-09T11:59:00.000Z");
    const result = await compactOwnerMemory(db, {
      MEM0_MONTHLY_ADDITION_LIMIT: "10000",
      MEM0_MONTHLY_RETRIEVAL_LIMIT: "1000",
      MEM0_COMPACTION_THRESHOLD_PERCENT: "70",
    }, "owner-1", "2026-11-09T12:00:00.000Z");
    assert.equal(result.compacted, true);
    assert.equal(result.archiveId, "archive-existing");
    assert.equal(result.summaryHash, "existing-digest");
    const active = database.prepare("SELECT memory_value FROM agent_memory WHERE owner_id=? AND memory_key=?")
      .get("owner-1", "transactra.compacted_summary");
    assert.equal(active.memory_value, "# Previously committed snapshot");
    assert.equal(database.prepare("SELECT COUNT(*) AS total FROM memory_archives WHERE owner_id=?").get("owner-1").total, 1);
  } finally {
    database.close();
  }
});

test("Mem0 sync outbox deduplicates Telegram events and reclaims expired leases", async () => {
  const { database, db } = fixture();
  const originalFetch = globalThis.fetch;
  const now = "2026-11-09T12:00:00.000Z";
  try {
    const first = await enqueueMem0Memory(db, "owner-1", "project.preference", "Keep D1 canonical", now, "telegram:42");
    const duplicate = await enqueueMem0Memory(db, "owner-1", "project.preference", "Keep D1 canonical", now, "telegram:42");
    assert.equal(first, duplicate);
    assert.equal(database.prepare("SELECT COUNT(*) AS total FROM memory_sync_outbox WHERE owner_id='owner-1'").get().total, 1);

    database.prepare("UPDATE memory_sync_outbox SET status='leased',lease_token='stale',lease_until=? WHERE id=?")
      .run("2026-11-09T11:00:00.000Z", first);
    let requestCount = 0;
    globalThis.fetch = async (url, init) => {
      requestCount += 1;
      assert.equal(init.headers.authorization, "Token m0-test-key");
      if (String(url) === "https://api.mem0.ai/v1/event/event-1/") {
        return new Response(JSON.stringify({ id: "event-1", status: "SUCCEEDED" }), { status: 200 });
      }
      assert.equal(String(url), "https://api.mem0.ai/v3/memories/add/");
      const body = JSON.parse(init.body);
      assert.equal(body.user_id, "transactra-owner-owner-1");
      assert.equal(body.agent_id, "transactra-memory-g1");
      return new Response(JSON.stringify({ event_id: "event-1", status: "PENDING" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const submitted = await processMemorySyncOutbox(db, { MEM0_ENABLED: "true", MEM0_API_KEY: "m0-test-key" }, now, 5);
    assert.equal(submitted.processed, 0);
    assert.equal(database.prepare("SELECT status FROM memory_sync_outbox WHERE id=?").get(first).status, "processing");
    const completed = await processMemorySyncOutbox(db, { MEM0_ENABLED: "true", MEM0_API_KEY: "m0-test-key" }, "2026-11-09T12:02:00.000Z", 5);
    assert.equal(completed.processed, 1);
    assert.equal(requestCount, 2);
    assert.equal(database.prepare("SELECT status FROM memory_sync_outbox WHERE id=?").get(first).status, "done");
    assert.equal(database.prepare("SELECT additions FROM memory_usage_monthly WHERE owner_id='owner-1' AND month_key='2026-11'").get().additions, 1);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test("Mem0 batch stops at the compaction threshold without sending the next queued write", async () => {
  const { database, db } = fixture();
  const originalFetch = globalThis.fetch;
  const now = "2026-11-09T12:00:00.000Z";
  try {
    database.prepare("INSERT INTO memory_usage_monthly (owner_id,month_key,additions,retrievals) VALUES (?,?,?,?)")
      .run("owner-1", "2026-11", 6999, 0);
    await enqueueMem0Memory(db, "owner-1", "fact.one", "first", now, "event-one");
    await enqueueMem0Memory(db, "owner-1", "fact.two", "second", now, "event-two");
    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount += 1;
      return new Response(JSON.stringify({ event_id: "event-" + requestCount }), { status: 200 });
    };
    const result = await processMemorySyncOutbox(db, {
      MEM0_ENABLED: "true",
      MEM0_API_KEY: "m0-test-key",
      MEM0_MONTHLY_ADDITION_LIMIT: "10000",
      MEM0_MONTHLY_RETRIEVAL_LIMIT: "1000",
      MEM0_COMPACTION_THRESHOLD_PERCENT: "70",
    }, now, 5);
    assert.equal(result.processed, 0);
    assert.equal(requestCount, 1);
    assert.equal(database.prepare("SELECT additions FROM memory_usage_monthly WHERE owner_id=? AND month_key=?").get("owner-1", "2026-11").additions, 7000);
    assert.equal(database.prepare("SELECT active_generation,mem0_paused_month FROM memory_compaction_state WHERE owner_id=?").get("owner-1").active_generation, 2);
    assert.equal(database.prepare("SELECT status FROM memory_sync_outbox WHERE memory_key=?").get("fact.two").status, "done");
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test("Mem0 key alone cannot enable provider calls without explicit free-tier opt-in", async () => {
  const { database, db } = fixture();
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  try {
    await enqueueMem0Memory(db, "owner-1", "fact.disabled", "D1-only mode", "2026-11-09T12:00:00.000Z", "disabled-test");
    globalThis.fetch = async () => { requestCount += 1; throw new Error("Mem0 must remain disabled"); };
    const env = { MEM0_ENABLED: "false", MEM0_API_KEY: "m0-test-key" };
    const status = await getMemoryStatus(db, env, "owner-1", "2026-11-09T12:00:00.000Z");
    assert.equal(status.mem0Configured, false);
    const search = await searchMem0Memory(db, env, "owner-1", "D1-only mode", "2026-11-09T12:00:00.000Z");
    assert.equal(search.source, "d1");
    const sync = await processMemorySyncOutbox(db, env, "2026-11-09T12:00:00.000Z", 5);
    assert.equal(sync.processed, 0);
    assert.equal(requestCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test("Mem0 retrieval returns scoped results and accounts for the retrieval", async () => {
  const { database, db } = fixture();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "https://api.mem0.ai/v3/memories/search/");
      assert.equal(init.headers.authorization, "Token m0-test-key");
      const body = JSON.parse(init.body);
      assert.equal(body.filters.user_id, "transactra-owner-owner-1");
      assert.equal(body.filters.agent_id, "transactra-memory-g1");
      return new Response(JSON.stringify({ results: [{ memory: "Transactra uses D1 as canonical storage.", score: 0.91 }] }), { status: 200 });
    };
    const result = await searchMem0Memory(db, { MEM0_ENABLED: "true", MEM0_API_KEY: "m0-test-key" }, "owner-1", "where is canonical storage?", "2026-11-09T12:00:00.000Z");
    assert.equal(result.source, "mem0");
    assert.equal(result.memories[0].memory, "Transactra uses D1 as canonical storage.");
    assert.equal(database.prepare("SELECT retrievals FROM memory_usage_monthly WHERE owner_id=? AND month_key=?").get("owner-1", "2026-11").retrievals, 1);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test("forget waits for in-flight sync and then deletes only the scoped Mem0 key and D1 row", async () => {
  const { database, db } = fixture();
  const originalFetch = globalThis.fetch;
  const env = { MEM0_ENABLED: "true", MEM0_API_KEY: "m0-test-key" };
  try {
    await enqueueMem0Memory(db, "owner-1", "project.database", "value", "2026-11-09T12:00:00.000Z", "forget-event");
    let fetchCalls = 0;
    globalThis.fetch = async () => { fetchCalls++; throw new Error("delete must wait for sync"); };
    const waiting = await forgetMem0Memory(db, env, "owner-1", "project.database");
    assert.equal(waiting.reason, "sync_pending");
    assert.equal(database.prepare("SELECT COUNT(*) AS total FROM agent_memory WHERE owner_id=? AND memory_key=?").get("owner-1", "project.database").total, 1);
    assert.equal(fetchCalls, 0);

    database.prepare("UPDATE memory_sync_outbox SET status='done' WHERE owner_id=? AND memory_key=?").run("owner-1", "project.database");
    globalThis.fetch = async (url, init) => {
      fetchCalls++;
      assert.equal(init.method, "DELETE");
      const parsed = new URL(String(url));
      assert.equal(parsed.origin, "https://api.mem0.ai");
      assert.equal(parsed.pathname, "/v1/memories/");
      assert.equal(parsed.searchParams.get("user_id"), "transactra-owner-owner-1");
      assert.deepEqual(JSON.parse(parsed.searchParams.get("metadata")), { memory_key: "project.database" });
      return new Response(JSON.stringify({ message: "Delete in progress. This may take some time.", event_id: "delete-event-123" }), { status: 200 });
    };
    const deleted = await forgetMem0Memory(db, env, "owner-1", "project.database");
    assert.deepEqual(deleted, { deleted: 1, source: "d1+mem0_queued", provider_event_id: "delete-event-123" });
    assert.equal(database.prepare("SELECT COUNT(*) AS total FROM agent_memory WHERE owner_id=? AND memory_key=?").get("owner-1", "project.database").total, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS total FROM task_memory WHERE memory_id=?").get("mem-1").total, 0);
    assert.equal(fetchCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test("Mem0 transient failures enter bounded retry and later reach processing", async () => {
  const { database, db } = fixture();
  const originalFetch = globalThis.fetch;
  const env = { MEM0_ENABLED: "true", MEM0_API_KEY: "m0-test-key" };
  try {
    const id = await enqueueMem0Memory(db, "owner-1", "retry.fact", "retry safely", "2026-11-09T12:00:00.000Z", "retry-event");
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) return new Response("temporary", { status: 503 });
      return new Response(JSON.stringify({ event_id: "retry-event-id", status: "PENDING" }), { status: 200 });
    };
    await processMemorySyncOutbox(db, env, "2026-11-09T12:00:00.000Z", 5);
    let row = database.prepare("SELECT status,attempt_count,last_error FROM memory_sync_outbox WHERE id=?").get(id);
    assert.equal(row.status, "retry");
    assert.equal(row.attempt_count, 1);
    assert.match(row.last_error, /HTTP 503/);
    await processMemorySyncOutbox(db, env, "2026-11-09T12:06:00.000Z", 5);
    row = database.prepare("SELECT status,attempt_count,provider_event_id FROM memory_sync_outbox WHERE id=?").get(id);
    assert.equal(row.status, "processing");
    assert.equal(row.attempt_count, 2);
    assert.equal(row.provider_event_id, "retry-event-id");
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test("Mem0 API requests use scoped Token authentication and retrieval stays generation-scoped", () => {
  const source = readFileSync(resolve(here, "../src/memory-lifecycle.mjs"), "utf8");
  assert.match(source, /"authorization": "Token " \+ key/);
  assert.match(source, /filters: \{ user_id: scopeId\(ownerId\), agent_id: agentId\(state.active_generation\) \}/);
  assert.match(source, /top_k: 8/);
  assert.match(source, /MEM0_API_KEY/);
});

test("compaction and quota exhaustion preserve D1 history and fail over locally", () => {
  const source = readFileSync(resolve(here, "../src/memory-lifecycle.mjs"), "utf8");
  assert.match(source, /DEFAULT_THRESHOLD_PERCENT = 70/);
  assert.match(source, /mem0_paused_month/);
  assert.match(source, /source: "d1"/);
  assert.match(source, /dead_letter/);
  assert.doesNotMatch(source, /DELETE FROM memory_archives|DELETE FROM task_events|DELETE FROM orchestrator_events/);
});
