const DEFAULT_ADDITION_LIMIT = 10000;
const DEFAULT_RETRIEVAL_LIMIT = 1000;
const DEFAULT_THRESHOLD_PERCENT = 70;
const MAX_SUMMARY_CHARS = 12000;

function monthKey(value) {
  return String(value).slice(0, 7);
}
function positiveInt(value, fallback, max = 1000000) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= max ? n : fallback;
}
function scopeId(ownerId) {
  return "transactra-owner-" + String(ownerId).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}
function agentId(generation) {
  return "transactra-memory-g" + String(generation);
}

function mem0Enabled(env) {
  return env.MEM0_ENABLED === "true" && typeof env.MEM0_API_KEY === "string" && env.MEM0_API_KEY.trim().length > 0;
}
function safeText(value, maxLength = 700) {
  return String(value || "")
    .replace(/sk-[A-Za-z0-9]{16,}/g, "[REDACTED_SECRET]")
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED_SECRET]")
    .replace(/xox[baprs]-[A-Za-z0-9-]{20,}/g, "[REDACTED_SECRET]")
    .replace(/[0-9]{8,12}:[A-Za-z0-9_-]{30,}/g, "[REDACTED_SECRET]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]{16,}/gi, "Bearer [REDACTED_SECRET]")
    .replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED_SECRET]")
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}
function hashText(value) {
  let h1 = 0xdeadbeef ^ value.length, h2 = 0x41c6ce57 ^ value.length;
  for (let i = 0, ch; i < value.length; i++) {
    ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}
async function ensureState(db, ownerId, now) {
  await db.prepare(
    "INSERT OR IGNORE INTO memory_compaction_state (owner_id,active_generation,updated_at) VALUES (?,1,?)"
  ).bind(String(ownerId), now).run();
  return db.prepare("SELECT * FROM memory_compaction_state WHERE owner_id=?").bind(String(ownerId)).first();
}
async function readUsage(db, ownerId, now) {
  const key = monthKey(now);
  const row = await db.prepare(
    "SELECT additions,retrievals FROM memory_usage_monthly WHERE owner_id=? AND month_key=?"
  ).bind(String(ownerId), key).first();
  return { month: key, additions: Number(row?.additions || 0), retrievals: Number(row?.retrievals || 0) };
}
async function reserveUsage(db, ownerId, kind, now, env) {
  const key = monthKey(now);
  const cap = limits(env);
  const column = kind === "addition" ? "additions" : "retrievals";
  const timeColumn = kind === "addition" ? "last_add_at" : "last_retrieval_at";
  const thresholdLimit = Math.ceil((kind === "addition" ? cap.additions : cap.retrievals) * cap.threshold / 100);
  const result = await db.prepare(
    "INSERT INTO memory_usage_monthly (owner_id,month_key," + column + "," + timeColumn + ") VALUES (?,?,1,?) " +
    "ON CONFLICT(owner_id,month_key) DO UPDATE SET " + column + "=" + column + "+1," + timeColumn + "=excluded." + timeColumn +
    " WHERE " + column + " < ?"
  ).bind(String(ownerId), key, now, thresholdLimit).run();
  return Number(result?.meta?.changes || 0) === 1;
}
function limits(env) {
  return {
    additions: positiveInt(env.MEM0_MONTHLY_ADDITION_LIMIT, DEFAULT_ADDITION_LIMIT),
    retrievals: positiveInt(env.MEM0_MONTHLY_RETRIEVAL_LIMIT, DEFAULT_RETRIEVAL_LIMIT),
    threshold: Math.min(90, Math.max(50, positiveInt(env.MEM0_COMPACTION_THRESHOLD_PERCENT, DEFAULT_THRESHOLD_PERCENT, 90)))
  };
}
function isOverThreshold(usage, env) {
  const cap = limits(env);
  return usage.additions >= Math.ceil(cap.additions * cap.threshold / 100)
    || usage.retrievals >= Math.ceil(cap.retrievals * cap.threshold / 100);
}
async function mem0Request(env, path, method, body) {
  const key = typeof env.MEM0_API_KEY === "string" ? env.MEM0_API_KEY.trim() : "";
  if (!key) throw new Error("MEM0_NOT_CONFIGURED");
  const response = await fetch("https://api.mem0.ai" + path, {
    method,
    headers: { "authorization": "Token " + key, "content-type": "application/json", "accept": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "manual",
    signal: AbortSignal.timeout(12000)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error("Mem0 request failed with HTTP " + response.status);
    error.status = response.status;
    throw error;
  }
  return data || {};
}


export async function checkMem0Connectivity(env, ownerId) {
  if (!mem0Enabled(env)) return { status: "not_configured", configured: false, authenticated: false, http_status: null };
  try {
    const data = await mem0Request(env, "/v3/memories/search/", "POST", {
      query: "Transactra production connectivity check",
      filters: { user_id: scopeId(ownerId) },
      top_k: 1
    });
    return { status: "authenticated", configured: true, authenticated: true, http_status: 200, result_count: Array.isArray(data.results) ? data.results.length : 0 };
  } catch (error) {
    const status = Number(error?.status || 0);
    return { status: status === 401 || status === 403 ? "unauthorized" : "unavailable", configured: true, authenticated: false, http_status: status || null, error_kind: String(error?.name || "Error").slice(0,60), error_hint: safeText(error?.message || "unknown", 140) };
  }
}

export async function searchMem0Memory(db, env, ownerId, query, now = new Date().toISOString()) {
  const state = await ensureState(db, ownerId, now);
  const usage = await readUsage(db, ownerId, now);
  if (!mem0Enabled(env) || state.mem0_paused_month === usage.month || isOverThreshold(usage, env)) {
    return { memories: [], source: "d1", reason: state.mem0_paused_month === usage.month ? "monthly_threshold_reached" : "mem0_unavailable_or_threshold" };
  }
  try {
    const reserved = await reserveUsage(db, ownerId, "retrieval", now, env);
    if (!reserved) return { memories: [], source: "d1", reason: "monthly_threshold_reached" };
    const data = await mem0Request(env, "/v3/memories/search/", "POST", {
      query: String(query).slice(0, 1000),
      filters: { user_id: scopeId(ownerId), agent_id: agentId(state.active_generation) },
      top_k: 8
    });
    const rows = Array.isArray(data.results) ? data.results : [];
    return {
      memories: rows.slice(0, 8).map((item) => ({
        memory: String(item.memory || item.text || "").slice(0, 1200),
        score: Number(item.score || 0)
      })).filter((item) => item.memory),
      source: "mem0"
    };
  } catch (error) {
    if (error?.status === 402 || error?.status === 429) {
      await db.prepare("UPDATE memory_compaction_state SET mem0_paused_month=?,updated_at=? WHERE owner_id=?")
        .bind(usage.month, now, String(ownerId)).run();
    }
    return { memories: [], source: "d1", reason: error?.message || "mem0_error" };
  }
}

export async function enqueueMem0Memory(db, ownerId, key, value, now = new Date().toISOString(), sourceEventId = crypto.randomUUID()) {
  const id = "msync-" + hashText(String(ownerId) + ":" + String(sourceEventId));
  await db.prepare(
    "INSERT OR IGNORE INTO memory_sync_outbox (id,owner_id,memory_key,memory_value,agent_scope,status,attempt_count,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,?, 'pending',0,?,?,?)"
  ).bind(id, String(ownerId), String(key).slice(0, 80), String(value).slice(0, 4000), "transactra", now, now, now).run();
  return id;
}

export async function forgetMem0Memory(db, env, ownerId, key) {
  const memoryKey = String(key).toLowerCase();
  const pending = await db.prepare(
    "SELECT status FROM memory_sync_outbox WHERE owner_id=? AND memory_key=? AND status IN ('pending','leased','processing','retry') LIMIT 1"
  ).bind(String(ownerId), memoryKey).first();
  if (pending) return { deleted: false, reason: "sync_pending", status: pending.status };

  const synced = await db.prepare(
    "SELECT 1 AS present FROM memory_sync_outbox WHERE owner_id=? AND memory_key=? AND status='done' LIMIT 1"
  ).bind(String(ownerId), memoryKey).first();
  const remoteDeleteEnabled = mem0Enabled(env);
  if (synced && !remoteDeleteEnabled) {
    return { deleted: false, reason: "mem0_unavailable_for_remote_delete" };
  }
  if (remoteDeleteEnabled) {
    const params = new URLSearchParams({
      user_id: scopeId(ownerId),
      metadata: JSON.stringify({ memory_key: memoryKey })
    });
    const deletion = await mem0Request(env, "/v1/memories/?" + params.toString(), "DELETE");
    if (!deletion?.event_id) throw new Error("MEM0_DELETE_EVENT_NOT_CONFIRMED");
    await db.prepare("DELETE FROM task_memory WHERE memory_id IN (SELECT id FROM agent_memory WHERE owner_id=? AND memory_key=?)")
      .bind(String(ownerId), memoryKey).run();
    const result = await db.prepare("DELETE FROM agent_memory WHERE owner_id=? AND memory_key=?")
      .bind(String(ownerId), memoryKey).run();
    return { deleted: Number(result?.meta?.changes || 0), source: "d1+mem0_queued", provider_event_id: String(deletion.event_id) };
  }
  await db.prepare("DELETE FROM task_memory WHERE memory_id IN (SELECT id FROM agent_memory WHERE owner_id=? AND memory_key=?)")
    .bind(String(ownerId), memoryKey).run();
  const result = await db.prepare("DELETE FROM agent_memory WHERE owner_id=? AND memory_key=?")
    .bind(String(ownerId), memoryKey).run();
  return { deleted: Number(result?.meta?.changes || 0), source: "d1" };
}

async function buildSummary(db, ownerId, now) {
  const since = "1970-01-01T00:00:00.000Z";
  const [memories, tasks, taskEvents, orchestratorEvents, steps, jobs, taskRuns, taskRunEvents, taskMemory, taskMemoryCount, taskStatusCounts, taskEventCounts, orchestratorEventCounts, taskRunStatusCounts, taskRunEventCounts, taskApprovalCounts, stepApprovalCounts, stepRunStatusCounts, jobStatusCounts, taskApprovals, stepApprovals] = await Promise.all([
    db.prepare("SELECT memory_key,memory_value,updated_at FROM agent_memory WHERE owner_id=? AND memory_key<>'transactra.compacted_summary' AND (expires_at IS NULL OR expires_at>?) ORDER BY updated_at DESC LIMIT 100").bind(String(ownerId), now).all(),
    db.prepare("SELECT id,description,status,created_at,updated_at FROM tasks WHERE owner_id=? ORDER BY updated_at DESC LIMIT 100").bind(String(ownerId)).all(),
    db.prepare("SELECT e.task_id,e.event_type,e.detail,e.created_at FROM task_events e JOIN tasks t ON t.id=e.task_id WHERE t.owner_id=? AND e.created_at>=? ORDER BY e.created_at DESC LIMIT 200").bind(String(ownerId), since).all(),
    db.prepare("SELECT e.task_id,e.event_type,e.detail,e.created_at FROM orchestrator_events e JOIN tasks t ON t.id=e.task_id WHERE t.owner_id=? AND e.created_at>=? ORDER BY e.created_at DESC LIMIT 200").bind(String(ownerId), since).all(),
    db.prepare("SELECT s.task_id,s.step_id,s.agent,s.status,s.result_text,s.last_error,s.updated_at FROM orchestrator_step_runs s JOIN tasks t ON t.id=s.task_id WHERE t.owner_id=? ORDER BY s.updated_at DESC LIMIT 100").bind(String(ownerId)).all().catch(() => ({ results: [] })),
    db.prepare("SELECT j.task_id,j.status,j.attempt_count,j.max_attempts,j.last_error,j.updated_at FROM orchestrator_jobs j JOIN tasks t ON t.id=j.task_id WHERE t.owner_id=? ORDER BY j.updated_at DESC LIMIT 100").bind(String(ownerId)).all(),
    db.prepare("SELECT r.task_id,r.state,r.attempt_count,r.max_attempts,r.last_error,r.started_at,r.completed_at,r.updated_at FROM task_runs r JOIN tasks t ON t.id=r.task_id WHERE t.owner_id=? ORDER BY r.updated_at DESC LIMIT 100").bind(String(ownerId)).all(),
    db.prepare("SELECT e.run_id,e.event_type,e.detail,e.created_at FROM task_run_events e JOIN task_runs r ON r.id=e.run_id JOIN tasks t ON t.id=r.task_id WHERE t.owner_id=? ORDER BY e.created_at DESC LIMIT 200").bind(String(ownerId)).all(),
    db.prepare("SELECT tm.task_id,tm.memory_key,tm.memory_value,tm.captured_at FROM task_memory tm JOIN tasks t ON t.id=tm.task_id WHERE t.owner_id=? ORDER BY tm.captured_at DESC LIMIT 100").bind(String(ownerId)).all(),
    db.prepare("SELECT COUNT(*) AS total FROM task_memory tm JOIN tasks t ON t.id=tm.task_id WHERE t.owner_id=?").bind(String(ownerId)).first(),
    db.prepare("SELECT status,COUNT(*) AS total FROM tasks WHERE owner_id=? GROUP BY status ORDER BY status").bind(String(ownerId)).all(),
    db.prepare("SELECT e.event_type,COUNT(*) AS total FROM task_events e JOIN tasks t ON t.id=e.task_id WHERE t.owner_id=? GROUP BY e.event_type ORDER BY e.event_type").bind(String(ownerId)).all(),
    db.prepare("SELECT e.event_type,COUNT(*) AS total FROM orchestrator_events e JOIN tasks t ON t.id=e.task_id WHERE t.owner_id=? GROUP BY e.event_type ORDER BY e.event_type").bind(String(ownerId)).all(),
    db.prepare("SELECT r.state,COUNT(*) AS total FROM task_runs r JOIN tasks t ON t.id=r.task_id WHERE t.owner_id=? GROUP BY r.state ORDER BY r.state").bind(String(ownerId)).all(),
    db.prepare("SELECT e.event_type,COUNT(*) AS total FROM task_run_events e JOIN task_runs r ON r.id=e.run_id JOIN tasks t ON t.id=r.task_id WHERE t.owner_id=? GROUP BY e.event_type ORDER BY e.event_type").bind(String(ownerId)).all(),
    db.prepare("SELECT a.status,COUNT(*) AS total FROM task_approvals a JOIN tasks t ON t.id=a.task_id WHERE t.owner_id=? GROUP BY a.status ORDER BY a.status").bind(String(ownerId)).all(),
    db.prepare("SELECT a.status,COUNT(*) AS total FROM orchestrator_step_approvals a JOIN tasks t ON t.id=a.task_id WHERE t.owner_id=? GROUP BY a.status ORDER BY a.status").bind(String(ownerId)).all(),
    db.prepare("SELECT s.status,COUNT(*) AS total FROM orchestrator_step_runs s JOIN tasks t ON t.id=s.task_id WHERE t.owner_id=? GROUP BY s.status ORDER BY s.status").bind(String(ownerId)).all(),
    db.prepare("SELECT j.status,COUNT(*) AS total FROM orchestrator_jobs j JOIN tasks t ON t.id=j.task_id WHERE t.owner_id=? GROUP BY j.status ORDER BY j.status").bind(String(ownerId)).all(),
    db.prepare("SELECT a.task_id,a.status,a.decision_reason,a.created_at,a.expires_at,a.decided_at FROM task_approvals a JOIN tasks t ON t.id=a.task_id WHERE t.owner_id=? ORDER BY a.created_at DESC LIMIT 100").bind(String(ownerId)).all(),
    db.prepare("SELECT a.task_id,a.step_id,a.status,a.action_hash,a.decision_reason,a.created_at,a.expires_at,a.decided_at FROM orchestrator_step_approvals a JOIN tasks t ON t.id=a.task_id WHERE t.owner_id=? ORDER BY a.created_at DESC LIMIT 100").bind(String(ownerId)).all()
  ]);
  const lines = [
    "# Transactra compacted operational memory",
    "Generated: " + now,
    "Owner scope: Transactra owner (identifier retained in D1 only)",
    "",
    "## Durable owner facts"
  ];
  for (const row of memories.results || []) lines.push("- " + row.memory_key + ": " + safeText(row.memory_value, 700));
  lines.push("", "## Complete history counts");
  for (const row of taskStatusCounts.results || []) lines.push("- Tasks " + row.status + ": " + row.total);
  for (const row of taskEventCounts.results || []) lines.push("- Task events " + row.event_type + ": " + row.total);
  for (const row of orchestratorEventCounts.results || []) lines.push("- Orchestrator events " + row.event_type + ": " + row.total);
  for (const row of taskRunStatusCounts.results || []) lines.push("- Task runs " + row.state + ": " + row.total);
  for (const row of taskRunEventCounts.results || []) lines.push("- Task run events " + row.event_type + ": " + row.total);
  for (const row of taskApprovalCounts.results || []) lines.push("- Task approvals " + row.status + ": " + row.total);
  for (const row of stepApprovalCounts.results || []) lines.push("- Step approvals " + row.status + ": " + row.total);
  for (const row of stepRunStatusCounts.results || []) lines.push("- Agent steps " + row.status + ": " + row.total);
  for (const row of jobStatusCounts.results || []) lines.push("- Orchestrator jobs " + row.status + ": " + row.total);
  lines.push("", "## Task outcomes");
  for (const row of tasks.results || []) lines.push("- [" + row.status + "] " + row.id + ": " + safeText(row.description, 350) + " (updated " + row.updated_at + ")");
  lines.push("", "## Task run outcomes (latest 100)");
  for (const row of taskRuns.results || []) lines.push("- [" + row.state + "] task " + row.task_id + "; attempts " + row.attempt_count + "/" + row.max_attempts + (row.last_error ? "; last issue: " + safeText(row.last_error, 220) : "") + "; started " + (row.started_at || "not started") + "; completed " + (row.completed_at || "not completed"));
  lines.push("", "## Task run events (latest 200)");
  for (const row of taskRunEvents.results || []) lines.push("- " + row.created_at + " run " + row.run_id + " " + row.event_type + ": " + safeText(row.detail, 220));
  lines.push("", "## Task-scoped memory snapshots (latest 100; full set retained in D1)");
  lines.push("- Total historical task-memory snapshots: " + Number(taskMemoryCount?.total || 0));
  for (const row of taskMemory.results || []) lines.push("- task " + row.task_id + " " + row.memory_key + ": " + safeText(row.memory_value, 300) + " (captured " + row.captured_at + ")");
  lines.push("", "## Task approval history");
  for (const row of taskApprovals.results || []) lines.push("- [" + row.status + "] task " + row.task_id + "; reason: " + safeText(row.decision_reason || "not decided", 250) + "; expires " + row.expires_at);
  lines.push("", "## Per-step approval history");
  for (const row of stepApprovals.results || []) lines.push("- [" + row.status + "] task " + row.task_id + " step " + row.step_id + "; action hash " + row.action_hash + "; reason: " + safeText(row.decision_reason || "not decided", 200));
  lines.push("", "## Agent step results");
  for (const row of steps.results || []) lines.push("- [" + row.status + "] " + row.agent + "/" + row.step_id + " task " + row.task_id + ": " + safeText(row.result_text || row.last_error || "", 350));
  lines.push("", "## Recovery and orchestration state");
  for (const row of jobs.results || []) lines.push("- [" + row.status + "] task " + row.task_id + "; attempts " + row.attempt_count + "/" + row.max_attempts + (row.last_error ? "; last issue: " + safeText(row.last_error, 250) : ""));
  lines.push("", "## Recent task events");
  for (const row of taskEvents.results || []) lines.push("- " + row.created_at + " task " + row.task_id + " " + row.event_type + ": " + safeText(row.detail, 250));
  lines.push("", "## Recent orchestrator events");
  for (const row of orchestratorEvents.results || []) lines.push("- " + row.created_at + " task " + row.task_id + " " + row.event_type + ": " + safeText(row.detail, 250));
  const fullSummary = lines.join("\n");
  const summary = fullSummary.length > MAX_SUMMARY_CHARS
    ? fullSummary.slice(0, MAX_SUMMARY_CHARS - 100) + "\n\nNOTE: digest truncated for Mem0 limits; complete source records and event history remain preserved in D1."
    : fullSummary;
  return {
    summary,
    counts: {
      memories: memories.results?.length || 0,
      task_memory_snapshots: Number(taskMemoryCount?.total || 0),
      tasks: (taskStatusCounts.results || []).reduce((sum, row) => sum + Number(row.total || 0), 0),
      task_events: (taskEventCounts.results || []).reduce((sum, row) => sum + Number(row.total || 0), 0),
      orchestrator_events: (orchestratorEventCounts.results || []).reduce((sum, row) => sum + Number(row.total || 0), 0),
      task_runs: (taskRunStatusCounts.results || []).reduce((sum, row) => sum + Number(row.total || 0), 0),
      task_run_events: (taskRunEventCounts.results || []).reduce((sum, row) => sum + Number(row.total || 0), 0),
      approvals: (taskApprovalCounts.results || []).reduce((sum, row) => sum + Number(row.total || 0), 0),
      step_approvals: (stepApprovalCounts.results || []).reduce((sum, row) => sum + Number(row.total || 0), 0),
      steps: (stepRunStatusCounts.results || []).reduce((sum, row) => sum + Number(row.total || 0), 0),
      jobs: (jobStatusCounts.results || []).reduce((sum, row) => sum + Number(row.total || 0), 0)
    }
  };
}

export async function compactOwnerMemory(db, env, ownerId, now = new Date().toISOString(), force = false) {
  const state = await ensureState(db, ownerId, now);
  const usage = await readUsage(db, ownerId, now);
  if (!force && !isOverThreshold(usage, env)) return { compacted: false, reason: "below_threshold", usage };
  if (state.last_compacted_month === usage.month) return { compacted: false, reason: "already_compacted_this_month", usage };
  const nextGeneration = Number(state.active_generation || 1) + 1;
  const built = await buildSummary(db, ownerId, now);
  // Reuse an existing archive if a prior attempt failed partway through compaction.
  const existingArchive = await db.prepare(
    "SELECT id FROM memory_archives WHERE owner_id=? AND generation=?"
  ).bind(String(ownerId), nextGeneration).first();
  if (!existingArchive) {
    await db.prepare(
      "INSERT OR IGNORE INTO memory_archives (id,owner_id,generation,summary,summary_hash,source_counts_json,created_at) VALUES (?,?,?,?,?,?,?)"
    ).bind("marchive-" + crypto.randomUUID(), String(ownerId), nextGeneration, built.summary, hashText(built.summary), JSON.stringify(built.counts), now).run();
  }
  // Re-read after INSERT OR IGNORE so concurrent Cron/Queue compactions use
  // the one canonical archive row selected by the owner/generation constraint.
  const archive = await db.prepare(
    "SELECT id,summary,summary_hash,source_counts_json FROM memory_archives WHERE owner_id=? AND generation=?"
  ).bind(String(ownerId), nextGeneration).first();
  if (!archive) throw new Error("Memory compaction archive could not be committed");
  const summary = archive.summary;
  const digest = archive.summary_hash;
  const archiveId = archive.id;
  await db.prepare(
    "INSERT INTO agent_memory (id,owner_id,memory_key,memory_value,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?) " +
    "ON CONFLICT(owner_id,memory_key) DO UPDATE SET memory_value=excluded.memory_value,source=excluded.source,updated_at=excluded.updated_at"
  ).bind("mem-summary-" + nextGeneration, String(ownerId), "transactra.compacted_summary", summary, "automatic_compaction", now, now).run();
  await db.prepare("UPDATE memory_sync_outbox SET status='done',last_error='Superseded by the compacted D1 snapshot',provider_event_id=NULL,lease_token=NULL,lease_until=NULL,updated_at=? WHERE owner_id=? AND status IN ('pending','retry','processing')").bind(now,String(ownerId)).run();
  await db.prepare(
    "UPDATE memory_compaction_state SET active_generation=?,last_compacted_at=?,last_compacted_month=?,last_summary_hash=?,mem0_paused_month=?,updated_at=? WHERE owner_id=?"
  ).bind(nextGeneration, now, usage.month, digest, usage.month, now, String(ownerId)).run();

  // Keep this generation paused for the remainder of the month.
  // Queue the snapshot for next month instead of spending more Mem0 quota now.
  const mem0Seed = "queued_for_next_month";
  await enqueueMem0Memory(db, ownerId, "transactra.compacted_summary", summary, now, "compaction:" + nextGeneration);
  return { compacted: true, archiveId, generation: nextGeneration, summaryHash: digest, counts: built.counts, mem0Seed };
}

export async function processMemorySyncOutbox(db, env, now = new Date().toISOString(), batchSize = 5) {
  if (!mem0Enabled(env)) return { processed: 0, reason: "mem0_disabled_or_not_configured" };
  await db.prepare("UPDATE memory_sync_outbox SET status='retry',lease_token=NULL,lease_until=NULL,next_attempt_at=?,last_error=COALESCE(last_error,'Expired memory sync lease reclaimed'),updated_at=? WHERE status='leased' AND lease_until<=?").bind(now,now,now).run();
  const ownerRows = await db.prepare(
    "SELECT DISTINCT owner_id FROM memory_sync_outbox WHERE status IN ('pending','retry','processing') AND next_attempt_at<=? ORDER BY owner_id LIMIT ?"
  ).bind(now, batchSize).all();
  let processed = 0;
  for (const owner of ownerRows.results || []) {
    const state = await ensureState(db, owner.owner_id, now);
    const usage = await readUsage(db, owner.owner_id, now);
    if (state.mem0_paused_month === usage.month || isOverThreshold(usage, env)) {
      await compactOwnerMemory(db, env, owner.owner_id, now, true);
      continue;
    }
    const pendingEvents = await db.prepare(
      "SELECT id,provider_event_id,attempt_count FROM memory_sync_outbox WHERE owner_id=? AND status='processing' AND next_attempt_at<=? AND provider_event_id IS NOT NULL ORDER BY updated_at LIMIT 5"
    ).bind(owner.owner_id, now).all();
    for (const eventRow of pendingEvents.results || []) {
      try {
        const event = await mem0Request(env, "/v1/event/" + encodeURIComponent(eventRow.provider_event_id) + "/", "GET");
        const eventStatus = String(event.status || "").toUpperCase();
        if (eventStatus === "SUCCEEDED") {
          await db.prepare("UPDATE memory_sync_outbox SET status='done',provider_event_id=NULL,last_error=NULL,updated_at=? WHERE id=? AND status='processing'")
            .bind(now, eventRow.id).run();
          processed++;
        } else if (eventStatus === "FAILED") {
          const attempts = Number(eventRow.attempt_count || 0);
          const dead = attempts >= 5;
          const next = new Date(Date.parse(now) + Math.min(360, 5 * 2 ** Math.max(0, attempts - 1)) * 60000).toISOString();
          await db.prepare("UPDATE memory_sync_outbox SET status=?,provider_event_id=NULL,last_error=?,next_attempt_at=?,updated_at=? WHERE id=? AND status='processing'")
            .bind(dead ? "dead_letter" : "retry", String(event.error || "Mem0 asynchronous memory write failed").slice(0, 300), next, now, eventRow.id).run();
        } else {
          await db.prepare("UPDATE memory_sync_outbox SET next_attempt_at=?,updated_at=? WHERE id=? AND status='processing'")
            .bind(new Date(Date.parse(now) + 15 * 60000).toISOString(), now, eventRow.id).run();
        }
      } catch (error) {
        const next = new Date(Date.parse(now) + 15 * 60000).toISOString();
        await db.prepare("UPDATE memory_sync_outbox SET last_error=?,next_attempt_at=?,updated_at=? WHERE id=? AND status='processing'")
          .bind(String(error?.message || "Mem0 event poll failed").slice(0, 300), next, now, eventRow.id).run();
        if (error?.status === 402 || error?.status === 429) {
          await db.prepare("UPDATE memory_compaction_state SET mem0_paused_month=?,updated_at=? WHERE owner_id=?")
            .bind(usage.month, now, String(owner.owner_id)).run();
        }
      }
    }
    const refreshedState = await ensureState(db, owner.owner_id, now);
    const refreshedUsage = await readUsage(db, owner.owner_id, now);
    if (refreshedState.mem0_paused_month === refreshedUsage.month || isOverThreshold(refreshedUsage, env)) {
      await compactOwnerMemory(db, env, owner.owner_id, now, true);
      continue;
    }
    const rows = await db.prepare(
      "SELECT id,memory_key,memory_value,attempt_count FROM memory_sync_outbox WHERE owner_id=? AND status IN ('pending','retry') AND next_attempt_at<=? ORDER BY created_at LIMIT 5"
    ).bind(owner.owner_id, now).all();
    for (const row of rows.results || []) {
      const currentUsage = await readUsage(db, owner.owner_id, now);
      if (isOverThreshold(currentUsage, env)) {
        await compactOwnerMemory(db, env, owner.owner_id, now, true);
        break;
      }
      const lease = crypto.randomUUID();
      const claimed = await db.prepare(
        "UPDATE memory_sync_outbox SET status='leased',lease_token=?,lease_until=?,attempt_count=attempt_count+1,updated_at=? WHERE id=? AND status IN ('pending','retry')"
      ).bind(lease, new Date(Date.parse(now) + 60000).toISOString(), now, row.id).run();
      if (Number(claimed?.meta?.changes || 0) !== 1) continue;
      try {
        const reserved = await reserveUsage(db, owner.owner_id, "addition", now, env);
        if (!reserved) {
          await db.prepare("UPDATE memory_sync_outbox SET status='retry',lease_token=NULL,lease_until=NULL,next_attempt_at=?,updated_at=? WHERE id=? AND lease_token=?")
            .bind(now, now, row.id, lease).run();
          await compactOwnerMemory(db, env, owner.owner_id, now, true);
          break;
        }
        const accepted = await mem0Request(env, "/v3/memories/add/", "POST", {
          messages: [{ role: "assistant", content: row.memory_value }],
          user_id: scopeId(owner.owner_id),
          agent_id: agentId(state.active_generation),
          metadata: { app: "transactra", memory_key: row.memory_key, source: "transactra_d1_outbox" },
          infer: false
        });
        if (typeof accepted.event_id !== "string" || !accepted.event_id) throw new Error("Mem0 add response did not include an asynchronous event_id");
        await db.prepare("UPDATE memory_sync_outbox SET status='processing',provider_event_id=?,lease_token=NULL,lease_until=NULL,last_error=NULL,next_attempt_at=?,updated_at=? WHERE id=? AND lease_token=?")
          .bind(accepted.event_id, new Date(Date.parse(now) + 60000).toISOString(), now, row.id, lease).run();
      } catch (error) {
        const attempts = Number(row.attempt_count || 0) + 1;
        const dead = attempts >= 5 || error?.status === 402 || error?.status === 429;
        const next = new Date(Date.parse(now) + Math.min(360, 5 * 2 ** Math.max(0, attempts - 1)) * 60000).toISOString();
        await db.prepare("UPDATE memory_sync_outbox SET status=?,lease_token=NULL,lease_until=NULL,last_error=?,next_attempt_at=?,updated_at=? WHERE id=? AND lease_token=?")
          .bind(dead ? "dead_letter" : "retry", String(error?.message || "Mem0 sync failed").slice(0, 300), next, now, row.id, lease).run();
        if (error?.status === 402 || error?.status === 429) {
          await db.prepare("UPDATE memory_compaction_state SET mem0_paused_month=?,updated_at=? WHERE owner_id=?")
            .bind(usage.month, now, String(owner.owner_id)).run();
        }
      }
    }
  }
  return { processed };
}

export async function getMemoryStatus(db, env, ownerId, now = new Date().toISOString()) {
  const state = await ensureState(db, ownerId, now);
  const usage = await readUsage(db, ownerId, now);
  const cap = limits(env);
  const [archives, outbox] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS total FROM memory_archives WHERE owner_id=?").bind(String(ownerId)).first(),
    db.prepare("SELECT status,COUNT(*) AS total FROM memory_sync_outbox WHERE owner_id=? GROUP BY status").bind(String(ownerId)).all()
  ]);
  return {
    usage,
    limits: cap,
    additionsPercent: Math.round(usage.additions / cap.additions * 100),
    retrievalsPercent: Math.round(usage.retrievals / cap.retrievals * 100),
    thresholdReached: isOverThreshold(usage, env),
    mem0Configured: mem0Enabled(env),
    mem0Paused: state.mem0_paused_month === usage.month,
    activeGeneration: Number(state.active_generation || 1),
    lastCompactedAt: state.last_compacted_at || null,
    archives: Number(archives?.total || 0),
    outbox: outbox.results || []
  };
}
