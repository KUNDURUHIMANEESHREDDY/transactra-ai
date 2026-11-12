import type { ToolGateway } from "../../security/src/tool-gateway.js";
import type { Action } from "../../policy/src/index.js";
import type { RiskLevel } from "../../contracts/src/index.js";
import type { TavilySearchProvider, SearchRequest } from "./tavily-search.js";
import { scoreOpportunity, type OpportunityCandidate } from "../../intelligence/src/opportunity-scoring.js";
import type { SearchEvidenceRegistry } from "./evidence-registry.js";
import { evaluateProjectQuality, type ProjectSpecification } from "../../innovation/src/quality-gate.js";
import type { OpportunityScore } from "../../intelligence/src/opportunity-scoring.js";

type CandidateInput = Omit<OpportunityCandidate,"evidence"> & { evidenceUrls: string[] };

export interface ResearchToolPersistence {
  recordSearch(input: { ownerId: string; taskId: string; response: import("./tavily-search.js").SearchResponse }): Promise<void>;
  recordEvidence(input: { ownerId: string; taskId: string; items: readonly import("../../intelligence/src/opportunity-scoring.js").EvidenceItem[] }): Promise<void>;
  recordOpportunity(input: { ownerId: string; taskId: string; candidate: OpportunityCandidate; score: OpportunityScore }): Promise<void>;
}

export function registerResearchTools(gateway: ToolGateway, search: TavilySearchProvider, evidence: SearchEvidenceRegistry, persistence?: ResearchToolPersistence): void {
  gateway.register<SearchRequest, unknown>({
    capability: "research.search",
    resource: (input) => "web-search:" + input.query.slice(0,300),
    action: (): Action => ({ kind: "external_search", estimatedCostInr: 0 }),
    risk: (): RiskLevel => "low",
    execute: async (input, context) => {
      const response = await search.search(input,context.signal);
      if (context.taskId) {
        evidence.add(context.taskId,response.results);
        if (persistence) await persistence.recordSearch({ ownerId: context.actor.ownerId, taskId: context.taskId, response });
      }
      return response;
    }
  });
  gateway.register<{ specification: ProjectSpecification; opportunity: OpportunityScore }, unknown>({
    capability: "project.quality.evaluate",
    resource: (input) => "project-quality:" + input.specification.name,
    action: (): Action => ({ kind: "local_computation", estimatedCostInr: 0 }),
    risk: (): RiskLevel => "low",
    execute: async (input) => evaluateProjectQuality(input.specification,input.opportunity)
  });
  gateway.register<{ candidate: CandidateInput; asOf?: string }, unknown>({
    capability: "opportunity.score",
    resource: (input) => "opportunity:" + input.candidate.id,
    action: (): Action => ({ kind: "local_computation", estimatedCostInr: 0 }),
    risk: (): RiskLevel => "low",
    execute: async (input, context) => {
      if (!context.taskId) throw new Error("Opportunity scoring must be scoped to a task");
      const { evidenceUrls, ...candidate } = input.candidate;
      const evidenceItems = evidence.resolve(context.taskId,evidenceUrls);
      const scoredCandidate: OpportunityCandidate = { ...candidate,evidence: evidenceItems };
      const score = scoreOpportunity(scoredCandidate,input.asOf ? new Date(input.asOf) : new Date());
      if (persistence) {
        await persistence.recordEvidence({ ownerId: context.actor.ownerId, taskId: context.taskId, items: evidenceItems });
        await persistence.recordOpportunity({ ownerId: context.actor.ownerId, taskId: context.taskId, candidate: scoredCandidate, score });
      }
      return score;
    }
  });
}
