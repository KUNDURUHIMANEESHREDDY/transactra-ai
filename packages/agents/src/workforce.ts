import type { AgentDefinition, TaskDepartment } from "../../contracts/src/index.js";
import type { ProviderRouter } from "../../providers/src/router.js";
import type { ToolGateway } from "../../security/src/tool-gateway.js";
import type { AgentRegistry } from "./dynamic-registry.js";
import { buildAgentCatalogue, filterExecutableCatalogue, type AgentCatalogue } from "./catalogue.js";
import { GenericAgentExecutor } from "./generic-executor.js";
import type { AgentExecutor } from "./coordinator.js";

export interface WorkforceSnapshot {
  readonly catalogue: AgentCatalogue;
  readonly definitions: readonly AgentDefinition[];
  readonly executors: readonly AgentExecutor[];
  readonly refreshedAt: Date;
}

export type ExecutorFactory = (definition: AgentDefinition) => AgentExecutor | undefined;

/**
 * Resolves the executable workforce from the durable agent registry. Specialised executors can be
 * supplied for domains with extra invariants; every other enabled agent uses the generic real
 * LLM/tool-loop executor so newly-created agents become runnable without a restart.
 */
export class WorkforceRuntime {
  readonly #registry: AgentRegistry;
  readonly #providers: ProviderRouter;
  readonly #tools: ToolGateway;
  readonly #availableCapabilities: ReadonlySet<string>;
  readonly #factories: ReadonlyMap<string, ExecutorFactory>;
  readonly #ttlMs: number;
  #snapshot: WorkforceSnapshot | undefined;
  #refreshing: Promise<WorkforceSnapshot> | undefined;

  constructor(input: {
    registry: AgentRegistry;
    providers: ProviderRouter;
    tools: ToolGateway;
    availableCapabilities: readonly string[];
    factories?: ReadonlyMap<string, ExecutorFactory>;
    ttlMs?: number;
  }) {
    this.#registry = input.registry;
    this.#providers = input.providers;
    this.#tools = input.tools;
    this.#availableCapabilities = new Set(input.availableCapabilities);
    this.#factories = input.factories ?? new Map();
    this.#ttlMs = input.ttlMs ?? 15000;
    if (!Number.isInteger(this.#ttlMs) || this.#ttlMs < 1000 || this.#ttlMs > 300000) throw new Error("Workforce refresh TTL must be between 1 and 300 seconds");
  }

  async refresh(force = false): Promise<WorkforceSnapshot> {
    if (!force && this.#snapshot && Date.now() - this.#snapshot.refreshedAt.getTime() < this.#ttlMs) return this.#snapshot;
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = this.#load();
    try { return await this.#refreshing; }
    finally { this.#refreshing = undefined; }
  }

  async #load(): Promise<WorkforceSnapshot> {
    const stored = await this.#registry.definitions();
    const executable = filterExecutableCatalogue(stored, this.#availableCapabilities);
    const definitions = executable.map((definition) => ({ ...definition, capabilities: [...definition.capabilities] }));
    const catalogue = buildAgentCatalogue(definitions);
    const executors: AgentExecutor[] = [];
    for (const definition of definitions) {
      const specialised = this.#factories.get(definition.id)?.(definition);
      executors.push(specialised ?? new GenericAgentExecutor(definition, this.#providers, this.#tools));
    }
    this.#snapshot = Object.freeze({
      catalogue,
      definitions: Object.freeze(definitions),
      executors: Object.freeze(executors),
      refreshedAt: new Date()
    });
    return this.#snapshot;
  }

  supportedDepartments(): readonly TaskDepartment[] {
    if (!this.#snapshot) return [];
    return [...new Set(this.#snapshot.definitions.map((definition) => definition.department))];
  }

  async executor(agentId: string): Promise<AgentExecutor | undefined> {
    const snapshot = await this.refresh();
    return snapshot.executors.find((executor) => executor.agentId === agentId);
  }
}
