import { completeNvidiaNim, isNvidiaNimDeveloperAccessConfirmed } from "./nvidia-nim.mjs";
import { validateToolInput, isSideEffectStep } from "./tool-adapters.mjs";

const AGENTS = new Set(["researcher", "analyst", "builder", "operator", "verifier"]);
const TOOLS = new Set(["web_research", "data_analysis", "repository_read", "repository_write", "telegram_notify", "none"]);
const MAX_STEPS = 8;
const MAX_DESCRIPTION = 4000;


/**
 * Validate the persisted plan again at dispatch time. The D1 row is durable
 * state, not a trust boundary: it may be stale, malformed, or manually edited.
 */
export function validateApprovedExecutionPlan(plan) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.steps)
      || plan.steps.length < 1 || plan.steps.length > MAX_STEPS) {
    throw new Error("Stored execution plan failed step-count validation");
  }
  const steps = plan.steps.map((step, index) => {
    const expectedId = "step-" + (index + 1);
    if (!step || step.id !== expectedId || !AGENTS.has(step.agent) || !TOOLS.has(step.tool)
        || typeof step.description !== "string" || !step.description.trim()
        || step.description.length > 500
        || typeof step.acceptance_criteria !== "string" || !step.acceptance_criteria.trim()
        || step.acceptance_criteria.length > 500
        || !["low", "medium", "high"].includes(step.risk)
        || !Array.isArray(step.depends_on)
        || new Set(step.depends_on).size !== step.depends_on.length
        || step.depends_on.some((dependency) => !Number.isInteger(dependency)
          || dependency < 1 || dependency > index)) {
      throw new Error("Stored plan step " + (index + 1) + " failed agent, tool, dependency, or safety validation");
    }
    let toolInput;
    try { toolInput = validateToolInput(step.tool, step.tool_input || {}); }
    catch (error) { throw new Error("Stored plan step " + (index + 1) + " has invalid tool input: " + String(error?.message || "invalid input")); }
    if (isSideEffectStep(step) && step.risk !== "high") {
      throw new Error("Stored plan side-effect step " + (index + 1) + " must be classified high risk");
    }
    return {
      ...step,
      description: step.description.trim(),
      acceptance_criteria: step.acceptance_criteria.trim(),
      tool_input: toolInput,
      depends_on: [...step.depends_on],
    };
  });
  return { ...plan, steps };
}

/** High-risk and side-effect steps always need a separate owner decision. */
export function requiresOwnerStepApproval(step) {
  return step?.risk === "high" || isSideEffectStep(step);
}

const SYSTEM_PROMPT = [
  "You are Transactra's task-planning controller. Return only a JSON object, no markdown.",
  "Convert the owner's objective into a safe, executable, ordered plan.",
  "Use only agent values researcher, analyst, builder, operator, verifier.",
  "Use only tool values web_research, data_analysis, repository_read, repository_write, telegram_notify, none.",
  "Do not claim tools or agents have executed. This is a proposal only.",
  "Every step must have a measurable acceptance_criteria string.",
  "Never include secrets, credentials, or instructions to bypass approvals, safety gates, budgets, or access controls.",
  "External side effects, repository writes, owner notifications and destructive operations must be marked high risk and require a separate explicit approval.",
  "Include tool_input for every tool: web_research {query}, repository_read {path}, repository_write {path,content,message,expected_sha,branch:'main'}, telegram_notify {message}, data_analysis {} or none {}.",
  "Never target staging or production infrastructure, never write secrets/configuration files, and never put credentials in tool_input.",
  "Return schema: { title:string, objective:string, steps:[{agent:string,tool:string,tool_input:object,description:string,acceptance_criteria:string,risk:'low'|'medium'|'high',depends_on:number[]}] }.",
].join(" ");

function fallbackPlan(objective, reason = "Model planning is disabled; deterministic draft only.") {
  const fragments = objective.split(/(?:\r?\n+|(?<=[.!?])\s+|;\s+)/).map((s) => s.trim()).filter(Boolean).slice(0, MAX_STEPS);
  const steps = (fragments.length ? fragments : [objective]).map((description, index) => ({
    id: "step-" + (index + 1),
    agent: "analyst",
    tool: "none",
    description: description.slice(0, 500),
    acceptance_criteria: "Produce a reviewable result that directly addresses this step; report evidence and unresolved risks.",
    risk: "medium",
    depends_on: index ? [index] : [],
    tool_input: {},
    status: "blocked_pending_approval",
  }));
  return {
    version: 2, controller: "transactra-central-orchestrator", mode: "deterministic_fallback",
    objective, title: objective.slice(0, 120), steps,
    review: { status: "pending", required: true },
    execution: { enabled: false, reason },
  };
}

function parseAndValidatePlan(raw, objective) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Planner output was not valid JSON"); }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.steps)
      || typeof parsed.title !== "string" || typeof parsed.objective !== "string"
      || parsed.steps.length < 1 || parsed.steps.length > MAX_STEPS) {
    throw new Error("Planner output did not match the required plan schema");
  }
  const steps = parsed.steps.map((step, index) => {
    if (!step || !AGENTS.has(step.agent) || !TOOLS.has(step.tool)
        || typeof step.description !== "string" || !step.description.trim()
        || typeof step.acceptance_criteria !== "string" || !step.acceptance_criteria.trim()
        || !["low", "medium", "high"].includes(step.risk)
        || !Array.isArray(step.depends_on)
        || new Set(step.depends_on).size !== step.depends_on.length
        || step.depends_on.some((n) => !Number.isInteger(n) || n < 1 || n > index)) {
      throw new Error("Planner step " + (index + 1) + " failed agent, tool, dependency, or safety validation");
    }
    let toolInput;
    try { toolInput = validateToolInput(step.tool, step.tool_input || {}); }
    catch (error) { throw new Error("Planner step " + (index + 1) + " has invalid tool input: " + String(error?.message || "invalid input")); }
    if (isSideEffectStep(step) && step.risk !== "high") {
      throw new Error("Planner side-effect step " + (index + 1) + " must be classified high risk");
    }
    return {
      id: "step-" + (index + 1), agent: step.agent, tool: step.tool,
      description: step.description.trim().slice(0, 500),
      acceptance_criteria: step.acceptance_criteria.trim().slice(0, 500),
      risk: step.risk, depends_on: step.depends_on, tool_input: toolInput,
      status: "blocked_pending_approval",
    };
  });
  return {
    version: 2, controller: "transactra-central-orchestrator", mode: "model_proposed",
    objective, title: parsed.title.trim().slice(0, 120) || objective.slice(0, 120),
    steps, review: { status: "pending", required: true },
    execution: { enabled: false, reason: "Plan proposal only; owner approval and a separately enabled execution runtime are required." },
  };
}

export async function createOrchestratorPlan(env, db, objective, memoryRows = []) {
  const cleanObjective = String(objective || "").trim().slice(0, MAX_DESCRIPTION);
  if (!cleanObjective) throw new Error("Task objective is required");
  const modelEnabled = env.TRANSACTRA_MODEL_ORCHESTRATOR_ENABLED === "true"
    && env.NVIDIA_NIM_PLANNING_ENABLED === "true";
  if (!modelEnabled) return fallbackPlan(cleanObjective);
  if (!isNvidiaNimDeveloperAccessConfirmed(env)) return fallbackPlan(cleanObjective, "Model planning is enabled by configuration but NVIDIA Developer Program access verification is not current; inference was not attempted.");
  const memory = memoryRows.slice(0, 8).map((item) =>
    String(item.memory_key).slice(0, 80) + ": " + String(item.memory_value).slice(0, 240)
  ).join("\n");
  const inputData = {
    objective: cleanObjective.slice(0, 2400),
    owner_memory_reference_only: memory,
    constraints: ["Do not execute tools", "Do not bypass approval", "Return a valid JSON plan", "No production actions"],
  };
  // Keep JSON plus system prompt safely below the NVIDIA adapter's 8 KB input ceiling.
  while (new TextEncoder().encode(JSON.stringify(inputData)).byteLength > 6500 && inputData.owner_memory_reference_only) {
    inputData.owner_memory_reference_only = inputData.owner_memory_reference_only.slice(0, -200);
  }
  while (new TextEncoder().encode(JSON.stringify(inputData)).byteLength > 6500 && inputData.objective.length > 500) {
    inputData.objective = inputData.objective.slice(0, -250);
  }
  const input = JSON.stringify(inputData);
  try {
    const completion = await completeNvidiaNim(env, {
      systemPrompt: SYSTEM_PROMPT,
      input,
      maxOutputTokens: 900,
      estimatedCostInr: 0,
    });
    return parseAndValidatePlan(completion.output, cleanObjective);
  } catch (error) {
    // Invalid model output or provider failure never turns into execution.
    return fallbackPlan(cleanObjective, "Model planning failed closed: " + String(error?.message || "unknown error").slice(0, 240));
  }
}

export async function evaluateOrchestratorStep(env, db, input) {
  const evidence = {
    objective: String(input?.objective || "").slice(0, 1200),
    step: input?.step || {},
    result: String(input?.result || "").slice(0, 3000),
  };
  if (requiresOwnerStepApproval(input?.step) && input?.stepApprovalVerified !== true) {
    return {
      decision: "human_review", accepted: false,
      rationale: "High-risk or side-effect steps require a separate explicit owner approval; task-level approval is not sufficient.",
      evidence_required: ["separate owner approval for this step", "step acceptance criteria", "verifiable result or artifact"],
    };
  }
  if (requiresOwnerStepApproval(input?.step) && input?.stepApprovalVerified === true) {
    let adapterEvidence;
    try { adapterEvidence = JSON.parse(String(input?.result || "")); } catch { adapterEvidence = null; }
    if (adapterEvidence?.tool === input.step.tool && adapterEvidence?.adapter_status === "completed" && typeof adapterEvidence?.adapter_output === "string" && adapterEvidence.adapter_output.length > 0) {
      return {
        decision: "accepted", accepted: true,
        rationale: "The exact owner-approved tool action completed and returned a verifiable adapter response.",
        evidence_required: [],
      };
    }
    return {
      decision: "human_review", accepted: false,
      rationale: "Owner-approved action did not return a verifiable completed adapter response.",
      evidence_required: ["manual verification of the external side effect", "result artifact or provider confirmation"],
    };
  }
  if (env.TRANSACTRA_AGENT_EXECUTION_ENABLED !== "true"
      || env.NVIDIA_NIM_EXECUTION_ENABLED !== "true"
      || !isNvidiaNimDeveloperAccessConfirmed(env)) {
    return {
      decision: "human_review",
      accepted: false,
      rationale: "Model-based result evaluation is locked until explicit agent-execution flags and NVIDIA Developer Program access verification is current.",
      evidence_required: ["step acceptance criteria", "verifiable result or artifact"],
    };
  }
  try {
    const completion = await completeNvidiaNim(env, {
      systemPrompt: "Evaluate task-step evidence against the acceptance criteria. Return only JSON: {decision:'accepted'|'retry'|'replan'|'human_review',rationale:string,evidence_gaps:string[]}. Never claim to have executed tools. Choose accepted only when evidence directly satisfies criteria. High-risk or external side effects always require human review.",
      input: JSON.stringify(evidence),
      maxOutputTokens: 350,
      estimatedCostInr: 0,
    });
    const value = JSON.parse(completion.output);
    if (!value || !["accepted", "retry", "replan", "human_review"].includes(value.decision)
        || typeof value.rationale !== "string" || !Array.isArray(value.evidence_gaps)
        || value.evidence_gaps.some((item) => typeof item !== "string")) {
      throw new Error("Evaluator output failed schema validation");
    }
    return {
      decision: value.decision,
      accepted: value.decision === "accepted",
      rationale: value.rationale.slice(0, 600),
      evidence_required: value.evidence_gaps.slice(0, 8).map((item) => item.slice(0, 240)),
    };
  } catch (error) {
    return {
      decision: "human_review",
      accepted: false,
      rationale: "Evaluation failed closed: " + String(error?.message || "unknown error").slice(0, 200),
      evidence_required: ["manual owner review"],
    };
  }
}

export async function replanOrchestratorFailure(env, db, objective, failedStep, failureReason, memoryRows = []) {
  const recoveryObjective = [
    "Replan this task after a failed step. Preserve the original objective and completed work.",
    "Do not repeat a failed action without addressing its cause. Add explicit verification and rollback/containment steps when relevant.",
    "Original objective: " + String(objective || "").slice(0, 1800),
    "Failed step: " + JSON.stringify(failedStep || {}).slice(0, 700),
    "Failure: " + String(failureReason || "unspecified failure").slice(0, 700),
  ].join("\n\n").slice(0, MAX_DESCRIPTION);
  const plan = await createOrchestratorPlan(env, db, recoveryObjective, memoryRows);
  return {
    ...plan,
    mode: plan.mode === "model_proposed" ? "model_replanned" : "deterministic_recovery_draft",
    recovery: { reason: String(failureReason || "unspecified failure").slice(0, 500), requires_owner_review: true },
    review: { status: "pending", required: true },
    execution: { enabled: false, reason: "Recovery plan is a proposal; owner review and approval are required before any dispatch." },
  };
}

export const ORCHESTRATOR_POLICY = Object.freeze({
  maxSteps: MAX_STEPS,
  allowedAgents: [...AGENTS],
  allowedTools: [...TOOLS],
  executionRequiresApproval: true,
  modelPlanningRequiresVerifiedDeveloperAccess: true,
  modelPlanningRequiresExplicitFlags: true,
});
