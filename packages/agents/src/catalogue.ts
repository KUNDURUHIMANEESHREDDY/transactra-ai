import type { AgentDefinition, TaskDepartment } from "../../contracts/src/index.js";
import { AGENT_CATALOGUE } from "./registry.js";

/**
 * A frozen view of the agents that are currently executable. The planner, coordinator and
 * workforce runtime all receive this object so a dynamically created agent needs no restart.
 */
export interface AgentCatalogue {
  readonly size: number;
  get(id: string): AgentDefinition | undefined;
  list(department?: TaskDepartment): readonly AgentDefinition[];
  ids(): readonly string[];
}

export function buildAgentCatalogue(definitions: readonly AgentDefinition[]): AgentCatalogue {
  const byId = new Map<string, AgentDefinition>();
  for (const definition of definitions) {
    if (byId.has(definition.id)) throw new Error("Duplicate agent definition: " + definition.id);
    if (definition.capabilities.length === 0) throw new Error("Agent must declare at least one capability: " + definition.id);
    byId.set(definition.id, definition);
  }
  const ordered = [...byId.values()];
  return Object.freeze({
    size: ordered.length,
    get: (id: string) => byId.get(id),
    list: (department?: TaskDepartment) => department
      ? ordered.filter((definition) => definition.department === department)
      : ordered,
    ids: () => ordered.map((definition) => definition.id)
  });
}

export const STATIC_AGENT_CATALOGUE = buildAgentCatalogue(AGENT_CATALOGUE);

/** Keeps only agents whose full capability grant is currently executable. */
export function filterExecutableCatalogue(
  definitions: readonly AgentDefinition[],
  availableCapabilities: ReadonlySet<string>
): AgentDefinition[] {
  return definitions.filter((definition) =>
    definition.capabilities.length > 0 &&
    definition.capabilities.every((capability) => availableCapabilities.has(capability))
  );
}
