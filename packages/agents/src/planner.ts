import type { RiskLevel, TaskDepartment } from "../../contracts/src/index.js";
import type { ProviderRouter } from "../../providers/src/router.js";
import { buildAgentCatalogue, STATIC_AGENT_CATALOGUE, type AgentCatalogue } from "./catalogue.js";

export interface PlanningTask { id: string; title: string; objective: string; department: TaskDepartment; risk: RiskLevel; }
export interface PlannedStep {
  id: string; agentId: string; objective: string;
  capabilities: string[]; risk: RiskLevel; dependsOn: string[];
}
export interface ExecutionPlan {
  version: 1; taskId: string; steps: PlannedStep[];
  provider: string; model: string; createdAt: string;
}

export type AgentCatalogueSource =
  | AgentCatalogue
  | readonly import("../../contracts/src/index.js").AgentDefinition[]
  | (() => Promise<readonly import("../../contracts/src/index.js").AgentDefinition[]>);

const SYSTEM_PROMPT = [
  "You are Transactra's task planner. Return only one valid JSON object and no markdown.",
  "Create a minimal, verifiable execution plan for the supplied task.",
  "Use only the provided agent catalogue and each agent's declared capabilities.",
  "Every step must request at least one capability from its selected agent; never emit an empty capabilities array.",
  "Never invent capabilities, credentials, repository permissions, or external side effects.",
  "Do not attempt to bypass approval policy; the ToolGateway independently enforces approvals.",
  "Return schema: {version:1,steps:[{id,agentId,objective,capabilities,risk,dependsOn}]}",
  "Use 1 to 12 steps. Use dependency IDs only. Do not include code fences."
].join("\n");

function isRisk(value: unknown): value is RiskLevel {
  return value === "low" || value === "medium" || value === "high" || value === "critical";
}

/** Validate planner output against the current agent catalogue and durable completion evidence. */
export function validatePlan(
  taskId: string,
  value: unknown,
  provider: string,
  model: string,
  minimumRisk: RiskLevel = "low",
  department?: TaskDepartment,
  catalogue: AgentCatalogue = STATIC_AGENT_CATALOGUE,
  completedStepIds: ReadonlySet<string> = new Set<string>(),
  planSource: "fresh" | "persisted" = "fresh"
): ExecutionPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Planner output must be a JSON object");
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > 12) throw new Error("Planner output does not match execution plan schema v1");
  const seen = new Set<string>();
  const steps: PlannedStep[] = raw.steps.map((item): PlannedStep => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Plan step must be an object");
    const step = item as Record<string, unknown>;
    if (typeof step.id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(step.id) || seen.has(step.id)) throw new Error("Plan step IDs must be unique and valid");
    seen.add(step.id);
    if (typeof step.agentId !== "string") throw new Error("Plan step agentId is required");
    const agent = catalogue.get(step.agentId);
    if (!agent) throw new Error("Planner selected an unknown agent: " + step.agentId);
    if (department && agent.department !== department) throw new Error("Planner selected an agent outside the task department");
    if (typeof step.objective !== "string" || !step.objective.trim() || step.objective.length > 4000) throw new Error("Plan step objective is invalid");
    if (!Array.isArray(step.capabilities) || !step.capabilities.every((item) => typeof item === "string")) throw new Error("Plan step capabilities must be a string array");
    const capabilities = step.capabilities as string[];
    if (capabilities.length === 0) {
      if (planSource === "fresh") throw new Error("Every fresh plan step must request at least one granted capability");
      if (!completedStepIds.has(step.id)) {
        throw new Error("Persisted plan step " + step.id + " has no capability grant and is incomplete; automatic re-planning is disabled. An operator must review the original task and create a replacement task with an explicitly granted plan.");
      }
    }
    if (capabilities.some((capability) => !agent.capabilities.includes(capability))) throw new Error("Plan requested a capability outside agent grant: " + agent.id);
    if (!isRisk(step.risk)) throw new Error("Plan step risk classification is invalid");
    const riskRank: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
    if (riskRank[step.risk] < riskRank[minimumRisk]) throw new Error("Plan step risk cannot be lower than the parent task risk");
    if (!Array.isArray(step.dependsOn) || !step.dependsOn.every((item) => typeof item === "string")) throw new Error("Plan step dependencies must be a string array");
    return { id: step.id, agentId: agent.id, objective: step.objective.trim(), capabilities: [...new Set(capabilities)], risk: step.risk, dependsOn: [...new Set(step.dependsOn as string[])] };
  });
  const byId = new Map(steps.map((step) => [step.id, step]));
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (dependency === step.id || !byId.has(dependency)) throw new Error("Plan contains an invalid dependency: " + dependency);
    }
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (id: string): void => {
    if (active.has(id)) throw new Error("Plan dependency cycle detected");
    if (visited.has(id)) return;
    active.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    active.delete(id);
    visited.add(id);
  };
  for (const step of steps) visit(step.id);
  return { version: 1, taskId, steps, provider, model, createdAt: new Date().toISOString() };
}

/** Normalize static and dynamically refreshed agent catalogue inputs. */
function fixedSource(source: AgentCatalogueSource): (() => Promise<readonly import("../../contracts/src/index.js").AgentDefinition[]>) | AgentCatalogue {
  if (typeof source === "function") return source;
  if (Array.isArray(source)) return buildAgentCatalogue(source);
  return source as AgentCatalogue;
}

/** Build and validate bounded task plans using only currently configured agents. */
export class AgentPlanner {
  readonly #providers: ProviderRouter;
  readonly #model: string;
  readonly #source: AgentCatalogue | (() => Promise<readonly import("../../contracts/src/index.js").AgentDefinition[]>);

  constructor(providers: ProviderRouter, model = "provider-default", source: AgentCatalogueSource = STATIC_AGENT_CATALOGUE) {
    this.#providers = providers;
    this.#model = model;
    this.#source = fixedSource(source);
  }

  async #catalogue(): Promise<AgentCatalogue> {
    if (typeof this.#source === "function") return buildAgentCatalogue(await this.#source());
    return this.#source;
  }

  /** Request a plan, retrying validation failures once with bounded corrective context. */
  async plan(task: PlanningTask): Promise<ExecutionPlan> {
    const catalogue = await this.#catalogue();
    const candidates = catalogue.list(task.department).map((agent) => ({
      id: agent.id, name: agent.name, department: agent.department,
      capabilities: agent.capabilities, maxConcurrentTasks: agent.maxConcurrentTasks,
      systemPrompt: agent.systemPrompt
    }));
    if (candidates.length === 0) throw new Error("No real executors are configured for department " + task.department);

    let correction: { previousOutput: string; validationError: string } | undefined;
    let lastValidationError: Error | undefined;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const response = await this.#providers.complete({
        model: this.#model,
        systemPrompt: SYSTEM_PROMPT,
        input: JSON.stringify({ task, availableAgents: candidates, ...(correction ? { correction } : {}) }),
        maxOutputTokens: 3000,
        estimatedCostInr: 0
      });

      let parsed: unknown;
      try {
        parsed = JSON.parse(response.output);
      } catch {
        lastValidationError = new Error("Planner returned invalid JSON");
        correction = { previousOutput: response.output.slice(0, 12_000), validationError: lastValidationError.message };
        continue;
      }

      try {
        return validatePlan(task.id, parsed, response.provider, response.model, task.risk, task.department, catalogue);
      } catch (error) {
        lastValidationError = error instanceof Error ? error : new Error("Planner output failed validation");
        correction = { previousOutput: response.output.slice(0, 12_000), validationError: lastValidationError.message };
      }
    }

    throw new Error("Planner output failed validation after 2 attempts: " + (lastValidationError?.message ?? "unknown validation error"));
  }
}
