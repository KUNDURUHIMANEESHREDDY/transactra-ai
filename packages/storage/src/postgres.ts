import { Pool, type PoolClient } from "pg";
import type { RiskLevel, TaskStatus, TaskDepartment } from "../../contracts/src/index.js";
import { assertNoLikelySecrets } from "../../security/src/secrets.js";
import { hashApprovalAction } from "./approvals.js";

export interface EnqueueTaskInput {
  ownerId: string; title: string; objective: string; department: TaskDepartment; risk: RiskLevel;
  priority?: number; idempotencyKey: string;
  requestedBy: { id: string; kind: "owner" | "agent" | "system" };
  maxAttempts?: number; deadlineAt?: Date;
}
export interface StoredTask {
  id: string; owner_id: string; title: string; objective: string; department: TaskDepartment;
  status: TaskStatus; risk: RiskLevel; attempt: number; max_attempts: number;
  idempotency_key: string; created_at: Date;
}
export interface ClaimedTask extends StoredTask { lease_owner: string; lease_until: Date; }

export class PostgresTaskStore {
  readonly #pool: Pool;
  constructor(connectionString: string, options: { maxConnections?: number } = {}) {
    if (!connectionString.trim()) throw new Error("DATABASE_URL is required");
    this.#pool = new Pool({ connectionString, max: options.maxConnections ?? 5, application_name: "transactra" });
  }
  async ping(): Promise<void> { await this.#pool.query("SELECT 1"); }
  async close(): Promise<void> { await this.#pool.end(); }

  async enqueue(input: EnqueueTaskInput): Promise<{ task: StoredTask; created: boolean }> {
    assertNoLikelySecrets(input.title + "\\n" + input.objective, "Task request");
    assertNoLikelySecrets(input.idempotencyKey, "Task idempotency key");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<StoredTask>(
        "INSERT INTO tasks (owner_id,title,objective,department,risk,priority,idempotency_key,requested_by,max_attempts,deadline_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (owner_id,idempotency_key) DO NOTHING RETURNING *",
        [input.ownerId,input.title,input.objective,input.department,input.risk,input.priority ?? 100,input.idempotencyKey,JSON.stringify(input.requestedBy),input.maxAttempts ?? 3,input.deadlineAt ?? null]
      );
      let task = inserted.rows[0];
      const created = Boolean(task);
      if (!task) {
        const existing = await client.query<StoredTask>("SELECT * FROM tasks WHERE owner_id=$1 AND idempotency_key=$2 FOR UPDATE", [input.ownerId,input.idempotencyKey]);
        task = existing.rows[0];
      }
      if (!task) throw new Error("Idempotent task lookup failed after insert conflict");
      if (!created && (task.title !== input.title || task.objective !== input.objective || task.department !== input.department || task.risk !== input.risk)) {
        throw new Error("Idempotency key was already used for a different task payload");
      }
      if (created) await this.#event(client, task.id, "task.queued", { title: input.title, risk: input.risk }, input.requestedBy.id);
      await client.query("COMMIT");
      return { task, created };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  /**
   * Atomically persists a Telegram task and its owner approval before it can be claimed.
   * Re-delivery is idempotent on (owner_id, idempotency_key).
   */
  async enqueueAwaitingApproval(input: EnqueueTaskInput): Promise<{
    task: StoredTask;
    approval: { id: string; status: string; expires_at: Date };
    created: boolean;
  }> {
    assertNoLikelySecrets(input.title + "\\n" + input.objective, "Telegram task request");
    assertNoLikelySecrets(input.idempotencyKey, "Telegram task idempotency key");
    const action = {
      version: 1,
      type: "telegram_task_execution",
      idempotencyKey: input.idempotencyKey,
      title: input.title,
      objective: input.objective,
      department: input.department,
      risk: input.risk
    };
    assertNoLikelySecrets(JSON.stringify(action), "Telegram task approval");
    const actionHash = hashApprovalAction(action);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<StoredTask>(
        "INSERT INTO tasks (owner_id,title,objective,department,risk,priority,idempotency_key,requested_by,max_attempts,deadline_at,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'waiting_approval') ON CONFLICT (owner_id,idempotency_key) DO NOTHING RETURNING *",
        [input.ownerId,input.title,input.objective,input.department,input.risk,input.priority ?? 100,input.idempotencyKey,JSON.stringify(input.requestedBy),input.maxAttempts ?? 3,input.deadlineAt ?? null]
      );
      let task = inserted.rows[0];
      const created = Boolean(task);
      if (!task) {
        const existing = await client.query<StoredTask>(
          "SELECT * FROM tasks WHERE owner_id=$1 AND idempotency_key=$2 FOR UPDATE",
          [input.ownerId,input.idempotencyKey]
        );
        task = existing.rows[0];
      }
      if (!task) throw new Error("Idempotent Telegram task lookup failed");
      if (!created && (task.title !== input.title || task.objective !== input.objective || task.department !== input.department || task.risk !== input.risk)) {
        throw new Error("Telegram idempotency key was already used for a different task payload");
      }
      let approvalResult = await client.query<{ id: string; status: string; expires_at: Date }>(
        "SELECT id,status,expires_at FROM approvals WHERE owner_id=$1 AND task_id=$2 AND action_hash=$3 ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
        [input.ownerId,task.id,actionHash]
      );
      let approval = approvalResult.rows[0];
      if (!approval) {
        approvalResult = await client.query<{ id: string; status: string; expires_at: Date }>(
          "INSERT INTO approvals(owner_id,task_id,action_hash,action,requested_by,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '15 minutes') RETURNING id,status,expires_at",
          [input.ownerId,task.id,actionHash,JSON.stringify(action),input.requestedBy.id]
        );
        approval = approvalResult.rows[0];
      }
      if (!approval) throw new Error("Telegram task approval was not persisted");
      if (created) {
        await client.query(
          "INSERT INTO task_events(task_id,event_type,payload,actor_id) VALUES($1,'task.waiting_approval',$2,$3)",
          [task.id,JSON.stringify({ approvalId: approval.id, source: "telegram" }),input.requestedBy.id]
        );
      }
      await client.query("COMMIT");
      return { task, approval, created };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async claimNext(workerId: string, leaseSeconds = 60, departments: readonly TaskDepartment[] = []): Promise<ClaimedTask | null> {
    if (!workerId.trim()) throw new Error("workerId is required");
    if (departments.length === 0) return null;
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 3600) throw new Error("leaseSeconds must be between 5 and 3600");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const exhausted = await client.query<{ id: string }>(
        "UPDATE tasks SET status='failed', error=COALESCE(error,'{}'::jsonb) || jsonb_build_object('message','Lease expired after maximum attempts'), lease_owner=NULL, lease_until=NULL, updated_at=now() WHERE status='running' AND lease_until < now() AND attempt >= max_attempts RETURNING id"
      );
      for (const row of exhausted.rows) await this.#event(client, row.id, "task.failed", { reason: "lease_expired_max_attempts" }, "system");
      const expired = await client.query<{ id: string }>(
        "UPDATE tasks SET status='failed', error=jsonb_build_object('message','Task deadline expired before execution'), updated_at=now() WHERE status='queued' AND deadline_at <= now() RETURNING id"
      );
      for (const row of expired.rows) await this.#event(client, row.id, "task.failed", { reason: "deadline_expired" }, "system");
      const approvedTasks = await client.query<{ id: string }>(
        "UPDATE tasks t SET status='queued',available_at=now(),lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE t.status='waiting_approval' AND EXISTS (SELECT 1 FROM approvals a WHERE a.task_id=t.id AND a.status='approved' AND a.consumed_at IS NULL AND a.expires_at>now()) RETURNING t.id"
      );
      for (const row of approvedTasks.rows) await this.#event(client, row.id, "task.approval_granted", { recovered: true }, "system");
      const expiredApprovals = await client.query<{ id: string }>(
        "UPDATE tasks t SET status='failed',error=jsonb_build_object('message','Owner approval expired or was not granted'),lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE t.status='waiting_approval' AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.task_id=t.id AND a.status='pending' AND a.expires_at>now()) AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.task_id=t.id AND a.status='approved' AND a.consumed_at IS NULL AND a.expires_at>now()) RETURNING t.id"
      );
      for (const row of expiredApprovals.rows) await this.#event(client, row.id, "task.approval_expired", {}, "system");
      const selected = await client.query<StoredTask>(
        "SELECT * FROM tasks WHERE department = ANY($1::text[]) AND ((status='queued' AND available_at <= now()) OR (status='running' AND lease_until < now())) AND attempt < max_attempts AND (deadline_at IS NULL OR deadline_at > now()) ORDER BY priority ASC, created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED",
        [departments]
      );
      const task = selected.rows[0];
      if (!task) { await client.query("COMMIT"); return null; }
      const updated = await client.query<ClaimedTask>(
        "UPDATE tasks SET status='running', lease_owner=$2, lease_until=now()+($3 * interval '1 second'), attempt=attempt+1, updated_at=now() WHERE id=$1 RETURNING *",
        [task.id,workerId,leaseSeconds]
      );
      await this.#event(client, task.id, "task.claimed", { workerId, leaseSeconds }, workerId);
      await client.query("COMMIT");
      return updated.rows[0] ?? null;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async checkSchema(): Promise<boolean> {
    const result = await this.#pool.query<{ present: boolean }>("SELECT to_regclass('public.tasks') IS NOT NULL AS present");
    return result.rows[0]?.present === true;
  }

  async get(ownerId: string, taskId: string): Promise<StoredTask | null> {
    const result = await this.#pool.query<StoredTask>("SELECT * FROM tasks WHERE owner_id=$1 AND id=$2", [ownerId,taskId]);
    return result.rows[0] ?? null;
  }

  async list(ownerId: string, limit = 50): Promise<StoredTask[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Task list limit must be between 1 and 100");
    const result = await this.#pool.query<StoredTask>("SELECT * FROM tasks WHERE owner_id=$1 ORDER BY created_at DESC LIMIT $2", [ownerId,limit]);
    return result.rows;
  }

  async appendEvent(ownerId: string, taskId: string, eventType: string, payload: unknown, actorId: string): Promise<void> {
    if (!eventType.trim() || eventType.length > 100) throw new Error("Invalid task event type");
    assertNoLikelySecrets(JSON.stringify(payload ?? {}) ?? "null", "Task event payload");
    const result = await this.#pool.query(
      "INSERT INTO task_events(task_id,event_type,payload,actor_id) SELECT id,$3,$4,$5 FROM tasks WHERE owner_id=$1 AND id=$2 RETURNING id",
      [ownerId,taskId,eventType,JSON.stringify(payload ?? {}),actorId]
    );
    if (result.rowCount !== 1) throw new Error("Task not found in owner scope; event was not appended");
  }

  async events(ownerId: string, taskId: string): Promise<Array<{ id: number; event_type: string; payload: unknown; actor_id: string; created_at: Date }>> {
    const result = await this.#pool.query(
      "SELECT e.id,e.event_type,e.payload,e.actor_id,e.created_at FROM task_events e JOIN tasks t ON t.id=e.task_id WHERE t.owner_id=$1 AND t.id=$2 ORDER BY e.id ASC",
      [ownerId,taskId]
    );
    return result.rows;
  }

  async awaitApproval(taskId: string, workerId: string, approvalId: string): Promise<boolean> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ status: TaskStatus }>(
        "UPDATE tasks SET status=CASE WHEN EXISTS (SELECT 1 FROM approvals a WHERE a.id=$3 AND a.task_id=tasks.id AND a.status='approved' AND a.consumed_at IS NULL AND a.expires_at>now()) THEN 'queued' ELSE 'waiting_approval' END,lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND status='running' AND lease_owner=$2 AND lease_until>now() RETURNING status",
        [taskId,workerId,approvalId]
      );
      const status = result.rows[0]?.status;
      if (!status) { await client.query("COMMIT"); return false; }
      await this.#event(client, taskId, status === "queued" ? "task.approval_already_granted" : "task.waiting_approval", { approvalId }, workerId);
      await client.query("COMMIT");
      return true;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async renewLease(taskId: string, workerId: string, leaseSeconds = 60): Promise<boolean> {
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 3600) throw new Error("leaseSeconds must be between 5 and 3600");
    const result = await this.#pool.query(
      "UPDATE tasks SET lease_until=now()+($3 * interval '1 second'), updated_at=now() WHERE id=$1 AND status='running' AND lease_owner=$2 AND lease_until > now() RETURNING id",
      [taskId,workerId,leaseSeconds]
    );
    return result.rowCount === 1;
  }

  async finish(taskId: string, workerId: string, result: unknown): Promise<void> {
    assertNoLikelySecrets(JSON.stringify(result ?? null) ?? "null", "Task result");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        "UPDATE tasks SET status='succeeded', result=$3, lease_owner=NULL, lease_until=NULL, updated_at=now() WHERE id=$1 AND status='running' AND lease_owner=$2 AND lease_until > now() RETURNING id",
        [taskId,workerId,JSON.stringify(result ?? null)]
      );
      if (updated.rowCount !== 1) throw new Error("Task lease lost or task is not owned by this worker");
      await this.#event(client, taskId, "task.succeeded", { result }, workerId);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async fail(taskId: string, workerId: string, error: unknown, retryDelaySeconds = 30): Promise<void> {
    let safeError = error ?? { message: "Unknown task failure" };
    try { assertNoLikelySecrets(JSON.stringify(safeError) ?? "null", "Task error"); }
    catch { safeError = { name: "Error", message: "redacted_error" }; }
    if (!Number.isInteger(retryDelaySeconds) || retryDelaySeconds < 0 || retryDelaySeconds > 86400) throw new Error("retryDelaySeconds must be between 0 and 86400");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<{ status: TaskStatus }>(
        "UPDATE tasks SET status=CASE WHEN attempt < max_attempts AND (deadline_at IS NULL OR deadline_at > now()) THEN 'queued' ELSE 'failed' END, error=$3, available_at=now()+($4 * interval '1 second'), lease_owner=NULL, lease_until=NULL, updated_at=now() WHERE id=$1 AND status='running' AND lease_owner=$2 AND lease_until > now() RETURNING status",
        [taskId,workerId,JSON.stringify(safeError),retryDelaySeconds]
      );
      if (updated.rowCount !== 1) throw new Error("Task lease lost or task is not owned by this worker");
      await this.#event(client, taskId, updated.rows[0]?.status === "queued" ? "task.retry_scheduled" : "task.failed", { error: safeError, retryDelaySeconds }, workerId);
      await client.query("COMMIT");
    } catch (err) { await client.query("ROLLBACK"); throw err; }
    finally { client.release(); }
  }

  async #event(client: PoolClient, taskId: string, eventType: string, payload: unknown, actorId: string): Promise<void> {
    await client.query("INSERT INTO task_events(task_id,event_type,payload,actor_id) VALUES($1,$2,$3,$4)", [taskId,eventType,JSON.stringify(payload ?? {}),actorId]);
  }
}
