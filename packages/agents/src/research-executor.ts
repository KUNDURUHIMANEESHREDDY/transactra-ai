import { randomUUID } from "node:crypto";
import type { AgentExecutionContext, AgentExecutor } from "./coordinator.js";
import type { ProviderRouter } from "../../providers/src/router.js";
import type { ToolGateway } from "../../security/src/tool-gateway.js";
import { registrableDomain } from "../../intelligence/src/opportunity-scoring.js";
import { getAgentDefinition } from "./registry.js";

interface SearchOutput {
  provider: "tavily";
  query: string;
  results: Array<{ title: string; url: string; content: string; score: number; publishedAt?: string }>;
}
interface ToolReply { type: "tool_call" | "final"; capability?: string; input?: Record<string, unknown>; result?: unknown; }
interface Finding { claim: string; impact: string; evidenceUrls: string[]; }
interface Recommendation { idea: string; whyNow: string; priority: "high" | "medium" | "low"; evidenceUrls: string[]; }

/** Durable report sink implemented by IntelligenceStore. */
export interface ResearchReportWriter {
  saveReport(input: {
    ownerId: string; taskId?: string; summary: string;
    findings: unknown; recommendations: unknown;
    sources: readonly string[]; scores: unknown;
  }): Promise<unknown>;
}

export class ResearchAgentExecutor implements AgentExecutor {
  readonly agentId = "product-researcher";
  readonly #providers: ProviderRouter;
  readonly #tools: ToolGateway;
  readonly #reports: ResearchReportWriter | undefined;
  readonly #maxToolCalls: number;

  constructor(providers: ProviderRouter, tools: ToolGateway, reports?: ResearchReportWriter, maxToolCalls = 6) {
    if (!Number.isInteger(maxToolCalls) || maxToolCalls < 1 || maxToolCalls > 8) throw new Error("maxToolCalls must be between 1 and 8");
    this.#providers = providers;
    this.#tools = tools;
    this.#reports = reports;
    this.#maxToolCalls = maxToolCalls;
  }

  async execute(context: AgentExecutionContext): Promise<unknown> {
    if (context.signal.aborted) throw context.signal.reason ?? new Error("Research task cancelled");
    const definition = getAgentDefinition(this.agentId);
    const allowed = definition?.capabilities ?? ["research.search","opportunity.score"];
    if (context.step.capabilities.some((capability) => !allowed.includes(capability)) || !context.step.capabilities.includes("research.search") || !context.step.capabilities.includes("opportunity.score")) throw new Error("Research agent requires both real search and evidence scoring capabilities within its grant");
    const actor = {
      ownerId: context.ownerId,
      actorId: this.agentId,
      agentId: this.agentId,
      capabilities: context.step.capabilities
    };
    const history: Array<{ capability: string; output: unknown }> = (await this.#tools.resumeApproved(actor,context.taskId,context.step.id,context.signal)).map((item) => ({
      capability: "approved-action-resume",
      output: item.output
    }));
    const knownResults = new Map<string,{ title: string; url: string; content: string; score: number; publishedAt?: string }>();
    const opportunityScores: unknown[] = [];
    const systemPrompt = [
      "You are Transactra's evidence-based product intelligence researcher.",
      "Discover recent technology trends, competitor changes, underserved user problems and practical product opportunities.",
      "Use research.search for real web evidence. Do not invent facts, sources, publication dates, competitor capabilities or market statistics.",
      "Use opportunity.score for candidate scoring; do not calculate or alter its score yourself.",
      "Search broadly enough to cover independent publishers. Prefer primary research, official documentation and market data.",
      "Return only JSON tool calls or a final report.",
      "Tool call schema: {\"type\":\"tool_call\",\"capability\":\"research.search|opportunity.score\",\"input\":{...}}.",
      "Final schema: {\"type\":\"final\",\"result\":{\"summary\":\"...\",\"findings\":[{\"claim\":\"...\",\"impact\":\"...\",\"evidenceUrls\":[\"https://...\"]}],\"recommendations\":[{\"idea\":\"...\",\"whyNow\":\"...\",\"priority\":\"high|medium|low\",\"evidenceUrls\":[\"https://...\"]}]}}.",
      "Every finding and recommendation must cite one or more exact URLs returned by your own research.search calls.",
      "For opportunity.score provide evidenceUrls from your search results; the tool independently resolves their metadata and dates.",
      "Do not claim an opportunity passed the 90/100 gate unless the scoring tool returned eligible=true."
    ].join("\n");

    for (let turn = 0; turn < this.#maxToolCalls; turn += 1) {
      if (context.signal.aborted) throw context.signal.reason ?? new Error("Research task cancelled");
      const response = await this.#providers.complete({
        systemPrompt,
        input: JSON.stringify({
          taskId: context.taskId,
          objective: context.step.objective,
          allowedCapabilities: context.step.capabilities,
          dependencyResults: context.dependencyResults,
          previousToolResults: history
        }),
        maxOutputTokens: 5000,
        estimatedCostInr: 0
      });
      let decoded: unknown;
      try { decoded = JSON.parse(response.output); }
      catch { throw new Error("Research agent returned invalid JSON"); }
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Research agent response must be a JSON object");
      const reply = decoded as ToolReply;
      if (reply.type === "final") {
        const result = reply.result as Record<string, unknown> | null;
        if (!result || typeof result !== "object" || typeof result.summary !== "string" || !Array.isArray(result.findings) || !Array.isArray(result.recommendations)) {
          throw new Error("Research final report does not match the required schema");
        }
        const findings = result.findings as Finding[];
        const recommendations = result.recommendations as Recommendation[];
        if (findings.length < 1 || recommendations.length < 1) throw new Error("Research report requires at least one finding and one recommendation");
        const cited = new Set<string>();
        for (const finding of findings) {
          if (typeof finding.claim !== "string" || typeof finding.impact !== "string" || !Array.isArray(finding.evidenceUrls) || finding.evidenceUrls.length === 0) throw new Error("Every finding must contain claim, impact and evidence URLs");
          for (const url of finding.evidenceUrls) {
            if (!knownResults.has(url)) throw new Error("Research finding cited a URL not returned by the search provider");
            cited.add(url);
          }
        }
        for (const recommendation of recommendations) {
          if (typeof recommendation.idea !== "string" || typeof recommendation.whyNow !== "string" || !["high","medium","low"].includes(recommendation.priority) || !Array.isArray(recommendation.evidenceUrls) || recommendation.evidenceUrls.length === 0) throw new Error("Every recommendation must contain a rationale, priority and evidence URLs");
          for (const url of recommendation.evidenceUrls) {
            if (!knownResults.has(url)) throw new Error("Recommendation cited a URL not returned by the search provider");
            cited.add(url);
          }
        }
        const domains = new Set([...cited].map((url) => registrableDomain(new URL(url).hostname)));
        if (cited.size < 3 || domains.size < 2) throw new Error("Research report requires at least three cited sources across two independent domains");
        if (opportunityScores.length === 0) throw new Error("Daily intelligence report must include at least one tool-generated opportunity score");
        const sources = [...cited].map((url) => knownResults.get(url)!);
        const report = this.#reports
          ? await this.#reports.saveReport({
              ownerId: context.ownerId,
              taskId: context.taskId,
              summary: result.summary.slice(0,5000),
              findings,
              recommendations,
              sources: [...cited],
              scores: opportunityScores
            })
          : null;
        return {
          agentId: this.agentId, provider: response.provider, model: response.model,
          summary: result.summary.slice(0,5000), findings, recommendations,
          sources, opportunityScores,
          reportId: report && typeof report === "object" && "id" in report ? (report as { id: string }).id : null
        };
      }
      if (reply.type !== "tool_call" || typeof reply.capability !== "string" || !reply.input || typeof reply.input !== "object" || Array.isArray(reply.input)) {
        throw new Error("Research agent response does not match the tool-call schema");
      }
      if (!context.step.capabilities.includes(reply.capability)) throw new Error("Research agent attempted an ungranted tool capability");
      const output = await this.#tools.invoke({
        actor, capability: reply.capability, input: reply.input,
        correlationId: randomUUID(), taskId: context.taskId, stepId: context.step.id, signal: context.signal
      });
      if (reply.capability === "research.search") {
        const search = output as SearchOutput;
        for (const item of search.results ?? []) knownResults.set(item.url,item);
        const compressed = {
          provider: search.provider, query: search.query,
          results: (search.results ?? []).map((item) => ({
            title: item.title, url: item.url, content: item.content.slice(0,1000),
            score: item.score, ...(item.publishedAt ? { publishedAt: item.publishedAt } : {})
          }))
        };
        history.push({ capability: reply.capability, output: compressed });
      } else {
        opportunityScores.push(output);
        history.push({ capability: reply.capability, output });
      }
      if (history.length > 8) history.shift();
    }
    throw new Error("Research agent reached its search/tool budget without completing a cited report");
  }
}
