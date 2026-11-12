import { randomUUID } from "node:crypto";
import type { AgentExecutionContext, AgentExecutor } from "./coordinator.js";
import { getAgentDefinition } from "./registry.js";
import type { ProviderRouter } from "../../providers/src/router.js";
import type { ToolGateway } from "../../security/src/tool-gateway.js";

interface AgentReply {
  type: "tool_call" | "final";
  capability?: string;
  input?: Record<string, unknown>;
  result?: unknown;
}

export class GitHubEngineeringAgentExecutor implements AgentExecutor {
  readonly agentId: string;
  readonly #providers: ProviderRouter;
  readonly #tools: ToolGateway;
  readonly #maxToolCalls: number;

  constructor(agentId: "engineering-lead" | "software-engineer" | "quality-engineer", providers: ProviderRouter, tools: ToolGateway, maxToolCalls = 8) {
    if (!getAgentDefinition(agentId)) throw new Error("Unknown engineering agent");
    if (!Number.isInteger(maxToolCalls) || maxToolCalls < 1 || maxToolCalls > 12) throw new Error("maxToolCalls must be between 1 and 12");
    this.agentId = agentId;
    this.#providers = providers;
    this.#tools = tools;
    this.#maxToolCalls = maxToolCalls;
  }

  async execute(context: AgentExecutionContext): Promise<unknown> {
    if (context.signal.aborted) throw context.signal.reason ?? new Error("Agent execution cancelled");
    const definition = getAgentDefinition(this.agentId);
    if (!definition) throw new Error("Agent definition was retired");
    if (context.step.capabilities.some((capability) => !definition.capabilities.includes(capability))) {
      throw new Error("Execution step exceeds this agent's declared capability grants");
    }
    const actor = {
      ownerId: context.ownerId,
      actorId: this.agentId,
      agentId: this.agentId,
      capabilities: context.step.capabilities
    };
    const resumed = await this.#tools.resumeApproved(actor, context.taskId, context.step.id, context.signal);
    const history: Array<{ capability: string; output: unknown }> = resumed.map((item) => ({
      capability: "approved-action-resume",
      output: item.output
    }));
    const systemPrompt = [
      "You are the " + definition.name + " in Transactra's engineering department.",
      "Complete the assigned objective using only the exact capabilities listed in the task step.",
      "Never invent repository contents, tool results, test results, or approvals.",
      "All GitHub operations must be performed through tool calls. Do not claim an operation succeeded without its returned result.",
      "The tool gateway independently enforces repository allowlists, private repository policy, zero-spend policy and human approvals.",
      "Return only JSON with double-quoted keys: {\"type\":\"tool_call\",\"capability\":\"exact.capability\",\"input\":{...}} or {\"type\":\"final\",\"result\":{...}}.",
      "If blocked by missing access, missing evidence, approval, or tests, report that explicitly in the final result.",
      "Do not include credentials, tokens, private keys, or other secrets in tool inputs or final output."
    ].join("\n");
    for (let turn = 0; turn < this.#maxToolCalls; turn += 1) {
      if (context.signal.aborted) throw context.signal.reason ?? new Error("Agent execution cancelled");
      const response = await this.#providers.complete({
        systemPrompt,
        input: JSON.stringify({
          taskId: context.taskId,
          objective: context.step.objective,
          risk: context.step.risk,
          allowedCapabilities: context.step.capabilities,
          dependencyResults: context.dependencyResults,
          previousToolResults: history
        }),
        maxOutputTokens: 5000,
        estimatedCostInr: 0
      });
      let reply: unknown;
      try { reply = JSON.parse(response.output); }
      catch { throw new Error("Engineering agent returned invalid JSON; no tool action was executed"); }
      if (!reply || typeof reply !== "object" || Array.isArray(reply)) throw new Error("Engineering agent response must be a JSON object");
      const parsed = reply as AgentReply;
      if (parsed.type === "final") {
        return { agentId: this.agentId, provider: response.provider, model: response.model, toolCalls: history.length, result: parsed.result ?? null };
      }
      if (parsed.type !== "tool_call" || typeof parsed.capability !== "string" || !parsed.input || typeof parsed.input !== "object" || Array.isArray(parsed.input)) {
        throw new Error("Engineering agent response does not match the tool-call schema");
      }
      if (!context.step.capabilities.includes(parsed.capability)) throw new Error("Agent attempted a tool outside its step capability grant");
      const output = await this.#tools.invoke({
        actor,
        capability: parsed.capability,
        input: parsed.input,
        correlationId: randomUUID(),
        taskId: context.taskId,
        stepId: context.step.id,
        signal: context.signal
      });
      const serialized = JSON.stringify(output) ?? "null";
      if (serialized.length > 100000) throw new Error("Tool output exceeds the agent context limit");
      history.push({ capability: parsed.capability, output });
    }
    throw new Error("Engineering agent reached its tool-call limit without completing the objective");
  }
}
