import type { ClaimedTask, PostgresTaskStore } from "../../storage/src/postgres.js";
import type { TaskDepartment } from "../../contracts/src/index.js";
import { ApprovalRequiredError } from "../../security/src/tool-gateway.js";
import { assertNoLikelySecrets } from "../../security/src/secrets.js";

export interface TaskExecutor {
  readonly supportedDepartments: readonly TaskDepartment[];
  departments?(): Promise<readonly TaskDepartment[]>;
  execute(task: ClaimedTask, signal: AbortSignal): Promise<unknown>;
}
export interface WorkerOptions {
  workerId: string;
  leaseSeconds?: number;
  idlePollMs?: number;
  retryDelaySeconds?: number;
}

export class TaskWorker {
  readonly #store: PostgresTaskStore;
  readonly #executor: TaskExecutor;
  readonly #options: Required<WorkerOptions>;

  constructor(store: PostgresTaskStore, executor: TaskExecutor, options: WorkerOptions) {
    if (!options.workerId.trim()) throw new Error("workerId is required");
    this.#store = store;
    this.#executor = executor;
    this.#options = {
      workerId: options.workerId,
      leaseSeconds: options.leaseSeconds ?? 60,
      idlePollMs: options.idlePollMs ?? 1500,
      retryDelaySeconds: options.retryDelaySeconds ?? 30
    };
    if (!Number.isInteger(this.#options.idlePollMs) || this.#options.idlePollMs < 100 || this.#options.idlePollMs > 60000) {
      throw new Error("idlePollMs must be between 100 and 60000");
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const departments = this.#executor.departments ? await this.#executor.departments() : this.#executor.supportedDepartments;
      if (departments.length === 0) {
        await this.#delay(this.#options.idlePollMs, signal);
        continue;
      }
      const task = await this.#store.claimNext(this.#options.workerId, this.#options.leaseSeconds, departments);
      if (!task) {
        await this.#delay(this.#options.idlePollMs, signal);
        continue;
      }
      const leaseLost = new AbortController();
      const executionSignal = AbortSignal.any([signal, leaseLost.signal]);
      let renewing = false;
      const heartbeatMs = Math.max(1000, Math.floor(this.#options.leaseSeconds * 1000 / 3));
      const heartbeat = setInterval(() => {
        if (renewing || leaseLost.signal.aborted) return;
        renewing = true;
        void this.#store.renewLease(task.id, this.#options.workerId, this.#options.leaseSeconds)
          .then((renewed) => { if (!renewed) leaseLost.abort(new Error("Task lease lost")); })
          .catch(() => leaseLost.abort(new Error("Task lease renewal failed")))
          .finally(() => { renewing = false; });
      }, heartbeatMs);
      try {
        const result = await this.#executor.execute(task, executionSignal);
        if (leaseLost.signal.aborted) throw leaseLost.signal.reason ?? new Error("Task lease lost");
        if (signal.aborted) {
          await this.#store.fail(task.id, this.#options.workerId, { message: "Worker shutting down" }, 0);
        } else {
          await this.#store.finish(task.id, this.#options.workerId, result);
        }
      } catch (error) {
        try {
          if (error instanceof ApprovalRequiredError) {
            await this.#store.awaitApproval(task.id, this.#options.workerId, error.approvalId);
          } else {
            await this.#store.fail(task.id, this.#options.workerId, this.#serializeError(error), this.#options.retryDelaySeconds);
          }
        } catch (leaseError) {
          process.stderr.write(JSON.stringify({ event: "worker_task_recovery_error", taskId: task.id, error: this.#serializeError(leaseError) }) + "\n");
        }
      } finally {
        clearInterval(heartbeat);
      }
    }
  }

  #serializeError(error: unknown): { name: string; message: string } {
    const value = error instanceof Error ? { name: error.name, message: error.message } : { name: "UnknownError", message: String(error) };
    try { assertNoLikelySecrets(JSON.stringify(value) ?? "null", "Worker error"); return value; }
    catch { return { name: value.name, message: "redacted_error" }; }
  }

  async #delay(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void { signal.removeEventListener("abort", abort); resolve(); }
      function abort(): void { clearTimeout(timer); done(); }
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}
