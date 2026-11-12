import test from "node:test";
import assert from "node:assert/strict";
import { PlannedTaskExecutor } from "../dist/packages/agents/src/task-executor.js";
import { STATIC_AGENT_CATALOGUE } from "../dist/packages/agents/src/catalogue.js";

function fixture(events) {
  let executions = 0;
  const appended = [];
  const store = {
    async events() { return events; },
    async appendEvent(...args) { appended.push(args); return {}; }
  };
  const workforce = {
    async refresh() {
      return {
        catalogue: STATIC_AGENT_CATALOGUE,
        executors: []
      };
    },
    supportedDepartments() { return ["intelligence"]; }
  };
  const executor = new PlannedTaskExecutor({
    store,
    providers: { async complete() { throw new Error("A persisted plan must not be regenerated implicitly"); } },
    workforce
  });
  const task = {
    id: "task-legacy-plan",
    owner_id: "00000000-0000-4000-8000-000000000001",
    title: "Resume legacy plan",
    objective: "Restore durable completed results.",
    department: "intelligence",
    risk: "low"
  };
  return { executor, task, executions: () => executions, appended };
}

const legacyPlan = {
  version: 1,
  taskId: "task-legacy-plan",
  steps: [{
    id: "research",
    agentId: "product-researcher",
    objective: "Collect bounded evidence.",
    capabilities: [],
    risk: "low",
    dependsOn: []
  }],
  provider: "persisted",
  model: "legacy"
};

test("completed legacy plan steps with empty grants restore durable results without execution", async () => {
  const completed = { sourceCount: 2, provenance: "stored-event" };
  const events = [
    { event_type: "task.plan_created", payload: { plan: legacyPlan } },
    { event_type: "task.step_completed", payload: { stepId: "research", result: completed } }
  ];
  const f = fixture(events);
  const result = await f.executor.execute(f.task, new AbortController().signal);
  assert.deepEqual(result.results, { research: completed });
  assert.equal(f.executions(), 0);
  assert.equal(f.appended.length, 0);
});

test("incomplete legacy plan steps with empty grants fail closed with operator recovery guidance", async () => {
  const f = fixture([
    { event_type: "task.plan_created", payload: { plan: legacyPlan } }
  ]);
  await assert.rejects(
    () => f.executor.execute(f.task, new AbortController().signal),
    /operator must review the original task and create a replacement task with an explicitly granted plan/
  );
  assert.equal(f.executions(), 0);
  assert.equal(f.appended.length, 0);
});
