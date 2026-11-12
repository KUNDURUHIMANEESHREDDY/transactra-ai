import test from "node:test";
import assert from "node:assert/strict";
import { AgentPlanner, validatePlan } from "../dist/packages/agents/src/planner.js";
import { AgentCoordinator } from "../dist/packages/agents/src/coordinator.js";
import { ApprovalRequiredError } from "../dist/packages/security/src/tool-gateway.js";

function step(id, agentId, capabilities, dependsOn = [], risk = "low") {
  return { id, agentId, objective: "Complete the bounded step and return evidence.", capabilities, risk, dependsOn };
}
const ownerId = "00000000-0000-4000-8000-000000000001";

test("planner accepts a valid dependency graph within specialist grants", () => {
  const plan = validatePlan("task-1", { version: 1, steps: [
    step("research", "product-researcher", ["research.search"]),
    step("synthesis", "innovation-architect", ["project.quality.evaluate"], ["research"])
  ] }, "unit-test", "test-model");
  assert.equal(plan.steps.length, 2);
  assert.deepEqual(plan.steps[1].dependsOn, ["research"]);
});
test("planner rejects capabilities not granted to the selected agent", () => {
  assert.throws(() => validatePlan("task-1", { version: 1, steps: [
    step("bad", "product-researcher", ["github.write"])
  ] }, "unit-test", "test-model"), /outside agent grant/);
});
test("planner rejects cycles and unknown dependencies", () => {
  assert.throws(() => validatePlan("task-1", { version: 1, steps: [
    step("a", "product-researcher", ["research.search"], ["b"]),
    step("b", "innovation-architect", ["project.quality.evaluate"], ["a"])
  ] }, "unit-test", "test-model"), /cycle/);
  assert.throws(() => validatePlan("task-1", { version: 1, steps: [
    step("a", "product-researcher", ["research.search"], ["missing"])
  ] }, "unit-test", "test-model"), /invalid dependency/);
});
test("planner cannot downgrade parent task risk", () => {
  assert.throws(() => validatePlan("task-1", { version: 1, steps: [
    step("a", "product-researcher", ["research.search"], [], "low")
  ] }, "unit-test", "test-model", "high"), /cannot be lower/);
});
test("coordinator executes dependencies before dependent agents", async () => {
  const order = [];
  const coordinator = new AgentCoordinator([
    { agentId: "product-researcher", async execute() { order.push("research"); return { evidence: 3 }; } },
    { agentId: "innovation-architect", async execute(context) { order.push("synthesis"); return context.dependencyResults.research; } }
  ]);
  const plan = validatePlan("task-2", { version: 1, steps: [
    step("research", "product-researcher", ["research.search"]),
    step("synthesis", "innovation-architect", ["project.quality.evaluate"], ["research"])
  ] }, "unit-test", "test-model");
  const result = await coordinator.execute(plan, new AbortController().signal, ownerId);
  assert.deepEqual(order, ["research", "synthesis"]);
  assert.deepEqual(result.synthesis, { evidence: 3 });
});
test("coordinator refuses to run when a real executor is missing", async () => {
  const coordinator = new AgentCoordinator([]);
  const plan = validatePlan("task-3", { version: 1, steps: [
    step("research", "product-researcher", ["research.search"])
  ] }, "unit-test", "test-model");
  await assert.rejects(() => coordinator.execute(plan, new AbortController().signal, ownerId), /No real executor/);
});
test("coordinator resumes already completed DAG nodes", async () => {
  let called = false;
  const coordinator = new AgentCoordinator([
    { agentId: "product-researcher", async execute() { called = true; return "should-not-run"; } },
    { agentId: "innovation-architect", async execute(context) { return context.dependencyResults.research; } }
  ]);
  const plan = validatePlan("task-4", { version: 1, steps: [
    step("research", "product-researcher", ["research.search"]),
    step("synthesis", "innovation-architect", ["project.quality.evaluate"], ["research"])
  ] }, "unit-test", "test-model");
  const result = await coordinator.execute(plan, new AbortController().signal, ownerId, { research: { evidence: 4 } });
  assert.equal(called, false);
  assert.deepEqual(result.synthesis, { evidence: 4 });
});

test("planner rejects an executor outside the task department", () => {
  assert.throws(() => validatePlan("task-5", { version: 1, steps: [
    step("research", "product-researcher", ["research.search"])
  ] }, "unit-test", "test-model", "low", "engineering"), /outside the task department/);
});

test("coordinator persists matching start and completion execution IDs", async () => {
  const events = [];
  const coordinator = new AgentCoordinator([
    { agentId:"product-researcher",async execute() { return { evidence:1 }; } }
  ]);
  const plan = validatePlan("task-6",{ version:1,steps:[
    step("research","product-researcher",["research.search"])
  ]},"unit-test","test-model");
  await coordinator.execute(plan,new AbortController().signal,ownerId,{},{
    onStarted:async (stepId,agentId,executionId) => events.push({ type:"started",stepId,agentId,executionId }),
    onCompleted:async (stepId,result,agentId,executionId) => events.push({ type:"completed",stepId,agentId,executionId,result })
  });
  assert.equal(events.length,2);
  assert.equal(events[0].type,"started");
  assert.equal(events[1].type,"completed");
  assert.equal(events[0].executionId,events[1].executionId);
  assert.match(events[0].executionId,/^[0-9a-f-]{36}$/i);
});

test("coordinator distinguishes approval waits from agent execution failures", async () => {
  const events = [];
  const coordinator = new AgentCoordinator([
    { agentId:"product-researcher",async execute() { throw new ApprovalRequiredError("00000000-0000-4000-8000-000000000099"); } }
  ]);
  const plan = validatePlan("task-7",{ version:1,steps:[
    step("research","product-researcher",["research.search"])
  ]},"unit-test","test-model");
  await assert.rejects(() => coordinator.execute(plan,new AbortController().signal,ownerId,{},{
    onStarted:async (stepId,agentId,executionId) => events.push({ type:"started",stepId,agentId,executionId }),
    onWaitingApproval:async (stepId,agentId,executionId) => events.push({ type:"approval",stepId,agentId,executionId }),
    onFailed:async (stepId,agentId,executionId,errorType) => events.push({ type:"failed",stepId,agentId,executionId,errorType })
  }),ApprovalRequiredError);
  assert.deepEqual(events.map((event) => event.type),["started","approval"]);
  assert.equal(events[0].executionId,events[1].executionId);
});

test("coordinator records sanitized error types without persisting error messages", async () => {
  const events = [];
  const coordinator = new AgentCoordinator([
    { agentId:"product-researcher",async execute() {
      const error = new Error("private token should not be persisted");
      error.name = "token-should-not-leak";
      throw error;
    } }
  ]);
  const plan = validatePlan("task-8",{ version:1,steps:[
    step("research","product-researcher",["research.search"])
  ]},"unit-test","test-model");
  await assert.rejects(() => coordinator.execute(plan,new AbortController().signal,ownerId,{},{
    onFailed:async (stepId,agentId,executionId,errorType) => events.push({ stepId,agentId,executionId,errorType })
  }),AggregateError);
  assert.equal(events.length,1);
  assert.equal(events[0].errorType,"Error");
  assert.equal(JSON.stringify(events).includes("private token"),false);
});

test("planner rejects steps with no declared capability", () => {
  assert.throws(() => validatePlan("task-empty-capability", { version: 1, steps: [
    step("empty", "product-researcher", [])
  ] }, "unit-test", "test-model"), /at least one granted capability/);
});


test("planner retries one invalid plan with bounded corrective context", async () => {
  let attempts = 0;
  let secondInput;
  const planner = new AgentPlanner({
    async complete(request) {
      attempts += 1;
      if (attempts === 1) {
        assert.match(request.systemPrompt, /Every step must request at least one capability/);
        return {
          output: JSON.stringify({ version: 1, steps: [step("research", "product-researcher", [])] }),
          provider: "unit-test",
          model: "test-model"
        };
      }
      secondInput = JSON.parse(request.input);
      return {
        output: JSON.stringify({ version: 1, steps: [step("research", "product-researcher", ["research.search"])] }),
        provider: "unit-test",
        model: "test-model"
      };
    }
  });
  const plan = await planner.plan({
    id: "task-retry",
    title: "Retry validation",
    objective: "Produce a valid, capability-scoped plan.",
    department: "intelligence",
    risk: "low"
  });
  assert.equal(attempts, 2);
  assert.equal(plan.steps[0].capabilities[0], "research.search");
  assert.match(secondInput.correction.validationError, /granted capability/);
  assert.ok(secondInput.correction.previousOutput.length > 0);
});

test("planner stops after its single bounded validation retry", async () => {
  let attempts = 0;
  const planner = new AgentPlanner({
    async complete() {
      attempts += 1;
      return {
        output: JSON.stringify({ version: 1, steps: [step("empty", "product-researcher", [])] }),
        provider: "unit-test",
        model: "test-model"
      };
    }
  });
  await assert.rejects(
    () => planner.plan({
      id: "task-no-infinite-retry",
      title: "Invalid plan",
      objective: "Must not dispatch.",
      department: "intelligence",
      risk: "low"
    }),
    /failed validation after 2 attempts/
  );
  assert.equal(attempts, 2);
});
