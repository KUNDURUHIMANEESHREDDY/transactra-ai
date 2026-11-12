import { Pool } from "pg";

export interface SecurityFinding {
  key: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  evidence: Record<string, unknown>;
}

export interface SecurityAuditResult {
  auditedAt: string;
  score: number;
  findings: SecurityFinding[];
  metrics: Record<string, number>;
}

/**
 * Read-only security posture audit. It inspects persisted approval, tool-audit, agent,
 * deployment and evolution records; it never mutates state and never weakens a control.
 */
export class SecurityAuditor {
  readonly #pool: Pool;
  constructor(connectionString: string) {
    if (!connectionString.trim()) throw new Error("DATABASE_URL is required");
    this.#pool = new Pool({ connectionString, max: 2, application_name: "transactra-security-audit" });
  }
  async close(): Promise<void> { await this.#pool.end(); }

  async audit(ownerId: string): Promise<SecurityAuditResult> {
    const [approvals, invocations, agents, deployments, proposals] = await Promise.all([
      this.#pool.query<{ pending:string; expired:string; oldest_hours:string | null }>(
        `SELECT count(*) FILTER (WHERE status='pending' AND expires_at>now())::text AS pending,
           count(*) FILTER (WHERE status='pending' AND expires_at<=now())::text AS expired,
           EXTRACT(EPOCH FROM (now()-MIN(created_at) FILTER (WHERE status='pending' AND expires_at>now())))/3600 AS oldest_hours
         FROM approvals WHERE owner_id=$1`,[ownerId]
      ),
      this.#pool.query<{ denied:string; failed:string; pending:string; total:string }>(
        `SELECT count(*) FILTER (WHERE outcome='denied')::text AS denied,
           count(*) FILTER (WHERE outcome='failed')::text AS failed,
           count(*) FILTER (WHERE outcome='pending' AND created_at<now()-interval '10 minutes')::text AS pending,
           count(*)::text AS total
         FROM tool_invocations WHERE created_at>=now()-interval '7 days'
           AND task_id IN (SELECT id FROM tasks WHERE owner_id=$1)`,[ownerId]
      ),
      this.#pool.query<{ id:string; capabilities:string[]; lifecycle_status:string }>(
        "SELECT id,capabilities,lifecycle_status FROM agents WHERE lifecycle_status IN ('enabled','probation')",[]
      ),
      this.#pool.query<{ unapproved:string }>(
        "SELECT count(*)::text AS unapproved FROM deployments WHERE owner_id=$1 AND environment='production' AND approval_id IS NULL AND created_at>=now()-interval '90 days'",[ownerId]
      ),
      this.#pool.query<{ unapproved:string }>(
        "SELECT count(*)::text AS unapproved FROM evolution_proposals WHERE owner_id=$1 AND status IN ('applied','rolled_back') AND approval_id IS NULL",[ownerId]
      )
    ]);
    const pendingApprovals = Number(approvals.rows[0]?.pending ?? "0");
    const expiredApprovals = Number(approvals.rows[0]?.expired ?? "0");
    const oldestHours = Number(approvals.rows[0]?.oldest_hours ?? "0");
    const denied = Number(invocations.rows[0]?.denied ?? "0");
    const failed = Number(invocations.rows[0]?.failed ?? "0");
    const stuck = Number(invocations.rows[0]?.pending ?? "0");
    const unapprovedDeployments = Number(deployments.rows[0]?.unapproved ?? "0");
    const unapprovedProposals = Number(proposals.rows[0]?.unapproved ?? "0");
    const capabilityless = agents.rows.filter((agent) => agent.capabilities.length === 0).map((agent) => agent.id);

    const findings: SecurityFinding[] = [];
    if (expiredApprovals > 0) {
      findings.push({
        key: "expired-approvals", severity: "warning",
        title: expiredApprovals + " approval request(s) expired without an owner decision",
        detail: "Tasks waiting on these approvals are failed closed by the worker claim path.",
        evidence: { expiredApprovals }
      });
    }
    if (pendingApprovals > 0 && oldestHours >= 24) {
      findings.push({
        key: "stale-pending-approvals", severity: "warning",
        title: "Oldest pending approval is " + Math.round(oldestHours) + " hours old",
        detail: "Sensitive actions remain blocked until the owner decides; do not bypass approval.",
        evidence: { pendingApprovals, oldestHours: Math.round(oldestHours) }
      });
    }
    if (denied > 0) {
      findings.push({
        key: "denied-tool-invocations", severity: "info",
        title: denied + " tool invocation(s) were denied in the last 7 days",
        detail: "Denied calls are expected when an agent exceeds its capability grant or policy; review repeated denials for prompt drift.",
        evidence: { denied }
      });
    }
    if (failed >= 10) {
      findings.push({
        key: "repeated-tool-failures", severity: "warning",
        title: failed + " tool invocation(s) failed in the last 7 days",
        detail: "Inspect audit events for recurring integration or credential failures.",
        evidence: { failed }
      });
    }
    if (stuck > 0) {
      findings.push({
        key: "unreconciled-invocations", severity: "critical",
        title: stuck + " tool invocation(s) remain pending beyond the reconciliation window",
        detail: "A pending invocation may already have produced an external side effect; check the provider before retrying.",
        evidence: { stuck }
      });
    }
    if (unapprovedDeployments > 0) {
      findings.push({
        key: "unapproved-production-deployment", severity: "critical",
        title: unapprovedDeployments + " production deployment record(s) have no approval",
        detail: "Production dispatch must always pass through the approval-gated tool gateway.",
        evidence: { unapprovedDeployments }
      });
    }
    if (unapprovedProposals > 0) {
      findings.push({
        key: "unapproved-self-modification", severity: "critical",
        title: unapprovedProposals + " self-evolution proposal(s) were applied without an approval record",
        detail: "Apply and rollback are approval-gated; investigate the audit trail immediately.",
        evidence: { unapprovedProposals }
      });
    }
    if (capabilityless.length > 0) {
      findings.push({
        key: "agents-without-capabilities", severity: "warning",
        title: capabilityless.length + " active agent(s) declare no capability",
        detail: "An agent with no capability cannot perform real work and should be quarantined or retired.",
        evidence: { agents: capabilityless }
      });
    }
    let score = 100;
    for (const finding of findings) score -= finding.severity === "critical" ? 20 : finding.severity === "warning" ? 7 : 1;
    return {
      auditedAt: new Date().toISOString(),
      score: Math.max(0,score),
      findings,
      metrics: {
        pendingApprovals, expiredApprovals, deniedInvocations: denied,
        failedInvocations: failed, stuckInvocations: stuck,
        unapprovedDeployments, unapprovedProposals,
        activeAgents: agents.rows.length, capabilitylessAgents: capabilityless.length
      }
    };
  }
}
