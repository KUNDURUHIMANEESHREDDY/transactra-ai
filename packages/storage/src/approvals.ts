import { createHash } from "node:crypto";
import { Pool } from "pg";
import { assertNoLikelySecrets } from "../../security/src/secrets.js";

export type ApprovalDecision = "approved" | "rejected";
export interface ApprovalRecord {
  id: string; owner_id: string; task_id: string | null; action_hash: string;
  status: "pending" | "approved" | "rejected" | "expired";
  expires_at: Date; created_at: Date;
}

function canonicalize(value: unknown): string {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") throw new Error("Approval actions must be JSON-serializable");
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + canonicalize(record[key])).join(",") + "}";
}
export function hashApprovalAction(action: unknown): string {
  return createHash("sha256").update(canonicalize(action)).digest("hex");
}

export class ApprovalStore {
  readonly #pool: Pool;
  constructor(connectionString: string) {
    if (!connectionString.trim()) throw new Error("DATABASE_URL is required");
    this.#pool = new Pool({ connectionString, max: 3, application_name: "transactra-approvals" });
  }
  async close(): Promise<void> { await this.#pool.end(); }

  async listPending(ownerId: string, limit = 50): Promise<Array<{ id: string; task_id: string | null; action: unknown; expires_at: Date; created_at: Date }>> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Approval list limit must be between 1 and 100");
    const result = await this.#pool.query(
      "SELECT id,task_id,action,expires_at,created_at FROM approvals WHERE owner_id=$1 AND status='pending' AND expires_at>now() ORDER BY created_at ASC LIMIT $2",
      [ownerId,limit]
    );
    return result.rows;
  }

  async request(input: { ownerId: string; taskId?: string; action: unknown; requestedBy: string; ttlSeconds?: number }): Promise<ApprovalRecord> {
    const ttl = input.ttlSeconds ?? 900;
    if (!Number.isInteger(ttl) || ttl < 30 || ttl > 86400) throw new Error("Approval TTL must be between 30 and 86400 seconds");
    assertNoLikelySecrets(canonicalize(input.action), "Approval action");
    const hash = hashApprovalAction(input.action);
    const result = await this.#pool.query<ApprovalRecord>(
      "INSERT INTO approvals(owner_id,task_id,action_hash,action,requested_by,expires_at) VALUES($1,$2,$3,$4,$5,now()+($6 * interval '1 second')) RETURNING id,owner_id,task_id,action_hash,status,expires_at,created_at",
      [input.ownerId,input.taskId ?? null,hash,JSON.stringify(input.action),input.requestedBy,ttl]
    );
    const approval = result.rows[0];
    if (!approval) throw new Error("Approval request was not persisted");
    return approval;
  }

  async decide(input: { ownerId: string; approvalId: string; decision: ApprovalDecision; decidedBy: string; reason: string }): Promise<ApprovalRecord | null> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<ApprovalRecord>(
        "UPDATE approvals SET status=CASE WHEN expires_at <= now() THEN 'expired' ELSE $3 END, decided_by=$4, decision_reason=$5, decided_at=now() WHERE id=$1 AND owner_id=$2 AND status='pending' AND decided_at IS NULL RETURNING id,owner_id,task_id,action_hash,status,expires_at,created_at",
        [input.approvalId,input.ownerId,input.decision,input.decidedBy,input.reason]
      );
      const approval = result.rows[0];
      if (!approval) { await client.query("COMMIT"); return null; }
      if (approval.task_id && approval.status === "approved") {
        const resumed = await client.query(
          "UPDATE tasks SET status='queued',available_at=now(),lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND status IN ('waiting_approval','running') RETURNING id",
          [approval.task_id]
        );
        if (resumed.rowCount === 1) await client.query(
          "INSERT INTO task_events(task_id,event_type,payload,actor_id) VALUES($1,'task.approval_granted',$2,$3)",
          [approval.task_id,JSON.stringify({ approvalId: approval.id }),input.decidedBy]
        );
      } else if (approval.task_id && approval.status === "rejected") {
        const stopped = await client.query(
          "UPDATE tasks SET status='failed',error=jsonb_build_object('message','Required owner approval was rejected'),lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND status IN ('waiting_approval','running') RETURNING id",
          [approval.task_id]
        );
        if (stopped.rowCount === 1) await client.query(
          "INSERT INTO task_events(task_id,event_type,payload,actor_id) VALUES($1,'task.approval_rejected',$2,$3)",
          [approval.task_id,JSON.stringify({ approvalId: approval.id }),input.decidedBy]
        );
      }
      await client.query("COMMIT");
      return approval;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async consume(input: { ownerId: string; action: unknown; taskId?: string; approvalId?: string }): Promise<string | null> {
    const expectedHash = hashApprovalAction(input.action);
    const result = await this.#pool.query<{ id: string }>(
      "WITH candidate AS (SELECT id FROM approvals WHERE owner_id=$1 AND action_hash=$2 AND status='approved' AND consumed_at IS NULL AND expires_at > now() AND (($3::uuid IS NULL AND task_id IS NULL) OR task_id=$3) AND ($4::uuid IS NULL OR id=$4) ORDER BY decided_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED) UPDATE approvals a SET consumed_at=now() FROM candidate c WHERE a.id=c.id RETURNING a.id",
      [input.ownerId,expectedHash,input.taskId ?? null,input.approvalId ?? null]
    );
    return result.rows[0]?.id ?? null;
  }
}
