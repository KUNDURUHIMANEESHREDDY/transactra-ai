import type { TaskDepartment } from "../../contracts/src/index.js";
import type { PostgresTaskStore } from "../../storage/src/postgres.js";
import type { OrganizationCycleRecord, OrganizationStore } from "../../storage/src/organization.js";
import type { AgentRegistry } from "../../agents/src/dynamic-registry.js";
import type { OperationsMonitor } from "./operations.js";
import type { SecurityAuditor } from "./security.js";

export interface CycleDecision {
  key: string;
  department: TaskDepartment | "system";
  action: string;
  detail: string;
  taskId?: string;
  created?: boolean;
}

export interface OrganizationCycleResult {
  cycle: OrganizationCycleRecord;
  ran: boolean;
  decisions: CycleDecision[];
  tasksEnqueued: number;
  operationsFindings: number;
  lifecycleActions: number;
  securityScore: number | null;
}

interface LastRunState { at?: string; }

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function hourKey(date: Date): string {
  return "cycle:" + date.toISOString().slice(0,13).replace("T","t");
}
function ageSince(state: LastRunState | null): number {
  if (!state?.at) return Number.POSITIVE_INFINITY;
  const time = Date.parse(state.at);
  return Number.isFinite(time) ? Date.now() - time : Number.POSITIVE_INFINITY;
}

/**
 * One durable organisation cycle: observe operations, apply safe lifecycle transitions,
 * audit security, and enqueue the condition-driven work that is actually due (incident
 * analysis, security posture review, weekly evolution and workforce coverage). Fixed-period
 * intelligence and innovation cycles are owned by `DurableScheduler` so a single mechanism
 * controls each cadence. Every enqueue uses a deterministic idempotency key, so a restarted
 * scheduler cannot duplicate tasks.
 */
export class OrganizationCycleRunner {
  readonly #ownerId: string;
  readonly #store: OrganizationStore;
  readonly #taskStore: PostgresTaskStore;
  readonly #registry: AgentRegistry;
  readonly #operations: OperationsMonitor;
  readonly #security: SecurityAuditor | undefined;
  readonly #now: () => Date;

  constructor(input: {
    ownerId: string;
    store: OrganizationStore;
    taskStore: PostgresTaskStore;
    registry: AgentRegistry;
    operations: OperationsMonitor;
    security?: SecurityAuditor;
    now?: () => Date;
  }) {
    if (!input.ownerId.trim()) throw new Error("Organisation cycle requires an owner ID");
    this.#ownerId = input.ownerId;
    this.#store = input.store;
    this.#taskStore = input.taskStore;
    this.#registry = input.registry;
    this.#operations = input.operations;
    this.#security = input.security;
    this.#now = input.now ?? (() => new Date());
  }

  async run(cycleKey = hourKey(this.#now())): Promise<OrganizationCycleResult> {
    const started = await this.#store.startCycle(this.#ownerId,cycleKey);
    if (!started.created && started.cycle.status === "completed") {
      return {
        cycle: started.cycle, ran: false,
        decisions: Array.isArray(started.cycle.decisions) ? started.cycle.decisions as CycleDecision[] : [],
        tasksEnqueued: started.cycle.tasks_enqueued,
        operationsFindings: 0, lifecycleActions: 0, securityScore: null
      };
    }
    const decisions: CycleDecision[] = [];
    let tasksEnqueued = 0;
    try {
      const ops = await this.#operations.run(this.#ownerId,{ notify: true });
      decisions.push({
        key: "operations.observed", department: "system", action: "observed",
        detail: ops.findings.length + " operations finding(s); " + ops.notificationsQueued + " alert notification(s) queued"
      });

      const lifecycle = await this.#registry.applySafeLifecycleTransitions();
      for (const action of lifecycle) {
        decisions.push({
          key: "workforce.lifecycle", department: "system", action: action.action,
          detail: action.agentId + " -> " + action.action + ": " + action.reason
        });
      }

      let securityScore: number | null = null;
      if (this.#security) {
        const audit = await this.#security.audit(this.#ownerId);
        securityScore = audit.score;
        for (const finding of audit.findings.filter((item) => item.severity === "critical")) {
          await this.#store.recordIncident({
            ownerId: this.#ownerId,
            key: "security-" + finding.key,
            severity: "critical",
            title: finding.title,
            details: { detail: finding.detail, evidence: finding.evidence }
          });
        }
        await this.#markState("organization.lastSecurityAudit");
        decisions.push({
          key: "security.audited", department: "system", action: "audited",
          detail: "Security score " + audit.score + " with " + audit.findings.length + " finding(s)"
        });
      }

      const enqueued = await this.#enqueueDueWork(decisions);
      tasksEnqueued = enqueued;

      await this.#store.finishCycle(started.cycle.id,{
        status: "completed", decisions, tasksEnqueued
      });
      return {
        cycle: { ...started.cycle, status: "completed", completed_at: this.#now(), decisions, tasks_enqueued: tasksEnqueued },
        ran: true, decisions, tasksEnqueued,
        operationsFindings: ops.findings.length,
        lifecycleActions: lifecycle.length,
        securityScore
      };
    } catch (error) {
      await this.#store.finishCycle(started.cycle.id,{
        status: "failed", decisions, tasksEnqueued,
        error: error instanceof Error ? error.message.slice(0,1000) : "organisation cycle failed"
      });
      throw error;
    }
  }

  async #enqueueDueWork(decisions: CycleDecision[]): Promise<number> {
    let created = 0;
    const enqueue = async (input: {
      key: string; title: string; objective: string; department: TaskDepartment;
      risk: "low" | "medium" | "high"; priority: number;
    }): Promise<void> => {
      const result = await this.#taskStore.enqueue({
        ownerId: this.#ownerId,
        title: input.title,
        objective: input.objective,
        department: input.department,
        risk: input.risk,
        priority: input.priority,
        idempotencyKey: input.key,
        requestedBy: { id: "system:organisation", kind: "system" }
      });
      decisions.push({
        key: input.key, department: input.department,
        action: result.created ? "task_enqueued" : "task_already_exists",
        detail: input.title, taskId: result.task.id, created: result.created
      });
      if (result.created) created += 1;
    };

    const now = this.#now();
    const dayKey = now.toISOString().slice(0,10);

    const securityState = await this.#store.getState<LastRunState>("organization.lastSecurityTask");
    if (ageSince(securityState) >= SIX_HOURS_MS) {
      await enqueue({
        key: "security:6h:" + now.toISOString().slice(0,13),
        title: "Security posture review",
        objective: "Audit Transactra's security posture using real approval, tool invocation, agent, deployment and evolution records. Report concrete findings with evidence, open incidents for critical gaps, and never weaken a control without owner approval.",
        department: "security", risk: "low", priority: 30
      });
      await this.#markState("organization.lastSecurityTask");
    }

    const operationsState = await this.#store.getState<LastRunState>("organization.lastOperationsTask");
    const openCritical = await this.#store.openIncidentCounts(this.#ownerId);
    if ((openCritical.critical > 0 || openCritical.warning >= 3) && ageSince(operationsState) >= DAY_MS) {
      await enqueue({
        key: "operations:incident:" + dayKey,
        title: "Incident analysis and recovery proposal",
        objective: "Analyse every open incident with real operational evidence, correlate task leases, tool invocations and deployment failures, and propose bounded recovery steps. Do not replay non-idempotent external side effects; critical recovery actions require owner approval.",
        department: "operations", risk: "low", priority: 5
      });
      await this.#markState("organization.lastOperationsTask");
    }

    const evolutionState = await this.#store.getState<LastRunState>("organization.lastEvolutionRun");
    if (ageSince(evolutionState) >= WEEK_MS) {
      await enqueue({
        key: "evolution:weekly:" + now.toISOString().slice(0,10),
        title: "Weekly self-evolution review",
        objective: "Audit Transactra using real 30-day system evidence, identify the smallest measured weakness, and propose a minimal schema-valid change. Validate it in the isolated sandbox. Never apply or roll back without explicit owner approval and never modify secrets, dependencies or CI permissions.",
        department: "evolution", risk: "medium", priority: 40
      });
      await this.#markState("organization.lastEvolutionRun");
    }

    const workforceState = await this.#store.getState<LastRunState>("organization.lastWorkforceReview");
    if (ageSince(workforceState) >= WEEK_MS) {
      const departments = new Set((await this.#registry.list()).map((agent) => agent.department));
      const missing = ("orchestration,engineering,intelligence,innovation,operations,security,evolution".split(",")).filter((department) => !departments.has(department as TaskDepartment));
      if (missing.length > 0) {
        await enqueue({
          key: "workforce:coverage:" + now.toISOString().slice(0,10),
          title: "Workforce coverage review",
          objective: "The organisation has no executable agent in these departments: " + missing.join(", ") + ". Inspect the capability gap and, only when a real capability gap is demonstrated, create a least-privilege probationary agent. Restoration or retirement still requires owner approval.",
          department: "orchestration", risk: "low", priority: 50
        });
        await this.#markState("organization.lastWorkforceReview");
      }
    }
    return created;
  }

  async #markState(key: string): Promise<void> {
    await this.#store.setState(key,{ at: this.#now().toISOString() });
  }
}
