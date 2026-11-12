import type { ProviderRouter } from "../../providers/src/router.js";
import type { ClaimedTask, PostgresTaskStore } from "../../storage/src/postgres.js";
import type { TaskDepartment } from "../../contracts/src/index.js";
import type { TaskExecutor } from "../../orchestrator/src/worker.js";
import { AgentCoordinator } from "./coordinator.js";
import { AgentPlanner, validatePlan, type ExecutionPlan } from "./planner.js";
import type { WorkforceRuntime } from "./workforce.js";

export class PlannedTaskExecutor implements TaskExecutor {
  readonly #store: PostgresTaskStore;
  readonly #workforce: WorkforceRuntime;
  readonly #providers: ProviderRouter;
  readonly #model: string;
  readonly #globalConcurrency: number;

  constructor(input: {
    store: PostgresTaskStore;
    providers: ProviderRouter;
    workforce: WorkforceRuntime;
    model?: string;
    globalConcurrency?: number;
  }) {
    this.#store = input.store;
    this.#workforce = input.workforce;
    this.#providers = input.providers;
    this.#model = input.model ?? "provider-default";
    this.#globalConcurrency = input.globalConcurrency ?? 6;
  }

  /** Kept for the TaskWorker contract; dynamic departments are resolved asynchronously below. */
  get supportedDepartments(): readonly TaskDepartment[] {
    return this.#workforce.supportedDepartments();
  }

  async departments(): Promise<readonly TaskDepartment[]> {
    await this.#workforce.refresh();
    return this.#workforce.supportedDepartments();
  }

  /** Resume a persisted plan only when every unfinished step retains an explicit capability grant. */
  async execute(task: ClaimedTask, signal: AbortSignal): Promise<unknown> {
    const snapshot = await this.#workforce.refresh(true);
    if (snapshot.catalogue.list(task.department).length === 0) {
      throw new Error("No executable agent is available for department " + task.department + "; task remains blocked until the required tools are configured");
    }
    const planner = new AgentPlanner(this.#providers, this.#model, snapshot.catalogue);
    const events = await this.#store.events(task.owner_id, task.id);
    const completedResults: Record<string, unknown> = {};
    for (const event of events) {
      if (event.event_type !== "task.step_completed") continue;
      const payload = event.payload as { stepId?: unknown; result?: unknown };
      if (typeof payload.stepId === "string") {
        completedResults[payload.stepId] = payload.result === undefined ? null : payload.result;
      }
    }
    const planEvent = [...events].reverse().find((event) => event.event_type === "task.plan_created");
    let plan: ExecutionPlan;
    if (planEvent) {
      const payload = planEvent.payload as { plan?: unknown };
      const stored = payload.plan as Partial<ExecutionPlan> | undefined;
      if (!stored || stored.taskId !== task.id || typeof stored.provider !== "string" || typeof stored.model !== "string") {
        throw new Error("Persisted task plan is invalid; refusing to re-plan implicitly");
      }
      plan = validatePlan(task.id, { version: stored.version, steps: stored.steps }, stored.provider, stored.model, task.risk, task.department, snapshot.catalogue, new Set(Object.keys(completedResults)), "persisted");
    } else {
      plan = await planner.plan({ id: task.id, title: task.title, objective: task.objective, department: task.department, risk: task.risk });
      await this.#store.appendEvent(task.owner_id, task.id, "task.plan_created", { plan }, "system");
    }

    const coordinator = new AgentCoordinator(snapshot.executors, this.#globalConcurrency, snapshot.catalogue);
    const results = await coordinator.execute(plan,signal,task.owner_id,completedResults,{
      onStarted:(stepId,agentId,executionId) => this.#store.appendEvent(task.owner_id,task.id,"task.step_started",{ stepId,executionId },agentId),
      onCompleted:(stepId,result,agentId,executionId) => this.#store.appendEvent(task.owner_id,task.id,"task.step_completed",{ stepId,executionId,result },agentId),
      onFailed:(stepId,agentId,executionId,errorType) => this.#store.appendEvent(task.owner_id,task.id,"task.step_failed",{ stepId,executionId,errorType },agentId),
      onWaitingApproval:(stepId,agentId,executionId) => this.#store.appendEvent(task.owner_id,task.id,"task.step_waiting_approval",{ stepId,executionId },agentId)
    });
    return { plan, results };
  }
}
