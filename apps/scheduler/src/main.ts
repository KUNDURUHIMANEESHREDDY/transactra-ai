import { PostgresTaskStore } from "../../../packages/storage/src/postgres.js";
import { OrganizationStore } from "../../../packages/storage/src/organization.js";
import { AgentRegistry } from "../../../packages/agents/src/dynamic-registry.js";
import { OperationsMonitor } from "../../../packages/organization/src/operations.js";
import { SecurityAuditor } from "../../../packages/organization/src/security.js";
import { OrganizationCycleRunner } from "../../../packages/organization/src/cycle.js";
import { DurableScheduler } from "../../../packages/scheduler/src/durable-scheduler.js";

const databaseUrl = process.env.DATABASE_URL;
const ownerId = process.env.TRANSACTRA_OWNER_ID;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!ownerId) throw new Error("TRANSACTRA_OWNER_ID is required");

function cycleIntervalMs(): number {
  const raw = Number(process.env.TRANSACTRA_CYCLE_INTERVAL_MS ?? 900000);
  if (!Number.isInteger(raw) || raw < 60000 || raw > 3600000) {
    throw new Error("TRANSACTRA_CYCLE_INTERVAL_MS must be between 60000 and 3600000");
  }
  return raw;
}

const intervalMs = cycleIntervalMs();
const store = new PostgresTaskStore(databaseUrl);
const organizationStore = new OrganizationStore(databaseUrl);
const registry = new AgentRegistry(databaseUrl);
const operations = new OperationsMonitor(databaseUrl);
const security = new SecurityAuditor(databaseUrl);
const cycle = new OrganizationCycleRunner({
  ownerId,
  store: organizationStore,
  taskStore: store,
  registry,
  operations,
  security
});
const scheduler = new DurableScheduler({ connectionString: databaseUrl, taskStore: store, ownerId });

const controller = new AbortController();
process.on("SIGINT", () => controller.abort(new Error("SIGINT")));
process.on("SIGTERM", () => controller.abort(new Error("SIGTERM")));

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void { signal.removeEventListener("abort", abort); resolve(); }
    function abort(): void { clearTimeout(timer); done(); }
    signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Runs the organisation cycle forever. A failed cycle is reported and retried on the next
 * tick; it never crashes the process and never marks a partially executed cycle complete.
 */
async function runCycles(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const result = await cycle.run();
      process.stdout.write(JSON.stringify({
        event: result.ran ? "organization_cycle_completed" : "organization_cycle_skipped",
        cycleKey: result.cycle.cycle_key,
        tasksEnqueued: result.tasksEnqueued,
        operationsFindings: result.operationsFindings,
        lifecycleActions: result.lifecycleActions,
        securityScore: result.securityScore,
        decisions: result.decisions.length
      }) + "\n");
    } catch (error) {
      process.stderr.write(JSON.stringify({
        event: "organization_cycle_failed",
        message: error instanceof Error ? error.message.slice(0,500) : "unknown"
      }) + "\n");
    }
    await delay(intervalMs, signal);
  }
}

try {
  await registry.ensureStaticAgents();
  process.stdout.write(JSON.stringify({ event: "scheduler_started", ownerId, cycleIntervalMs: intervalMs }) + "\n");
  await Promise.all([scheduler.run(controller.signal), runCycles(controller.signal)]);
} catch (error) {
  process.stderr.write(JSON.stringify({ event: "scheduler_failed", message: error instanceof Error ? error.message : "unknown" }) + "\n");
  process.exitCode = 1;
} finally {
  await Promise.allSettled([
    scheduler.close(), store.close(), organizationStore.close(),
    registry.close(), operations.close(), security.close()
  ]);
}
