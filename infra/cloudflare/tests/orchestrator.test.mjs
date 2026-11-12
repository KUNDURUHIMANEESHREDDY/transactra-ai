import test from "node:test";
import assert from "node:assert/strict";
import { createOrchestratorPlan, evaluateOrchestratorStep, replanOrchestratorFailure, ORCHESTRATOR_POLICY, validateApprovedExecutionPlan, requiresOwnerStepApproval } from "../src/orchestrator.mjs";

test("creates a deterministic, approval-gated fallback when model planning is disabled", async () => {
  const plan = await createOrchestratorPlan({}, {}, "Prepare a release checklist");
  assert.equal(plan.version, 2);
  assert.equal(plan.controller, "transactra-central-orchestrator");
  assert.equal(plan.mode, "deterministic_fallback");
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].status, "blocked_pending_approval");
  assert.equal(plan.review.required, true);
  assert.equal(plan.execution.enabled, false);
});

test("does not call inference when explicit model flags are absent", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected inference"); };
  try {
    const plan = await createOrchestratorPlan({
      NVIDIA_NIM_FREE_TIER_VERIFIED_AT: new Date().toISOString(),
      NVIDIA_NIM_API_KEY: "test",
      NVIDIA_NIM_MODEL: "stepfun-ai/step-5-preview",
    }, {}, "Analyze this project");
    assert.equal(plan.mode, "deterministic_fallback");
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("does not call inference when free entitlement is not verified", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected inference"); };
  try {
    const plan = await createOrchestratorPlan({
      TRANSACTRA_MODEL_ORCHESTRATOR_ENABLED: "true",
      NVIDIA_NIM_PLANNING_ENABLED: "true",
      NVIDIA_NIM_API_KEY: "test",
      NVIDIA_NIM_MODEL: "test-model",
    }, {}, "Analyze this project");
    assert.equal(plan.mode, "deterministic_fallback");
    assert.match(plan.execution.reason, /NVIDIA Developer Program access verification is not current/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("exposes bounded agent and tool routing policy with approval required", () => {
  assert.equal(ORCHESTRATOR_POLICY.maxSteps, 8);
  assert.equal(ORCHESTRATOR_POLICY.executionRequiresApproval, true);
  assert.equal(ORCHESTRATOR_POLICY.modelPlanningRequiresVerifiedDeveloperAccess, true);
  assert.ok(ORCHESTRATOR_POLICY.allowedAgents.includes("verifier"));
  assert.ok(!ORCHESTRATOR_POLICY.allowedTools.includes("cloudflare_staging"));
  assert.ok(ORCHESTRATOR_POLICY.allowedTools.includes("repository_read"));
  assert.ok(ORCHESTRATOR_POLICY.allowedTools.includes("repository_write"));
});

test("result evaluation fails closed to human review while model planning is locked", async () => {
  const result = await evaluateOrchestratorStep({}, {}, {
    objective: "Build a tested feature",
    step: { acceptance_criteria: "Tests pass" },
    result: "Done",
  });
  assert.equal(result.decision, "human_review");
  assert.equal(result.accepted, false);
});

test("failure replanning creates a new review-gated proposal without dispatch", async () => {
  const plan = await replanOrchestratorFailure({}, {}, "Deploy staging", {
    description: "Run acceptance tests",
  }, "Health check timed out");
  assert.equal(plan.mode, "deterministic_recovery_draft");
  assert.equal(plan.recovery.requires_owner_review, true);
  assert.equal(plan.review.required, true);
  assert.equal(plan.execution.enabled, false);
  assert.match(plan.objective, /Health check timed out/);
});


test("dispatch-time plan validation rejects unsafe tools and invalid dependency graphs", () => {
  const valid = {
    version: 2,
    steps: [
      { id: "step-1", agent: "researcher", tool: "none", description: "Research", acceptance_criteria: "Evidence exists", risk: "low", depends_on: [] },
      { id: "step-2", agent: "analyst", tool: "none", description: "Analyze", acceptance_criteria: "Analysis cites evidence", risk: "medium", depends_on: [1] },
    ],
  };
  assert.equal(validateApprovedExecutionPlan(valid).steps.length, 2);
  assert.throws(() => validateApprovedExecutionPlan({
    ...valid, steps: [{ ...valid.steps[0], tool: "shell_exec" }],
  }), /failed agent, tool, dependency, or safety validation/);
  assert.throws(() => validateApprovedExecutionPlan({
    ...valid, steps: [{ ...valid.steps[0] }, { ...valid.steps[1], depends_on: [1, 1] }],
  }), /failed agent, tool, dependency, or safety validation/);
  assert.throws(() => validateApprovedExecutionPlan({
    ...valid, steps: [{ ...valid.steps[0] }, { ...valid.steps[1], depends_on: [2] }],
  }), /failed agent, tool, dependency, or safety validation/);
});

test("high-risk and side-effect steps always require separate owner approval", () => {
  assert.equal(requiresOwnerStepApproval({ risk: "high", tool: "none" }), true);
  assert.equal(requiresOwnerStepApproval({ risk: "low", tool: "repository_write" }), true);
  assert.equal(requiresOwnerStepApproval({ risk: "medium", tool: "none" }), false);
});

test("model evaluator cannot approve a high-risk step even when inference is enabled", async () => {
  const result = await evaluateOrchestratorStep({
    TRANSACTRA_AGENT_EXECUTION_ENABLED: "true",
    NVIDIA_NIM_EXECUTION_ENABLED: "true",
    NVIDIA_NIM_FREE_TIER_VERIFIED_AT: new Date().toISOString(),
  }, {}, {
    objective: "Deploy a production release",
    step: { risk: "high", tool: "none", acceptance_criteria: "Release is healthy" },
    result: "Release is healthy",
  });
  assert.equal(result.decision, "human_review");
  assert.equal(result.accepted, false);
  assert.match(result.rationale, /separate explicit owner approval/);
});

test("approved side-effect result is accepted only when the adapter confirms completion", async () => {
  const step = { risk: "high", tool: "repository_write" };
  const accepted = await evaluateOrchestratorStep({}, {}, {
    objective: "Write an approved source file",
    step,
    stepApprovalVerified: true,
    result: JSON.stringify({ tool: "repository_write", adapter_status: "completed", adapter_output: '{"commit":"abc"}' }),
  });
  assert.equal(accepted.decision, "accepted");
  const blocked = await evaluateOrchestratorStep({}, {}, {
    objective: "Write an approved source file",
    step,
    stepApprovalVerified: true,
    result: "The write probably succeeded",
  });
  assert.equal(blocked.decision, "human_review");
});

test("dispatch-time plan validation rejects staging tools in production-only mode", () => {
  const staging = { version: 2, steps: [{ id: "step-1", agent: "operator", tool: "cloudflare_staging", tool_input: { environment: "staging", operation: "verify" }, description: "Verify", acceptance_criteria: "Health is ready", risk: "low", depends_on: [] }] };
  assert.throws(() => validateApprovedExecutionPlan(staging), /failed agent, tool, dependency, or safety validation/);
});
