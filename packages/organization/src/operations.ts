import { Pool } from "pg";
import type { IncidentSeverity } from "../../storage/src/organization.js";

export interface OperationsSnapshot {
  observedAt: string;
  tasks: Record<string, number>;
  staleLeases: number;
  oldestQueuedSeconds: number;
  pendingApprovals: number;
  oldestPendingApprovalSeconds: number;
  openIncidents: Record<IncidentSeverity, number>;
  deploymentsFailed24h: number;
  deploymentsTotal24h: number;
  notificationsQueued: number;
  notificationsFailed: number;
  agents: { enabled: number; probation: number; quarantined: number; disabled: number };
  memoryItems: number;
  stuckToolInvocations: number;
}

export interface OperationsFinding {
  key: string;
  severity: IncidentSeverity;
  title: string;
  details: Record<string, unknown>;
  recommendation: string;
}

export interface OperationsRunResult {
  snapshot: OperationsSnapshot;
  findings: OperationsFinding[];
  recordedIncidents: string[];
  notificationsQueued: number;
}

function seconds(value: string | null): number {
  const parsed = Number(value ?? "0");
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

export function evaluateOperations(snapshot: OperationsSnapshot): OperationsFinding[] {
  const findings: OperationsFinding[] = [];
  if (snapshot.staleLeases > 0) {
    findings.push({
      key: "stale-task-leases", severity: "critical",
      title: snapshot.staleLeases + " running task lease(s) have expired",
      details: { staleLeases: snapshot.staleLeases },
      recommendation: "Reconcile expired leases and inspect whether the worker crashed after an external side effect; never replay non-idempotent actions blindly."
    });
  }
  if (snapshot.stuckToolInvocations > 0) {
    findings.push({
      key: "unreconciled-tool-invocations", severity: "critical",
      title: snapshot.stuckToolInvocations + " tool invocation(s) have no terminal audit outcome",
      details: { stuckToolInvocations: snapshot.stuckToolInvocations },
      recommendation: "Inspect the affected external systems before retrying; a pending invocation may already have produced a side effect."
    });
  }
  if (snapshot.oldestQueuedSeconds > 3600) {
    findings.push({
      key: "task-queue-stalled", severity: "warning",
      title: "Oldest queued task has waited " + Math.round(snapshot.oldestQueuedSeconds / 60) + " minutes",
      details: { oldestQueuedSeconds: snapshot.oldestQueuedSeconds, tasks: snapshot.tasks },
      recommendation: "Verify that a worker is running with the required department capabilities and that the provider circuit is closed."
    });
  }
  if (snapshot.oldestPendingApprovalSeconds > 86400) {
    findings.push({
      key: "approval-backlog", severity: "warning",
      title: "Owner approval has been pending for " + Math.round(snapshot.oldestPendingApprovalSeconds / 3600) + " hours",
      details: { pendingApprovals: snapshot.pendingApprovals },
      recommendation: "Notify the owner through an independent channel; blocked tasks must not bypass approval."
    });
  }
  if (snapshot.deploymentsFailed24h >= 2) {
    findings.push({
      key: "repeated-deployment-failures", severity: "warning",
      title: snapshot.deploymentsFailed24h + " deployment(s) failed in the last 24 hours",
      details: { failed: snapshot.deploymentsFailed24h, total: snapshot.deploymentsTotal24h },
      recommendation: "Stop automatic deployment attempts and inspect workflow logs before re-dispatching."
    });
  }
  if (snapshot.notificationsFailed > 0) {
    findings.push({
      key: "notification-delivery-failed", severity: "warning",
      title: snapshot.notificationsFailed + " notification(s) failed delivery",
      details: { notificationsFailed: snapshot.notificationsFailed },
      recommendation: "Check channel credentials and recipient allowlists; failed notifications remain auditable."
    });
  }
  if (snapshot.agents.quarantined > 0) {
    findings.push({
      key: "agents-quarantined", severity: "info",
      title: snapshot.agents.quarantined + " agent(s) are quarantined",
      details: { agents: snapshot.agents },
      recommendation: "Review quarantined agents with the Workforce Manager; restoration requires owner approval."
    });
  }
  return findings;
}

export class OperationsMonitor {
  readonly #pool: Pool;
  constructor(connectionString: string) {
    if (!connectionString.trim()) throw new Error("DATABASE_URL is required");
    this.#pool = new Pool({ connectionString, max: 3, application_name: "transactra-operations" });
  }
  async close(): Promise<void> { await this.#pool.end(); }

  async snapshot(ownerId: string): Promise<OperationsSnapshot> {
    const [statuses, stale, queuedAge, approvals, incidents, deployments, notifications, agents, memory, stuck] = await Promise.all([
      this.#pool.query<{ status: string; count: string }>("SELECT status,count(*)::text AS count FROM tasks WHERE owner_id=$1 GROUP BY status",[ownerId]),
      this.#pool.query<{ count: string }>("SELECT count(*)::text AS count FROM tasks WHERE owner_id=$1 AND status='running' AND lease_until<now()",[ownerId]),
      this.#pool.query<{ age: string | null }>("SELECT EXTRACT(EPOCH FROM (now()-MIN(created_at)))::text AS age FROM tasks WHERE owner_id=$1 AND status='queued'",[ownerId]),
      this.#pool.query<{ count: string; oldest: string | null }>("SELECT count(*)::text AS count,EXTRACT(EPOCH FROM (now()-MIN(created_at)))::text AS oldest FROM approvals WHERE owner_id=$1 AND status='pending' AND expires_at>now()",[ownerId]),
      this.#pool.query<{ severity: string; count: string }>("SELECT severity,count(*)::text AS count FROM incidents WHERE owner_id=$1 AND status<>'resolved' GROUP BY severity",[ownerId]),
      this.#pool.query<{ total: string; failed: string }>("SELECT count(*)::text AS total,count(*) FILTER (WHERE status='failed')::text AS failed FROM deployments WHERE owner_id=$1 AND created_at>=now()-interval '24 hours'",[ownerId]),
      this.#pool.query<{ queued: string; failed: string }>("SELECT count(*) FILTER (WHERE status='queued')::text AS queued,count(*) FILTER (WHERE status='failed')::text AS failed FROM notifications WHERE owner_id=$1",[ownerId]),
      this.#pool.query<{ lifecycle_status: string; count: string }>("SELECT lifecycle_status,count(*)::text AS count FROM agents GROUP BY lifecycle_status",[]),
      this.#pool.query<{ count: string }>("SELECT count(*)::text AS count FROM memory_items WHERE owner_id=$1 AND (retention_until IS NULL OR retention_until>now())",[ownerId]),
      this.#pool.query<{ count: string }>("SELECT count(*)::text AS count FROM tool_invocations WHERE outcome='pending' AND created_at<now()-interval '10 minutes'",[])
    ]);
    const tasks: Record<string, number> = {};
    for (const row of statuses.rows) tasks[row.status] = Number(row.count);
    const openIncidents: Record<IncidentSeverity, number> = { info:0, warning:0, critical:0 };
    for (const row of incidents.rows) {
      if (row.severity === "info" || row.severity === "warning" || row.severity === "critical") openIncidents[row.severity] = Number(row.count);
    }
    const agentCounts = { enabled:0, probation:0, quarantined:0, disabled:0 };
    for (const row of agents.rows) {
      const count = Number(row.count);
      if (row.lifecycle_status === "enabled") agentCounts.enabled = count;
      else if (row.lifecycle_status === "probation") agentCounts.probation = count;
      else if (row.lifecycle_status === "quarantined") agentCounts.quarantined = count;
      else if (row.lifecycle_status === "disabled") agentCounts.disabled = count;
    }
    return {
      observedAt: new Date().toISOString(),
      tasks,
      staleLeases: Number(stale.rows[0]?.count ?? "0"),
      oldestQueuedSeconds: seconds(queuedAge.rows[0]?.age ?? null),
      pendingApprovals: Number(approvals.rows[0]?.count ?? "0"),
      oldestPendingApprovalSeconds: seconds(approvals.rows[0]?.oldest ?? null),
      openIncidents,
      deploymentsFailed24h: Number(deployments.rows[0]?.failed ?? "0"),
      deploymentsTotal24h: Number(deployments.rows[0]?.total ?? "0"),
      notificationsQueued: Number(notifications.rows[0]?.queued ?? "0"),
      notificationsFailed: Number(notifications.rows[0]?.failed ?? "0"),
      agents: agentCounts,
      memoryItems: Number(memory.rows[0]?.count ?? "0"),
      stuckToolInvocations: Number(stuck.rows[0]?.count ?? "0")
    };
  }

  /** Records deduplicated incidents and rate-limited notifications for measured findings. */
  async run(ownerId: string, input: { notify?: boolean } = {}): Promise<OperationsRunResult> {
    const snapshot = await this.snapshot(ownerId);
    const findings = evaluateOperations(snapshot);
    const recordedIncidents: string[] = [];
    let notificationsQueued = 0;
    for (const finding of findings) {
      const existing = await this.#pool.query<{ id: string }>(
        "SELECT id FROM incidents WHERE owner_id=$1 AND incident_key=$2 AND status<>'resolved' LIMIT 1",[ownerId,finding.key]
      );
      const incident = await this.#pool.query<{ id: string }>(
        `INSERT INTO incidents(owner_id,incident_key,severity,title,details) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (owner_id,incident_key) WHERE status <> 'resolved'
         DO UPDATE SET severity=EXCLUDED.severity,title=EXCLUDED.title,
           details=EXCLUDED.details || jsonb_build_object('count',COALESCE((incidents.details->>'count')::int,1)+1,'lastSeenAt',now()),
           updated_at=now()
         RETURNING id`,
        [ownerId,finding.key,finding.severity,finding.title,JSON.stringify({ ...finding.details, recommendation: finding.recommendation })]
      );
      const incidentId = incident.rows[0]?.id;
      if (incidentId) recordedIncidents.push(incidentId);
      if ((input.notify ?? true) && !existing.rows[0] && finding.severity !== "info") {
        await this.#pool.query(
          "INSERT INTO notifications(owner_id,channel,kind,message) VALUES($1,'owner','operations_alert',$2)",
          [ownerId,"Transactra operations alert: " + finding.title + "\n" + finding.recommendation]
        );
        notificationsQueued += 1;
      }
    }
    return { snapshot, findings, recordedIncidents, notificationsQueued };
  }
}
