import { Pool } from "pg";
import type { AgentExecutionContext, AgentExecutor } from "./coordinator.js";
import type { ProviderRouter } from "../../providers/src/router.js";
import { summarizeAgentPerformance, type AgentPerformanceRow } from "./evaluation.js";
import { getAgentDefinition } from "./registry.js";

interface StatusCount { status: string; count: string; }
interface ProviderStatus { provider: string; model: string; status: string; observed_at: Date; }

export class OperationsAgentExecutor implements AgentExecutor {
  readonly agentId = "site-reliability-engineer";
  readonly #pool: Pool;
  readonly #providers: ProviderRouter | undefined;
  constructor(connectionString: string,providers?: ProviderRouter) {
    if (!connectionString.trim()) throw new Error("DATABASE_URL is required");
    this.#pool = new Pool({ connectionString, max: 2, application_name: "transactra-operations-agent" });
    this.#providers = providers;
  }
  async close(): Promise<void> { await this.#pool.end(); }

  async execute(context: AgentExecutionContext): Promise<unknown> {
    if (context.signal.aborted) throw context.signal.reason ?? new Error("Operations task cancelled");
    const allowed = new Set(getAgentDefinition("site-reliability-engineer")?.capabilities ?? ["system.observe","incident.analyze","recovery.propose"]);
    if (context.step.capabilities.length === 0 || context.step.capabilities.some((capability) => !allowed.has(capability))) {
      throw new Error("Operations agent was asked to use an undeclared capability");
    }
    const [statuses, stale, approvals, providers, memory, performance] = await Promise.all([
      this.#pool.query<StatusCount>("SELECT status,count(*)::text AS count FROM tasks GROUP BY status ORDER BY status"),
      this.#pool.query<{ count: string }>("SELECT count(*)::text AS count FROM tasks WHERE status='running' AND lease_until < now()"),
      this.#pool.query<{ count: string }>("SELECT count(*)::text AS count FROM approvals WHERE status='pending' AND expires_at > now()"),
      this.#pool.query<ProviderStatus>("SELECT DISTINCT ON(provider,model) provider,model,status,observed_at FROM provider_health ORDER BY provider,model,observed_at DESC"),
      this.#pool.query<{ count: string }>("SELECT count(*)::text AS count FROM memory_items WHERE retention_until IS NULL OR retention_until > now()"),
      this.#pool.query<AgentPerformanceRow>(`
        WITH started AS (
          SELECT task_id,actor_id,payload->>'stepId' AS step_id,payload->>'executionId' AS execution_id,created_at
          FROM task_events
          WHERE event_type='task.step_started' AND created_at >= now()-interval '30 days'
        ),
        finished AS (
          SELECT task_id,actor_id,payload->>'stepId' AS step_id,payload->>'executionId' AS execution_id,event_type,created_at
          FROM task_events
          WHERE event_type IN ('task.step_completed','task.step_failed','task.step_waiting_approval')
            AND created_at >= now()-interval '30 days'
        )
        SELECT s.actor_id AS agent_id,
          (COUNT(*) FILTER (WHERE f.event_type IN ('task.step_completed','task.step_failed')))::text AS finalized_steps,
          (COUNT(*) FILTER (WHERE f.event_type='task.step_completed'))::text AS completed_steps,
          (COUNT(*) FILTER (WHERE f.event_type='task.step_failed'))::text AS failed_steps,
          (COUNT(*) FILTER (WHERE f.event_type='task.step_waiting_approval'))::text AS approval_waits,
          (COUNT(*) FILTER (WHERE f.event_type IS NULL))::text AS open_attempts,
          ROUND(AVG(EXTRACT(EPOCH FROM (f.created_at-s.created_at))*1000) FILTER (WHERE f.event_type='task.step_completed'))::text AS avg_latency_ms
        FROM started s
        LEFT JOIN finished f ON f.task_id=s.task_id AND f.actor_id=s.actor_id
          AND f.step_id=s.step_id AND f.execution_id=s.execution_id
        GROUP BY s.actor_id
        ORDER BY COUNT(*) FILTER (WHERE f.event_type IN ('task.step_completed','task.step_failed')) DESC,s.actor_id ASC
        LIMIT 100
      `)
    ]);
    if (context.signal.aborted) throw context.signal.reason ?? new Error("Operations task cancelled");
    const queue = Object.fromEntries(statuses.rows.map((row) => [row.status, Number(row.count)]));
    const staleLeases = Number(stale.rows[0]?.count ?? "0");
    const pendingApprovals = Number(approvals.rows[0]?.count ?? "0");
    const activeMemoryItems = Number(memory.rows[0]?.count ?? "0");
    const providerCircuits = this.#providers?.getCircuitStates() ?? [];
    const agentPerformance = summarizeAgentPerformance(performance.rows);
    const openCircuits = providerCircuits.filter((provider) => provider.state !== "closed");
    const findings: string[] = [];
    if (staleLeases > 0) findings.push(staleLeases + " task lease(s) are expired and need worker reconciliation");
    if ((queue.failed ?? 0) > 0) findings.push((queue.failed ?? 0) + " task(s) are in failed state");
    if (providers.rows.length === 0 && providerCircuits.length === 0) findings.push("No provider health observations or configured provider circuits are available");
    for (const circuit of openCircuits) findings.push("Provider " + circuit.provider + " circuit is " + circuit.state + (circuit.retryAt ? " until " + new Date(circuit.retryAt).toISOString() : ""));
    for (const agent of agentPerformance) {
      if (agent.sampleSize >= 5 && agent.successRate !== null && agent.successRate < 80) findings.push("Agent " + agent.agentId + " has a " + agent.successRate + "% step success rate across " + agent.sampleSize + " finalized steps");
      if (agent.openAttempts > 0) findings.push("Agent " + agent.agentId + " has " + agent.openAttempts + " step attempt(s) without a terminal event; inspect worker leases before replay");
    }
    if (pendingApprovals > 0) findings.push(pendingApprovals + " owner approval(s) are pending");
    return {
      taskId: context.taskId,
      observedAt: new Date().toISOString(),
      taskCountsByStatus: queue,
      staleLeases,
      pendingApprovals,
      providerHealth: providers.rows.map((provider) => ({
        provider: provider.provider, model: provider.model,
        status: provider.status, observedAt: provider.observed_at.toISOString()
      })),
      activeMemoryItems,
      providerCircuits,
      agentPerformance,
      findings,
      recoveryRecommendations: [
        ...(staleLeases > 0 ? ["Reconcile expired task leases; do not replay non-idempotent side effects without checking external operation IDs."] : []),
        ...((queue.failed ?? 0) > 0 ? ["Inspect failed task event histories and classify retryable versus terminal failures."] : []),
        ...(providers.rows.length === 0 && providerCircuits.length === 0 ? ["Configure a verified no-cost provider and record a health observation before enabling inference."] : []),
        ...openCircuits.map((provider) => "Wait for the " + provider.provider + " circuit cooldown or add another verified no-cost provider; paid fallback remains disabled."),
        ...agentPerformance.filter((agent) => agent.sampleSize >= 5 && agent.successRate !== null && agent.successRate < 80).map((agent) => "Review " + agent.agentId + " prompt, capability scope and recent failed steps before assigning more work.")
      ]
    };
  }
}
