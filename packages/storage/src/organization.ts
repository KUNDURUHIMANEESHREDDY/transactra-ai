import { Pool } from "pg";
import { assertNoLikelySecrets } from "../../security/src/secrets.js";

export type ProposalStatus = "proposed" | "validated" | "validation_failed" | "awaiting_approval" | "applied" | "rolled_back" | "rejected";
export type DeploymentStatus = "dispatched" | "in_progress" | "succeeded" | "failed" | "cancelled" | "rolled_back";
export type IncidentSeverity = "info" | "warning" | "critical";
export type IncidentStatus = "open" | "acknowledged" | "resolved";

export interface SystemAuditRecord {
  id: string; owner_id: string; task_id: string | null; score: number;
  findings: unknown; snapshot: unknown; created_at: Date;
}
export interface EvolutionProposalRecord {
  id: string; owner_id: string; task_id: string | null; audit_id: string | null;
  title: string; rationale: string; changes: unknown; baseline: unknown;
  validation: unknown; status: ProposalStatus; approval_id: string | null;
  applied_commits: unknown; rolled_back_at: Date | null; created_at: Date; updated_at: Date;
}
export interface ProjectRecord {
  id: string; owner_id: string; task_id: string | null; name: string;
  repository_full_name: string; repository_url: string; specification: unknown;
  opportunity_score: unknown; verification: unknown; status: "scaffolded" | "verified" | "validation_failed" | "deployed" | "archived";
  created_at: Date; updated_at: Date;
}
export interface DeploymentRecord {
  id: string; owner_id: string; task_id: string | null; repository: string;
  environment: "staging" | "production"; workflow_file: string; workflow_run_id: string | null;
  commit_sha: string | null; status: DeploymentStatus; approval_id: string | null;
  requested_by: string; details: unknown; created_at: Date; updated_at: Date;
}
export interface IncidentRecord {
  id: string; owner_id: string; incident_key: string; severity: IncidentSeverity;
  status: IncidentStatus; title: string; details: unknown; opened_at: Date;
  acknowledged_at: Date | null; resolved_at: Date | null; updated_at: Date;
}
export interface NotificationRecord {
  id: string; owner_id: string; channel: string; kind: string; message: string;
  status: "queued" | "sent" | "failed"; attempts: number; available_at: Date;
  last_error: string | null; created_at: Date; sent_at: Date | null;
}
export interface OrganizationCycleRecord {
  id: string; owner_id: string; cycle_key: string; status: "running" | "completed" | "failed";
  decisions: unknown; tasks_enqueued: number; error: string | null;
  started_at: Date; completed_at: Date | null;
}

export interface OrganizationAuditMetrics {
  totalTasks30d: number; succeededTasks30d: number; failedTasks30d: number;
  runningTasks30d: number; queuedTasks30d: number; staleLeases: number;
  openCriticalIncidents: number; openWarningIncidents: number; openInfoIncidents: number;
  pendingApprovals: number; totalAgents: number; activeAgents: number; quarantinedAgents: number;
  failedNotifications: number; queuedNotifications: number;
  failedProposals: number; appliedProposals: number; validatedProposals: number; pendingProposals: number;
  deployments30d: number; successfulDeployments30d: number; failedDeployments30d: number;
  memoryItems: number; researchSources30d: number;
  totalProjects: number; verifiedProjects: number; projectsFailedValidation: number;
}

export interface OrganizationAuditEvidence {
  score: number; metrics: OrganizationAuditMetrics; snapshot: Record<string, unknown>;
}

export interface ProjectInput {
  ownerId: string; taskId?: string; name: string; repositoryFullName: string; repositoryUrl: string;
  specification: unknown; opportunityScore: unknown; verification?: unknown;
  status: ProjectRecord["status"];
}

const PROPOSAL_STATUSES: readonly ProposalStatus[] = ["proposed","validated","validation_failed","awaiting_approval","applied","rolled_back","rejected"];
const DEPLOYMENT_STATUSES: readonly DeploymentStatus[] = ["dispatched","in_progress","succeeded","failed","cancelled","rolled_back"];

export class OrganizationStore {
  readonly #pool: Pool;
  constructor(connectionString: string) {
    if (!connectionString.trim()) throw new Error("DATABASE_URL is required");
    this.#pool = new Pool({ connectionString, max: 4, application_name: "transactra-organization" });
  }
  async close(): Promise<void> { await this.#pool.end(); }

  async createAudit(input: { ownerId: string; taskId?: string; score: number; findings: unknown; snapshot: unknown }): Promise<SystemAuditRecord> {
    if (!Number.isInteger(input.score) || input.score < 0 || input.score > 100) throw new Error("Audit score must be an integer from 0 to 100");
    const result = await this.#pool.query<SystemAuditRecord>(
      "INSERT INTO system_audits(owner_id,task_id,score,findings,snapshot) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [input.ownerId,input.taskId ?? null,input.score,JSON.stringify(input.findings),JSON.stringify(input.snapshot)]
    );
    const row = result.rows[0];
    if (!row) throw new Error("System audit was not persisted");
    return row;
  }

  async getAudit(ownerId: string, auditId: string): Promise<SystemAuditRecord | null> {
    const result = await this.#pool.query<SystemAuditRecord>("SELECT * FROM system_audits WHERE owner_id=$1 AND id=$2",[ownerId,auditId]);
    return result.rows[0] ?? null;
  }

  async listAudits(ownerId: string, limit = 20): Promise<SystemAuditRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Audit limit must be between 1 and 100");
    const result = await this.#pool.query<SystemAuditRecord>("SELECT * FROM system_audits WHERE owner_id=$1 ORDER BY created_at DESC LIMIT $2",[ownerId,limit]);
    return result.rows;
  }

  async createProposal(input: {
    ownerId: string; taskId?: string; auditId?: string; title: string; rationale: string;
    changes: unknown; baseline: unknown;
  }): Promise<EvolutionProposalRecord> {
    if (!input.title.trim() || input.title.length > 200) throw new Error("Proposal title must be between 1 and 200 characters");
    if (!input.rationale.trim() || input.rationale.length > 5000) throw new Error("Proposal rationale must be between 1 and 5000 characters");
    assertNoLikelySecrets(input.title + "\n" + input.rationale, "Proposal text");
    const result = await this.#pool.query<EvolutionProposalRecord>(
      "INSERT INTO evolution_proposals(owner_id,task_id,audit_id,title,rationale,changes,baseline) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
      [input.ownerId,input.taskId ?? null,input.auditId ?? null,input.title,input.rationale,JSON.stringify(input.changes),JSON.stringify(input.baseline)]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Evolution proposal was not persisted");
    return row;
  }

  async getProposal(ownerId: string, proposalId: string): Promise<EvolutionProposalRecord | null> {
    const result = await this.#pool.query<EvolutionProposalRecord>("SELECT * FROM evolution_proposals WHERE owner_id=$1 AND id=$2",[ownerId,proposalId]);
    return result.rows[0] ?? null;
  }

  async listProposals(ownerId: string, limit = 50, status?: ProposalStatus): Promise<EvolutionProposalRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Proposal limit must be between 1 and 100");
    if (status && !PROPOSAL_STATUSES.includes(status)) throw new Error("Unknown proposal status");
    const result = status
      ? await this.#pool.query<EvolutionProposalRecord>("SELECT * FROM evolution_proposals WHERE owner_id=$1 AND status=$3 ORDER BY created_at DESC LIMIT $2",[ownerId,limit,status])
      : await this.#pool.query<EvolutionProposalRecord>("SELECT * FROM evolution_proposals WHERE owner_id=$1 ORDER BY created_at DESC LIMIT $2",[ownerId,limit]);
    return result.rows;
  }

  async updateProposal(ownerId: string, proposalId: string, update: {
    status?: ProposalStatus;
    validation?: unknown;
    baseline?: unknown;
    approvalId?: string | null;
    appliedCommits?: unknown;
    rolledBack?: boolean;
  }): Promise<EvolutionProposalRecord> {
    if (update.status && !PROPOSAL_STATUSES.includes(update.status)) throw new Error("Unknown proposal status");
    const sets: string[] = ["updated_at=now()"];
    const values: unknown[] = [ownerId,proposalId];
    if (update.status) { values.push(update.status); sets.push("status=$" + values.length); }
    if (update.validation !== undefined) { values.push(JSON.stringify(update.validation)); sets.push("validation=$" + values.length); }
    if (update.baseline !== undefined) { values.push(JSON.stringify(update.baseline)); sets.push("baseline=$" + values.length); }
    if (update.approvalId !== undefined) { values.push(update.approvalId); sets.push("approval_id=$" + values.length); }
    if (update.appliedCommits !== undefined) { values.push(JSON.stringify(update.appliedCommits)); sets.push("applied_commits=$" + values.length); }
    if (update.rolledBack) sets.push("rolled_back_at=now()");
    const result = await this.#pool.query<EvolutionProposalRecord>(
      "UPDATE evolution_proposals SET " + sets.join(",") + " WHERE owner_id=$1 AND id=$2 RETURNING *",
      values
    );
    const row = result.rows[0];
    if (!row) throw new Error("Evolution proposal not found");
    return row;
  }

  async saveProject(input: ProjectInput): Promise<ProjectRecord> {
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(input.repositoryFullName)) throw new Error("Project repository must be owner/name");
    if (!input.name.trim()) throw new Error("Project name is required");
    const result = await this.#pool.query<ProjectRecord>(
      `INSERT INTO projects(owner_id,task_id,name,repository_full_name,repository_url,specification,opportunity_score,verification,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT(repository_full_name) DO UPDATE SET
         name=EXCLUDED.name,repository_url=EXCLUDED.repository_url,specification=EXCLUDED.specification,
         opportunity_score=EXCLUDED.opportunity_score,verification=EXCLUDED.verification,status=EXCLUDED.status,updated_at=now()
       RETURNING *`,
      [input.ownerId,input.taskId ?? null,input.name,input.repositoryFullName,input.repositoryUrl,
       JSON.stringify(input.specification),JSON.stringify(input.opportunityScore),
       input.verification === undefined ? null : JSON.stringify(input.verification),input.status]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Project was not persisted");
    return row;
  }

  async listProjects(ownerId: string, limit = 50): Promise<ProjectRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Project limit must be between 1 and 100");
    const result = await this.#pool.query<ProjectRecord>("SELECT * FROM projects WHERE owner_id=$1 ORDER BY created_at DESC LIMIT $2",[ownerId,limit]);
    return result.rows;
  }

  async getProject(ownerId: string, projectId: string): Promise<ProjectRecord | null> {
    const result = await this.#pool.query<ProjectRecord>("SELECT * FROM projects WHERE owner_id=$1 AND id=$2",[ownerId,projectId]);
    return result.rows[0] ?? null;
  }

  async createDeployment(input: {
    ownerId: string; taskId?: string; repository: string; environment: "staging" | "production";
    workflowFile: string; commitSha?: string; approvalId?: string; requestedBy: string; details?: unknown;
  }): Promise<DeploymentRecord> {
    const result = await this.#pool.query<DeploymentRecord>(
      `INSERT INTO deployments(owner_id,task_id,repository,environment,workflow_file,commit_sha,approval_id,requested_by,details)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [input.ownerId,input.taskId ?? null,input.repository,input.environment,input.workflowFile,
       input.commitSha ?? null,input.approvalId ?? null,input.requestedBy,JSON.stringify(input.details ?? {})]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Deployment was not persisted");
    return row;
  }

  async updateDeployment(ownerId: string, deploymentId: string, update: {
    status?: DeploymentStatus; workflowRunId?: string | null; commitSha?: string | null; details?: unknown;
  }): Promise<DeploymentRecord> {
    if (update.status && !DEPLOYMENT_STATUSES.includes(update.status)) throw new Error("Unknown deployment status");
    const sets: string[] = ["updated_at=now()"];
    const values: unknown[] = [ownerId,deploymentId];
    if (update.status) { values.push(update.status); sets.push("status=$" + values.length); }
    if (update.workflowRunId !== undefined) { values.push(update.workflowRunId); sets.push("workflow_run_id=$" + values.length); }
    if (update.commitSha !== undefined) { values.push(update.commitSha); sets.push("commit_sha=$" + values.length); }
    if (update.details !== undefined) { values.push(JSON.stringify(update.details)); sets.push("details=$" + values.length); }
    const result = await this.#pool.query<DeploymentRecord>(
      "UPDATE deployments SET " + sets.join(",") + " WHERE owner_id=$1 AND id=$2 RETURNING *", values
    );
    const row = result.rows[0];
    if (!row) throw new Error("Deployment not found");
    return row;
  }

  async getDeployment(ownerId: string, deploymentId: string): Promise<DeploymentRecord | null> {
    const result = await this.#pool.query<DeploymentRecord>("SELECT * FROM deployments WHERE owner_id=$1 AND id=$2",[ownerId,deploymentId]);
    return result.rows[0] ?? null;
  }

  async listDeployments(ownerId: string, limit = 50): Promise<DeploymentRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Deployment limit must be between 1 and 100");
    const result = await this.#pool.query<DeploymentRecord>("SELECT * FROM deployments WHERE owner_id=$1 ORDER BY created_at DESC LIMIT $2",[ownerId,limit]);
    return result.rows;
  }

  async lastSuccessfulDeployment(ownerId: string, repository: string, environment: "staging" | "production"): Promise<DeploymentRecord | null> {
    const result = await this.#pool.query<DeploymentRecord>(
      "SELECT * FROM deployments WHERE owner_id=$1 AND repository=$2 AND environment=$3 AND status='succeeded' ORDER BY created_at DESC LIMIT 1",
      [ownerId,repository,environment]
    );
    return result.rows[0] ?? null;
  }

  async recordIncident(input: {
    ownerId: string; key: string; severity: IncidentSeverity; title: string; details?: unknown;
  }): Promise<IncidentRecord> {
    if (!/^[a-z0-9][a-z0-9._:-]{2,120}$/.test(input.key)) throw new Error("Incident key contains unsupported characters");
    if (!input.title.trim() || input.title.length > 300) throw new Error("Incident title must be between 1 and 300 characters");
    assertNoLikelySecrets(input.title + " " + JSON.stringify(input.details ?? {}), "Incident payload");
    const result = await this.#pool.query<IncidentRecord>(
      `INSERT INTO incidents(owner_id,incident_key,severity,title,details)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (owner_id,incident_key) WHERE status <> 'resolved'
       DO UPDATE SET severity=EXCLUDED.severity,title=EXCLUDED.title,
         details=EXCLUDED.details || jsonb_build_object('count',COALESCE((incidents.details->>'count')::int,1)+1,'lastSeenAt',now()),
         updated_at=now()
       RETURNING *`,
      [input.ownerId,input.key,input.severity,input.title,JSON.stringify(input.details ?? {})]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Incident was not persisted");
    return row;
  }

  async setIncidentStatus(ownerId: string, incidentId: string, status: IncidentStatus): Promise<IncidentRecord | null> {
    const result = await this.#pool.query<IncidentRecord>(
      `UPDATE incidents SET status=$3,
         acknowledged_at=CASE WHEN $3='acknowledged' AND acknowledged_at IS NULL THEN now() ELSE acknowledged_at END,
         resolved_at=CASE WHEN $3='resolved' THEN now() ELSE resolved_at END,
         updated_at=now()
       WHERE owner_id=$1 AND id=$2 RETURNING *`,
      [ownerId,incidentId,status]
    );
    return result.rows[0] ?? null;
  }

  async listIncidents(ownerId: string, limit = 50, status?: IncidentStatus): Promise<IncidentRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Incident limit must be between 1 and 100");
    const result = status
      ? await this.#pool.query<IncidentRecord>("SELECT * FROM incidents WHERE owner_id=$1 AND status=$3 ORDER BY opened_at DESC LIMIT $2",[ownerId,limit,status])
      : await this.#pool.query<IncidentRecord>("SELECT * FROM incidents WHERE owner_id=$1 ORDER BY opened_at DESC LIMIT $2",[ownerId,limit]);
    return result.rows;
  }

  async openIncidentCounts(ownerId: string): Promise<Record<IncidentSeverity, number>> {
    const result = await this.#pool.query<{ severity: IncidentSeverity; count: string }>(
      "SELECT severity,count(*)::text AS count FROM incidents WHERE owner_id=$1 AND status<>'resolved' GROUP BY severity",
      [ownerId]
    );
    const counts: Record<IncidentSeverity, number> = { info:0, warning:0, critical:0 };
    for (const row of result.rows) counts[row.severity] = Number(row.count);
    return counts;
  }

  async getState<T = unknown>(key: string): Promise<T | null> {
    const result = await this.#pool.query<{ state_value: T }>("SELECT state_value FROM system_state WHERE state_key=$1",[key]);
    return result.rows[0]?.state_value ?? null;
  }

  async setState(key: string, value: unknown): Promise<void> {
    // Internal keys are lowercase-dotted identifiers; the strict character class keeps the
    // primary key an opaque identifier rather than user-controlled text. Uppercase is
    // permitted because several durable markers are camelCase.
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,120}$/.test(key)) throw new Error("System state key contains unsupported characters");
    assertNoLikelySecrets(JSON.stringify(value ?? null) ?? "null", "System state");
    await this.#pool.query(
      "INSERT INTO system_state(state_key,state_value) VALUES($1,$2) ON CONFLICT(state_key) DO UPDATE SET state_value=EXCLUDED.state_value,updated_at=now()",
      [key,JSON.stringify(value ?? null)]
    );
  }

  async enqueueNotification(input: { ownerId: string; kind: string; message: string; channel?: string }): Promise<NotificationRecord> {
    if (!input.kind.trim() || input.kind.length > 80) throw new Error("Notification kind is required");
    if (!input.message.trim() || input.message.length > 4000) throw new Error("Notification message must be between 1 and 4000 characters");
    assertNoLikelySecrets(input.message, "Notification message");
    const result = await this.#pool.query<NotificationRecord>(
      "INSERT INTO notifications(owner_id,channel,kind,message) VALUES($1,$2,$3,$4) RETURNING *",
      [input.ownerId,input.channel ?? "owner",input.kind,input.message]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Notification was not queued");
    return row;
  }

  async listNotifications(ownerId: string, limit = 50, status?: "queued" | "sent" | "failed"): Promise<NotificationRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Notification limit must be between 1 and 100");
    const result = status
      ? await this.#pool.query<NotificationRecord>("SELECT * FROM notifications WHERE owner_id=$1 AND status=$3 ORDER BY created_at DESC LIMIT $2",[ownerId,limit,status])
      : await this.#pool.query<NotificationRecord>("SELECT * FROM notifications WHERE owner_id=$1 ORDER BY created_at DESC LIMIT $2",[ownerId,limit]);
    return result.rows;
  }

  async claimNotifications(ownerId: string, workerId: string, limit = 20, channels?: readonly string[]): Promise<NotificationRecord[]> {
    if (!workerId.trim()) throw new Error("Notification workerId is required");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Notification limit must be between 1 and 100");
    if (channels && (channels.length === 0 || channels.length > 5 || channels.some((channel) => !/^[a-z][a-z0-9._-]{1,40}$/.test(channel)))) {
      throw new Error("Notification channels must be one to five lowercase channel names");
    }
    const result = await this.#pool.query<NotificationRecord>(
      `WITH due AS (
         SELECT id FROM notifications
         WHERE owner_id=$1 AND status='queued' AND available_at<=now()
           AND (locked_until IS NULL OR locked_until<now())
           AND ($4::text[] IS NULL OR channel = ANY($4))
         ORDER BY created_at ASC LIMIT $2 FOR UPDATE SKIP LOCKED
       )
       UPDATE notifications n SET locked_by=$3,locked_until=now()+interval '60 seconds'
       FROM due WHERE n.id=due.id RETURNING n.*`,
      [ownerId,limit,workerId,channels && channels.length > 0 ? [...channels] : null]
    );
    return result.rows;
  }

  /**
   * The local/secure surface is pull-based: a notification is only marked delivered after the
   * authenticated owner explicitly acknowledges it. Only `local` notifications can be acked
   * here so an API caller cannot mark a push-channel delivery as successful.
   */
  async ackLocalNotifications(ownerId: string, ids: readonly string[]): Promise<number> {
    if (ids.length === 0 || ids.length > 100) throw new Error("Acknowledge between 1 and 100 notifications");
    if (ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) {
      throw new Error("Notification ids must be UUIDs");
    }
    const result = await this.#pool.query(
      "UPDATE notifications SET status='sent',sent_at=now(),locked_by=NULL,locked_until=NULL,last_error=NULL WHERE owner_id=$1 AND channel='local' AND status='queued' AND id = ANY($2::uuid[])",
      [ownerId,[...ids]]
    );
    return result.rowCount ?? 0;
  }

  async completeNotification(id: string, workerId: string): Promise<void> {    await this.#pool.query(
      "UPDATE notifications SET status='sent',sent_at=now(),locked_by=NULL,locked_until=NULL,last_error=NULL WHERE id=$1 AND locked_by=$2",
      [id,workerId]
    );
  }

  async failNotification(id: string, workerId: string, error: string): Promise<void> {
    const safe = (() => { try { assertNoLikelySecrets(error,"Notification error"); return error.slice(0,500); } catch { return "delivery_failed"; } })();
    await this.#pool.query(
      `UPDATE notifications SET
         attempts=attempts+1,
         status=CASE WHEN attempts+1>=5 THEN 'failed' ELSE 'queued' END,
         available_at=CASE WHEN attempts+1>=5 THEN available_at ELSE now()+(LEAST(300,5*(2^(attempts+1))) * interval '1 second') END,
         locked_by=NULL,locked_until=NULL,last_error=$3
       WHERE id=$1 AND locked_by=$2`,
      [id,workerId,safe]
    );
  }

  /**
   * Real 30-day evidence for the evolution audit. The score starts from the measured task
   * success rate; the evolution engine applies additional incident, lease and backlog penalties.
   */
  async auditEvidence(ownerId: string): Promise<OrganizationAuditEvidence> {
    const [tasks, incidents, agents, notifications, proposals, deployments, memory, sources, projects] = await Promise.all([
      this.#pool.query<{ total:string; succeeded:string; failed:string; running:string; queued:string; stale:string }>(
        `SELECT count(*)::text AS total,
           count(*) FILTER (WHERE status='succeeded')::text AS succeeded,
           count(*) FILTER (WHERE status='failed')::text AS failed,
           count(*) FILTER (WHERE status='running')::text AS running,
           count(*) FILTER (WHERE status='queued')::text AS queued,
           count(*) FILTER (WHERE status='running' AND lease_until<now())::text AS stale
         FROM tasks WHERE owner_id=$1 AND created_at>=now()-interval '30 days'`,[ownerId]
      ),
      this.#pool.query<{ critical:string; warning:string; info:string }>(
        `SELECT count(*) FILTER (WHERE status<>'resolved' AND severity='critical')::text AS critical,
           count(*) FILTER (WHERE status<>'resolved' AND severity='warning')::text AS warning,
           count(*) FILTER (WHERE status<>'resolved' AND severity='info')::text AS info
         FROM incidents WHERE owner_id=$1`,[ownerId]
      ),
      this.#pool.query<{ total:string; active:string; quarantined:string }>(
        `SELECT count(*)::text AS total,
           count(*) FILTER (WHERE lifecycle_status IN ('enabled','probation'))::text AS active,
           count(*) FILTER (WHERE lifecycle_status='quarantined')::text AS quarantined
         FROM agents`,[]
      ),
      this.#pool.query<{ failed:string; queued:string }>(
        `SELECT count(*) FILTER (WHERE status='failed')::text AS failed,
           count(*) FILTER (WHERE status='queued')::text AS queued
         FROM notifications WHERE owner_id=$1`,[ownerId]
      ),
      this.#pool.query<{ failed:string; applied:string; validated:string; proposed:string }>(
        `SELECT count(*) FILTER (WHERE status='validation_failed')::text AS failed,
           count(*) FILTER (WHERE status='applied')::text AS applied,
           count(*) FILTER (WHERE status='validated')::text AS validated,
           count(*) FILTER (WHERE status='proposed')::text AS proposed
         FROM evolution_proposals WHERE owner_id=$1 AND created_at>=now()-interval '30 days'`,[ownerId]
      ),
      this.#pool.query<{ total:string; succeeded:string; failed:string }>(
        `SELECT count(*)::text AS total,
           count(*) FILTER (WHERE status='succeeded')::text AS succeeded,
           count(*) FILTER (WHERE status='failed')::text AS failed
         FROM deployments WHERE owner_id=$1 AND created_at>=now()-interval '30 days'`,[ownerId]
      ),
      this.#pool.query<{ items:string }>(
        "SELECT count(*)::text AS items FROM memory_items WHERE owner_id=$1 AND (retention_until IS NULL OR retention_until>now())",[ownerId]
      ),
      this.#pool.query<{ sources:string }>(
        "SELECT count(*)::text AS sources FROM research_sources WHERE owner_id=$1 AND retrieved_at>=now()-interval '30 days'",[ownerId]
      ),
      this.#pool.query<{ total:string; verified:string; failed:string }>(
        `SELECT count(*)::text AS total,
           count(*) FILTER (WHERE status='verified')::text AS verified,
           count(*) FILTER (WHERE status='validation_failed')::text AS failed
         FROM projects WHERE owner_id=$1`,[ownerId]
      )
    ]);
    const taskRow = tasks.rows[0];
    const metrics: OrganizationAuditMetrics = {
      totalTasks30d: Number(taskRow?.total ?? "0"),
      succeededTasks30d: Number(taskRow?.succeeded ?? "0"),
      failedTasks30d: Number(taskRow?.failed ?? "0"),
      runningTasks30d: Number(taskRow?.running ?? "0"),
      queuedTasks30d: Number(taskRow?.queued ?? "0"),
      staleLeases: Number(taskRow?.stale ?? "0"),
      openCriticalIncidents: Number(incidents.rows[0]?.critical ?? "0"),
      openWarningIncidents: Number(incidents.rows[0]?.warning ?? "0"),
      openInfoIncidents: Number(incidents.rows[0]?.info ?? "0"),
      pendingApprovals: Number((await this.#pool.query<{ count:string }>(
        "SELECT count(*)::text AS count FROM approvals WHERE owner_id=$1 AND status='pending' AND expires_at>now()",[ownerId]
      )).rows[0]?.count ?? "0"),
      totalAgents: Number(agents.rows[0]?.total ?? "0"),
      activeAgents: Number(agents.rows[0]?.active ?? "0"),
      quarantinedAgents: Number(agents.rows[0]?.quarantined ?? "0"),
      failedNotifications: Number(notifications.rows[0]?.failed ?? "0"),
      queuedNotifications: Number(notifications.rows[0]?.queued ?? "0"),
      failedProposals: Number(proposals.rows[0]?.failed ?? "0"),
      appliedProposals: Number(proposals.rows[0]?.applied ?? "0"),
      validatedProposals: Number(proposals.rows[0]?.validated ?? "0"),
      pendingProposals: Number(proposals.rows[0]?.proposed ?? "0"),
      deployments30d: Number(deployments.rows[0]?.total ?? "0"),
      successfulDeployments30d: Number(deployments.rows[0]?.succeeded ?? "0"),
      failedDeployments30d: Number(deployments.rows[0]?.failed ?? "0"),
      memoryItems: Number(memory.rows[0]?.items ?? "0"),
      researchSources30d: Number(sources.rows[0]?.sources ?? "0"),
      totalProjects: Number(projects.rows[0]?.total ?? "0"),
      verifiedProjects: Number(projects.rows[0]?.verified ?? "0"),
      projectsFailedValidation: Number(projects.rows[0]?.failed ?? "0")
    };
    const finalized = metrics.succeededTasks30d + metrics.failedTasks30d;
    const failureRate = finalized === 0 ? 0 : metrics.failedTasks30d / finalized;
    const score = Math.max(0,Math.min(100,Math.round(100 - failureRate * 25)));
    return {
      score,
      metrics,
      snapshot: {
        capturedAt: new Date().toISOString(),
        window: "30d",
        tasks: {
          total: metrics.totalTasks30d, succeeded: metrics.succeededTasks30d,
          failed: metrics.failedTasks30d, running: metrics.runningTasks30d,
          queued: metrics.queuedTasks30d, staleLeases: metrics.staleLeases
        },
        incidents: {
          critical: metrics.openCriticalIncidents, warning: metrics.openWarningIncidents,
          info: metrics.openInfoIncidents
        },
        approvals: { pending: metrics.pendingApprovals },
        agents: {
          total: metrics.totalAgents, active: metrics.activeAgents,
          quarantined: metrics.quarantinedAgents
        },
        notifications: { failed: metrics.failedNotifications, queued: metrics.queuedNotifications },
        proposals: {
          failed: metrics.failedProposals, applied: metrics.appliedProposals,
          validated: metrics.validatedProposals, proposed: metrics.pendingProposals
        },
        deployments: {
          total: metrics.deployments30d, succeeded: metrics.successfulDeployments30d,
          failed: metrics.failedDeployments30d
        },
        intelligence: { memoryItems: metrics.memoryItems, sources30d: metrics.researchSources30d },
        projects: {
          total: metrics.totalProjects, verified: metrics.verifiedProjects,
          failedValidation: metrics.projectsFailedValidation
        }
      }
    };
  }

  async startCycle(ownerId: string, cycleKey: string): Promise<{ cycle: OrganizationCycleRecord; created: boolean }> {
    if (!/^[a-z0-9][a-z0-9._:-]{2,120}$/.test(cycleKey)) throw new Error("Cycle key contains unsupported characters");
    const result = await this.#pool.query<OrganizationCycleRecord>(
      "INSERT INTO organization_cycles(owner_id,cycle_key) VALUES($1,$2) ON CONFLICT(owner_id,cycle_key) DO NOTHING RETURNING *",
      [ownerId,cycleKey]
    );
    if (result.rows[0]) return { cycle: result.rows[0], created: true };
    const existing = await this.#pool.query<OrganizationCycleRecord>("SELECT * FROM organization_cycles WHERE owner_id=$1 AND cycle_key=$2",[ownerId,cycleKey]);
    const cycle = existing.rows[0];
    if (!cycle) throw new Error("Organization cycle could not be created");
    return { cycle, created: false };
  }

  async finishCycle(cycleId: string, input: { status: "completed" | "failed"; decisions: unknown; tasksEnqueued: number; error?: string }): Promise<void> {
    await this.#pool.query(
      "UPDATE organization_cycles SET status=$2,decisions=$3,tasks_enqueued=$4,error=$5,completed_at=now() WHERE id=$1",
      [cycleId,input.status,JSON.stringify(input.decisions),input.tasksEnqueued,input.error ?? null]
    );
  }

  async listCycles(ownerId: string, limit = 20): Promise<OrganizationCycleRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Cycle limit must be between 1 and 100");
    const result = await this.#pool.query<OrganizationCycleRecord>("SELECT * FROM organization_cycles WHERE owner_id=$1 ORDER BY started_at DESC LIMIT $2",[ownerId,limit]);
    return result.rows;
  }
}
