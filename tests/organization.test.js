import test from "node:test";
import assert from "node:assert/strict";
import { validateEvolutionChanges } from "../dist/packages/organization/src/evolution.js";
import { DeploymentEngine } from "../dist/packages/organization/src/deployments.js";
import { NotificationDispatcher } from "../dist/packages/organization/src/notifications.js";
import { OrganizationCycleRunner } from "../dist/packages/organization/src/cycle.js";
import { WorkforceRuntime } from "../dist/packages/agents/src/workforce.js";

const SHA = "a".repeat(40);
const OWNER = "11111111-1111-4111-8111-111111111111";

function definition(overrides = {}) {
  return {
    id: "dynamic-agent",
    name: "Dynamic agent",
    department: "engineering",
    capabilities: ["github.issues.read"],
    maxConcurrentTasks: 1,
    systemPrompt: "Do real work with real tools.",
    lifecycleStatus: "enabled",
    ...overrides
  };
}

// ---------------------------------------------------------------- evolution schema

test("evolution change set accepts an in-scope documentation change", () => {
  const changeSet = validateEvolutionChanges({
    version: 1,
    changes: [{ path: "docs/DECISIONS.md", content: "## Decision\nUse the sandbox.\n", message: "Document sandbox decision" }]
  });
  assert.equal(changeSet.changes.length, 1);
  assert.equal(changeSet.changes[0].path, "docs/DECISIONS.md");
});

test("evolution cannot modify dependency manifests, CI permissions or key material", () => {
  for (const path of ["package.json", "pnpm-lock.yaml", ".github/workflows/ci.yml", ".github/CODEOWNERS", "secrets/prod.key", "infra/nginx/site.conf", "../outside.ts"]) {
    assert.throws(
      () => validateEvolutionChanges({ version: 1, changes: [{ path, content: "x", message: "attempt" }] }),
      /Evolution cannot|must stay within|not allowed|invalid|safe repository-relative/i,
      "expected " + path + " to be rejected"
    );
  }
});

test("evolution rejects duplicate paths, oversized changes and embedded credentials", () => {
  assert.throws(() => validateEvolutionChanges({
    version: 1,
    changes: [
      { path: "packages/organization/src/a.ts", content: "a", message: "one" },
      { path: "packages/organization/src/a.ts", content: "b", message: "two" }
    ]
  }), /duplicated/);
  assert.throws(() => validateEvolutionChanges({
    version: 1,
    changes: [{ path: "packages/organization/src/big.ts", content: "x".repeat(300000), message: "big" }]
  }), /size limit/);
  assert.throws(() => validateEvolutionChanges({
    version: 1,
    changes: [{ path: "packages/organization/src/creds.ts", content: "const token = " + ["ghp_", "0123456789abcdef0123456789abcdef"].join("") + ";", message: "creds" }]
  }), /credential/i);
  assert.throws(() => validateEvolutionChanges({ version: 2, changes: [] }), /schema version 1/);
});

// ---------------------------------------------------------------- deployments

function deploymentStore() {
  const deployments = new Map();
  return {
    deployments,
    async createDeployment(input) {
      const record = {
        id: "deployment-" + (deployments.size + 1),
        owner_id: input.ownerId,
        task_id: input.taskId ?? null,
        repository: input.repository,
        environment: input.environment,
        workflow_file: input.workflowFile,
        workflow_run_id: null,
        commit_sha: input.commitSha,
        status: "dispatched",
        approval_id: input.approvalId ?? null,
        requested_by: input.requestedBy,
        details: input.details,
        created_at: new Date(),
        updated_at: new Date()
      };
      deployments.set(record.id, record);
      return record;
    },
    async updateDeployment(_ownerId, id, update) {
      const current = deployments.get(id);
      if (!current) throw new Error("Deployment not found");
      const next = { ...current, ...update };
      deployments.set(id, next);
      return next;
    },
    async getDeployment(_ownerId, id) { return deployments.get(id) ?? null; },
    async lastSuccessfulDeployment(_ownerId, repository, environment) {
      return [...deployments.values()].reverse().find((row) =>
        row.repository === repository && row.environment === environment && row.status === "succeeded"
      ) ?? null;
    }
  };
}

function deploymentRepository(overrides = {}) {
  return {
    dispatches: [],
    async getBranchHead() { return { sha: SHA }; },
    async dispatchWorkflow(input) { this.dispatches.push(input); return { workflowRunId: "run-1" }; },
    async listWorkflowRuns() { return []; },
    ...overrides
  };
}

test("deployment dispatch pins the full commit SHA and environment input", async () => {
  const repository = deploymentRepository();
  const engine = new DeploymentEngine({ store: deploymentStore(), repository });
  const result = await engine.dispatch({ ownerId: OWNER, repository: "owner/app", environment: "production", actorId: "agent-1" });
  assert.equal(result.commitSha, SHA);
  assert.deepEqual(repository.dispatches[0].inputs, { environment: "production", commit_sha: SHA });
  assert.equal(repository.dispatches[0].workflowFile, ".github/workflows/transactra-deploy.yml");
});

test("deployment dispatch refuses a non-SHA ref and records a failed dispatch", async () => {
  const rejecting = new DeploymentEngine({
    store: deploymentStore(),
    repository: deploymentRepository({ async dispatchWorkflow() { throw new Error("workflow dispatch denied"); } })
  });
  await assert.rejects(
    () => rejecting.dispatch({ ownerId: OWNER, repository: "owner/app", environment: "staging", actorId: "agent-1" }),
    /workflow dispatch denied/
  );
  const short = new DeploymentEngine({ store: deploymentStore(), repository: deploymentRepository() });
  await assert.rejects(
    () => short.dispatch({ ownerId: OWNER, repository: "owner/app", environment: "staging", commitSha: "abc123", actorId: "agent-1" }),
    /40-character commit SHA/
  );
});

test("rollback re-dispatches the last successful commit and cannot repeat", async () => {
  const store = deploymentStore();
  const repository = deploymentRepository();
  const engine = new DeploymentEngine({ store, repository });
  const live = await engine.dispatch({ ownerId: OWNER, repository: "owner/app", environment: "production", actorId: "agent-1" });
  await store.updateDeployment(OWNER, live.deployment.id, { status: "succeeded" });
  const failing = await engine.dispatch({ ownerId: OWNER, repository: "owner/app", environment: "production", commitSha: "b".repeat(40), actorId: "agent-1" });
  await store.updateDeployment(OWNER, failing.deployment.id, { status: "failed" });

  const rollback = await engine.rollback({ ownerId: OWNER, deploymentId: failing.deployment.id, approvalId: "approval-1", actorId: "agent-1" });
  assert.equal(rollback.commitSha, SHA);
  assert.equal(rollback.previous.id, live.deployment.id);
  assert.equal(store.deployments.get(failing.deployment.id).status, "rolled_back");
  assert.deepEqual(repository.dispatches.at(-1).inputs, { environment: "production", commit_sha: SHA });

  await assert.rejects(
    () => engine.rollback({ ownerId: OWNER, deploymentId: failing.deployment.id, approvalId: "approval-2", actorId: "agent-1" }),
    /already been rolled back/
  );
});

test("rollback fails closed when no earlier successful commit exists", async () => {
  const store = deploymentStore();
  const engine = new DeploymentEngine({ store, repository: deploymentRepository() });
  const only = await engine.dispatch({ ownerId: OWNER, repository: "owner/app", environment: "production", actorId: "agent-1" });
  await store.updateDeployment(OWNER, only.deployment.id, { status: "failed" });
  await assert.rejects(
    () => engine.rollback({ ownerId: OWNER, deploymentId: only.deployment.id, approvalId: "approval-1", actorId: "agent-1" }),
    /No successful deployment/
  );
});

// ---------------------------------------------------------------- notifications

function notificationStore(rows) {
  return {
    claimed: [],
    completed: [],
    failed: [],
    async claimNotifications(_ownerId, _workerId, _limit, channels) {
      this.claimed.push(channels);
      return rows.splice(0, rows.length);
    },
    async completeNotification(id) { this.completed.push(id); },
    async failNotification(id, _workerId, error) { this.failed.push({ id, error }); }
  };
}

test("notification dispatcher only claims its own surface and shared owner channel", async () => {
  const store = notificationStore([{ id: "n1", kind: "approval_required", message: "Approve", channel: "owner" }]);
  const delivered = [];
  const dispatcher = new NotificationDispatcher({
    store, ownerId: OWNER, workerId: "telegram-1", channels: ["telegram", "owner"],
    sender: async (notification) => { delivered.push(notification.id); }
  });
  const result = await dispatcher.dispatchOnce();
  assert.deepEqual(result, { sent: 1, failed: 0 });
  assert.deepEqual(store.claimed, [["telegram", "owner"]]);
  assert.deepEqual(delivered, ["n1"]);
  assert.deepEqual(store.completed, ["n1"]);
});

test("notification dispatch records a retryable failure instead of losing the alert", async () => {
  const store = notificationStore([
    { id: "n1", kind: "alert", message: "first", channel: "owner" },
    { id: "n2", kind: "alert", message: "second", channel: "owner" }
  ]);
  const dispatcher = new NotificationDispatcher({
    store, ownerId: OWNER, workerId: "whatsapp-1", channels: ["whatsapp", "owner"],
    sender: async (notification) => { if (notification.id === "n1") throw new Error("graph api unavailable"); }
  });
  const result = await dispatcher.dispatchOnce();
  assert.deepEqual(result, { sent: 1, failed: 1 });
  assert.deepEqual(store.failed, [{ id: "n1", error: "graph api unavailable" }]);
  assert.deepEqual(store.completed, ["n2"]);
});

test("aborted notification dispatch claims nothing", async () => {
  const store = notificationStore([{ id: "n1", kind: "alert", message: "first", channel: "owner" }]);
  const controller = new AbortController();
  controller.abort(new Error("shutdown"));
  const dispatcher = new NotificationDispatcher({ store, ownerId: OWNER, workerId: "w", channels: ["owner"], sender: async () => {} });
  assert.deepEqual(await dispatcher.dispatchOnce(controller.signal), { sent: 0, failed: 0 });
  assert.deepEqual(store.claimed, []);
});

test("notification dispatcher rejects an empty or malformed channel set", () => {
  assert.throws(() => new NotificationDispatcher({ store: notificationStore([]), ownerId: OWNER, workerId: "w", channels: [], sender: async () => {} }), /at least one channel/);
  assert.throws(() => new NotificationDispatcher({ store: notificationStore([]), ownerId: OWNER, workerId: "w", channels: ["Owner"], sender: async () => {} }), /lowercase/);
});

// ---------------------------------------------------------------- organisation cycle

function cycleStores(options = {}) {
  const enqueued = [];
  const states = new Map();
  return {
    enqueued,
    store: {
      async startCycle(ownerId, cycleKey) {
        if (options.existingCycle) return { created: false, cycle: { ...options.existingCycle, cycle_key: cycleKey } };
        return { created: true, cycle: { id: "cycle-1", owner_id: ownerId, cycle_key: cycleKey, status: "running", decisions: [], tasks_enqueued: 0, error: null, started_at: new Date(), completed_at: null } };
      },
      async getState(key) { return states.get(key) ?? null; },
      async setState(key, value) { states.set(key, value); },
      async recordIncident() { throw new Error("no critical finding expected"); },
      async openIncidentCounts() { return { critical: 0, warning: 0, info: 0 }; },
      async finishCycle(_id, input) { this.finished = input; }
    },
    taskStore: {
      async enqueue(input) {
        enqueued.push(input);
        return { created: true, task: { id: "task-" + enqueued.length, status: "queued" } };
      }
    }
  };
}

function cycleRegistry() {
  return {
    async applySafeLifecycleTransitions() { return []; },
    async list() { return []; }
  };
}

test("a completed organisation cycle is not replayed", async () => {
  const { store, taskStore } = cycleStores({ existingCycle: { id: "cycle-1", status: "completed", decisions: [{ key: "prior" }], tasks_enqueued: 2 } });
  const runner = new OrganizationCycleRunner({
    ownerId: OWNER, store, taskStore,
    registry: cycleRegistry(),
    operations: { async run() { throw new Error("operations must not rerun a completed cycle"); } },
    now: () => new Date("2026-11-08T10:05:00.000Z")
  });
  const result = await runner.run();
  assert.equal(result.ran, false);
  assert.equal(result.tasksEnqueued, 2);
  assert.deepEqual(result.cycle.decisions, [{ key: "prior" }]);
});

test("organisation cycle enqueues due work with deterministic idempotency keys", async () => {
  const { store, taskStore, enqueued } = cycleStores();
  const runner = new OrganizationCycleRunner({
    ownerId: OWNER, store, taskStore,
    registry: cycleRegistry(),
    operations: { async run() { return { findings: [{ key: "queued-age" }], notificationsQueued: 1 }; } },
    now: () => new Date("2026-11-08T10:05:00.000Z")
  });
  const result = await runner.run();
  assert.equal(result.ran, true);
  assert.equal(result.operationsFindings, 1);
  const keys = enqueued.map((task) => task.idempotencyKey);
  assert.ok(keys.includes("security:6h:2026-11-08T10"));
  assert.ok(keys.includes("evolution:weekly:2026-11-08"));
  assert.ok(keys.includes("workforce:coverage:2026-11-08"));
  assert.equal(store.finished.status, "completed");
  assert.equal(store.finished.tasksEnqueued, result.tasksEnqueued);
});

test("organisation cycle marks a failed run and rethrows so the scheduler can retry", async () => {
  const { store, taskStore } = cycleStores();
  const runner = new OrganizationCycleRunner({
    ownerId: OWNER, store, taskStore,
    registry: cycleRegistry(),
    operations: { async run() { throw new Error("database unavailable"); } },
    now: () => new Date("2026-11-08T11:05:00.000Z")
  });
  await assert.rejects(() => runner.run(), /database unavailable/);
  assert.equal(store.finished.status, "failed");
});

// ---------------------------------------------------------------- workforce surface

test("workforce excludes agents whose capability grant is not fully registered", async () => {
  const registry = {
    async definitions() {
      return [
        definition({ id: "fully-registered", capabilities: ["github.issues.read", "memory.write"] }),
        definition({ id: "partially-registered", capabilities: ["github.issues.read", "deployment.dispatch"] }),
        definition({ id: "no-capabilities", capabilities: [] })
      ];
    }
  };
  const workforce = new WorkforceRuntime({
    registry,
    providers: { async complete() { throw new Error("not used"); } },
    tools: { async invoke() { throw new Error("not used"); } },
    availableCapabilities: ["github.issues.read", "memory.write"]
  });
  const snapshot = await workforce.refresh(true);
  assert.deepEqual(snapshot.definitions.map((entry) => entry.id), ["fully-registered"]);
});
