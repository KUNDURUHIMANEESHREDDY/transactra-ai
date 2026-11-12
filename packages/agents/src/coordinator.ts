import { randomUUID } from "node:crypto";
import type { ExecutionPlan, PlannedStep } from "./planner.js";
import { STATIC_AGENT_CATALOGUE, type AgentCatalogue } from "./catalogue.js";
import { ApprovalRequiredError } from "../../security/src/tool-gateway.js";

export interface AgentExecutionContext {
  taskId: string;
  ownerId: string;
  step: PlannedStep;
  dependencyResults: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}
export interface StepLifecycleHandlers {
  onStarted?: (stepId: string,agentId: string,executionId: string) => Promise<void>;
  onCompleted?: (stepId: string,result: unknown,agentId: string,executionId: string) => Promise<void>;
  onFailed?: (stepId: string,agentId: string,executionId: string,errorType: string) => Promise<void>;
  onWaitingApproval?: (stepId: string,agentId: string,executionId: string) => Promise<void>;
}
export interface AgentExecutor {
  readonly agentId: string;
  execute(context: AgentExecutionContext): Promise<unknown>;
}

function safeErrorType(error: Error): string {
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error";
}
class Semaphore {
  #active = 0;
  readonly #limit: number;
  readonly #waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal: AbortSignal;
    abort: () => void;
  }> = [];
  constructor(limit: number) { this.#limit = limit; }

  async #acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw signal.reason ?? new Error("Execution cancelled");
    if (this.#active < this.#limit) {
      this.#active += 1;
      return this.#releaseFactory();
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter = {
        resolve, reject, signal,
        abort: () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(signal.reason instanceof Error ? signal.reason : new Error("Execution cancelled"));
        }
      };
      this.#waiters.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
    });
  }

  #releaseFactory(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (next) {
        next.signal.removeEventListener("abort", next.abort);
        next.resolve(this.#releaseFactory());
      } else {
        this.#active -= 1;
      }
    };
  }

  async run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const release = await this.#acquire(signal);
    try {
      if (signal.aborted) throw signal.reason ?? new Error("Execution cancelled");
      return await operation();
    } finally { release(); }
  }
}

export class AgentCoordinator {
  readonly #executors: ReadonlyMap<string, AgentExecutor>;
  readonly #semaphores: Map<string, Semaphore>;
  readonly #global: Semaphore;
  readonly #catalogue: AgentCatalogue;
  constructor(executors: readonly AgentExecutor[], globalConcurrency = 6, catalogue: AgentCatalogue = STATIC_AGENT_CATALOGUE) {
    if (!Number.isInteger(globalConcurrency) || globalConcurrency < 1 || globalConcurrency > 24) throw new Error("globalConcurrency must be between 1 and 24");
    this.#executors = new Map(executors.map((executor) => [executor.agentId, executor]));
    if (this.#executors.size !== executors.length) throw new Error("Duplicate agent executor registration");
    this.#semaphores = new Map();
    this.#global = new Semaphore(globalConcurrency);
    this.#catalogue = catalogue;
  }

  async execute(plan: ExecutionPlan, signal: AbortSignal, ownerId: string, completedResults: Readonly<Record<string, unknown>> = {}, handlers: StepLifecycleHandlers = {}): Promise<Readonly<Record<string, unknown>>> {
    for (const step of plan.steps) {
      const alreadyCompleted = Object.prototype.hasOwnProperty.call(completedResults, step.id);
      if (alreadyCompleted) continue;
      const agent = this.#catalogue.get(step.agentId);
      if (!agent || !this.#executors.has(step.agentId)) throw new Error("No real executor is registered for agent " + step.agentId);
      if (step.capabilities.length === 0) {
        throw new Error("Incomplete plan step has no capability grant; refusing execution until an operator creates a replacement task with an explicit grant");
      }
      if (step.capabilities.some((capability) => !agent.capabilities.includes(capability))) throw new Error("Plan exceeds agent capability grant");
      if (!this.#semaphores.has(agent.id)) this.#semaphores.set(agent.id, new Semaphore(agent.maxConcurrentTasks));
    }
    const planIds = new Set(plan.steps.map((step) => step.id));
    for (const id of Object.keys(completedResults)) if (!planIds.has(id)) throw new Error("Persisted step result does not belong to this execution plan");
    const pending = new Map(plan.steps.filter((step) => !(step.id in completedResults)).map((step) => [step.id, step]));
    const results = new Map<string, unknown>(Object.entries(completedResults));
    while (pending.size > 0) {
      if (signal.aborted) throw signal.reason ?? new Error("Execution cancelled");
      const ready = [...pending.values()].filter((step) => step.dependsOn.every((id) => results.has(id)));
      if (ready.length === 0) throw new Error("Execution plan is blocked by a dependency cycle or missing result");
      const outcomes = await Promise.all(ready.map(async (step) => {
        const executionId = randomUUID();
        try {
          const executor = this.#executors.get(step.agentId);
          const semaphore = this.#semaphores.get(step.agentId);
          if (!executor || !semaphore) throw new Error("Agent executor unavailable: " + step.agentId);
          const dependencyResults = Object.fromEntries(step.dependsOn.map((id) => [id, results.get(id)]));
          const result = await semaphore.run(
            () => this.#global.run(async () => {
              await handlers.onStarted?.(step.id,step.agentId,executionId);
              return executor.execute({ taskId: plan.taskId, ownerId, step, dependencyResults, signal });
            },signal),
            signal
          );
          return { status:"fulfilled" as const,step,executionId,result };
        } catch (error) {
          return { status:"rejected" as const,step,executionId,error };
        }
      }));
      const failures: Error[] = [];
      for (const outcome of outcomes) {
        const step = outcome.step;
        if (outcome.status === "fulfilled") {
          try {
            await handlers.onCompleted?.(step.id,outcome.result,step.agentId,outcome.executionId);
            results.set(step.id,outcome.result);
            pending.delete(step.id);
          } catch (error) {
            failures.push(error instanceof Error ? error : new Error(String(error)));
          }
        } else {
          const failure = outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
          try {
            if (failure instanceof ApprovalRequiredError) await handlers.onWaitingApproval?.(step.id,step.agentId,outcome.executionId);
            else if (!signal.aborted) await handlers.onFailed?.(step.id,step.agentId,outcome.executionId,safeErrorType(failure));
          } catch (eventError) {
            failures.push(eventError instanceof Error ? eventError : new Error(String(eventError)));
          }
          failures.push(failure);
        }
      }
      if (failures.length > 0) {
        const approvalRequired = failures.find((failure): failure is ApprovalRequiredError => failure instanceof ApprovalRequiredError);
        if (approvalRequired) throw approvalRequired;
        throw new AggregateError(failures, "One or more agent steps failed; dependent steps were not started");
      }
    }
    return Object.freeze(Object.fromEntries(results));
  }
}
