import { randomUUID } from "node:crypto";
import type { AgentExecutionContext, AgentExecutor } from "./coordinator.js";
import type { ProviderRouter } from "../../providers/src/router.js";
import type { ToolGateway } from "../../security/src/tool-gateway.js";
import type { OpportunityScore } from "../../intelligence/src/opportunity-scoring.js";
import type { ProjectQualityResult, ProjectSpecification } from "../../innovation/src/quality-gate.js";
import { getAgentDefinition } from "./registry.js";

interface ToolReply { type: "tool_call" | "final"; capability?: string; input?: Record<string, unknown>; result?: unknown; }
interface RepoResult { fullName: string; htmlUrl: string; defaultBranch: string; private: true; installationAccess: "ready" | "not_installed"; }
interface SandboxVerificationResult { passed: boolean; exitCode: number | null; timedOut: boolean; stdout: string; stderr: string; }
interface PersistedProject { id: string; status: string; repository_full_name: string; }
const REQUIRED_FILES = ["README.md","package.json","tsconfig.json","docs/ARCHITECTURE.md","docs/SECURITY.md","docs/PROJECT_SPEC.md","docs/RESEARCH.md","src/index.ts","tests/smoke.test.ts",".gitignore",".github/workflows/ci.yml"];

export class InnovationAgentExecutor implements AgentExecutor {
  readonly agentId = "innovation-architect";
  readonly #providers: ProviderRouter;
  readonly #researchTools: ToolGateway;
  readonly #githubTools: ToolGateway;
  readonly #maxToolCalls: number;

  constructor(providers: ProviderRouter, researchTools: ToolGateway, githubTools: ToolGateway, maxToolCalls = 16) {
    if (!Number.isInteger(maxToolCalls) || maxToolCalls < 6 || maxToolCalls > 16) throw new Error("maxToolCalls must be between 6 and 16");
    this.#providers = providers;
    this.#researchTools = researchTools;
    this.#githubTools = githubTools;
    this.#maxToolCalls = maxToolCalls;
  }

  async execute(context: AgentExecutionContext): Promise<unknown> {
    if (context.signal.aborted) throw context.signal.reason ?? new Error("Innovation task cancelled");
    const definition = getAgentDefinition(this.agentId);
    const gateCapabilities = ["research.search","opportunity.score","project.quality.evaluate","github.repo.create","github.file.write","sandbox.verify","innovation.persist"];
    const allowed = definition?.capabilities ?? gateCapabilities;
    if (context.step.capabilities.some((capability) => !allowed.includes(capability)) || gateCapabilities.some((capability) => !context.step.capabilities.includes(capability))) throw new Error("Innovation agent requires the gated research, quality, repository, sandbox and persistence capabilities");
    const actor = { ownerId: context.ownerId, actorId: this.agentId, agentId: this.agentId, capabilities: context.step.capabilities };
    const history: Array<{ capability: string; output: unknown }> = [];
    let opportunityScore: OpportunityScore | undefined;
    let qualityResult: ProjectQualityResult | undefined;
    let specification: ProjectSpecification | undefined;
    let createdRepo: RepoResult | undefined;
    const filesWritten = new Set<string>();
    const fileContents = new Map<string,string>();
    const systemPrompt = [
      "You are Transactra's innovation architect. Your objective is to produce a genuinely useful, evidence-backed private software project.",
      "First discover a real problem and recent market evidence using research.search. Use at least three independent source URLs across at least two domains.",
      "Then call opportunity.score with candidate dimensions and evidenceUrls. The tool independently resolves evidence metadata; never invent publication dates or source quality.",
      "Proceed only when the returned score is eligible=true and at least 90/100.",
      "Create a complete ProjectSpecification and call project.quality.evaluate. It must include architecture, acceptance criteria, test strategy, security, data handling, deployment, monitoring, rollback, maintenance and success metrics. Monthly cost must be exactly INR 0 and visibility private.",
      "Create a repository only after the score and quality gate both approve. The repository tool creates a private repository under the configured owner.",
      "After repository creation, write these files on its default branch: README.md, package.json, tsconfig.json, docs/ARCHITECTURE.md, docs/SECURITY.md, docs/PROJECT_SPEC.md, docs/RESEARCH.md, src/index.ts, tests/smoke.test.ts, .gitignore, .github/workflows/ci.yml. The CI workflow must be manual workflow_dispatch only, read-only permissions, and contain no secrets references or automatic triggers.",
      "Do not create a public repository, spend money, or write to any repository other than the new repository returned by github.repo.create.",
      "After the required files exist, the executor validates the generated workspace in the isolated sandbox and persists the project record. Never claim tests passed yourself; report only the real verification returned.",
      "Return only JSON tool calls or a final JSON result.",
      "Tool call: {\"type\":\"tool_call\",\"capability\":\"research.search|opportunity.score|project.quality.evaluate|github.repo.create|github.file.write|sandbox.verify|innovation.persist\",\"input\":{...}}.",
      "Final: {\"type\":\"final\",\"result\":{\"status\":\"no_candidate_passed_90|quality_gate_rejected|scaffolded\",\"summary\":\"...\",\"projectName\":\"...\",\"files\":[...]}}."
    ].join("\n");

    await this.#githubTools.resumeApproved(actor,context.taskId,context.step.id,context.signal);
    for (let turn = 0; turn < this.#maxToolCalls; turn += 1) {
      if (context.signal.aborted) throw context.signal.reason ?? new Error("Innovation task cancelled");
      const response = await this.#providers.complete({
        systemPrompt,
        input: JSON.stringify({
          taskId: context.taskId,
          objective: context.step.objective,
          allowedCapabilities: context.step.capabilities,
          dependencyResults: context.dependencyResults,
          previousToolResults: history,
          opportunityScore: opportunityScore ?? null,
          qualityResult: qualityResult ?? null,
          createdRepository: createdRepo ?? null,
          filesWritten: [...filesWritten]
        }),
        maxOutputTokens: 6000,
        estimatedCostInr: 0
      });
      let decoded: unknown;
      try { decoded = JSON.parse(response.output); }
      catch { throw new Error("Innovation agent returned invalid JSON"); }
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Innovation response must be a JSON object");
      const reply = decoded as ToolReply;
      if (reply.type === "final") {
        const result = reply.result as Record<string, unknown> | null;
        if (!result || typeof result !== "object" || typeof result.status !== "string" || typeof result.summary !== "string") throw new Error("Innovation final result is invalid");
        if (result.status === "scaffolded") {
          if (!opportunityScore?.eligible || !qualityResult?.approved || !createdRepo || createdRepo.installationAccess !== "ready") throw new Error("Innovation agent claimed completion without passing all gates");
          for (const path of REQUIRED_FILES) if (!filesWritten.has(path)) throw new Error("Required project scaffold file is missing: " + path);
          if (!specification) throw new Error("Project specification is missing from the quality gate call");
          if (fileContents.size !== filesWritten.size) throw new Error("Not every written project file has captured content for sandbox verification");
          const verification = await this.#githubTools.invoke<{ files: Record<string,string>; preset: string }, SandboxVerificationResult>({
            actor, capability: "sandbox.verify",
            input: { files: Object.fromEntries(fileContents), preset: "transactra-verify" },
            correlationId: randomUUID(), taskId: context.taskId, stepId: context.step.id, signal: context.signal
          });
          const status = verification.passed ? "verified" : "validation_failed";
          const project = await this.#githubTools.invoke<Record<string, unknown>, PersistedProject>({
            actor, capability: "innovation.persist",
            input: {
              name: specification.name, repositoryFullName: createdRepo.fullName,
              repositoryUrl: createdRepo.htmlUrl, specification,
              opportunityScore, verification, status
            },
            correlationId: randomUUID(), taskId: context.taskId, stepId: context.step.id, signal: context.signal
          });
          return {
            agentId: this.agentId, provider: response.provider, model: response.model,
            status, summary: result.summary,
            opportunityScore, qualityResult, repository: createdRepo,
            files: [...filesWritten], testsExecuted: true,
            verification, projectId: project.id, projectStatus: project.status
          };
        }
        if (createdRepo) throw new Error("Innovation agent cannot report a rejected candidate after creating a repository");
        if (result.status === "no_candidate_passed_90" && (!opportunityScore || opportunityScore.eligible)) throw new Error("A no-candidate result requires an actual ineligible opportunity score");
        if (result.status === "quality_gate_rejected" && (!opportunityScore?.eligible || !qualityResult || qualityResult.approved)) throw new Error("A quality-rejected result requires a passing opportunity score and a rejected project quality result");
        if (!["no_candidate_passed_90","quality_gate_rejected"].includes(result.status)) throw new Error("Unknown innovation completion status");
        return { agentId: this.agentId, provider: response.provider, model: response.model, status: result.status, summary: result.summary, opportunityScore: opportunityScore ?? null, qualityResult: qualityResult ?? null };
      }
      if (reply.type !== "tool_call" || typeof reply.capability !== "string" || !reply.input || typeof reply.input !== "object" || Array.isArray(reply.input)) throw new Error("Innovation tool call schema is invalid");
      if (!context.step.capabilities.includes(reply.capability)) throw new Error("Innovation agent attempted an ungranted capability");
      let output: unknown;
      if (reply.capability.startsWith("github.")) {
        if (reply.capability === "github.repo.create" && (!opportunityScore?.eligible || !qualityResult?.approved)) throw new Error("Private repository creation is blocked until both quality gates pass");
        if (reply.capability === "github.file.write") {
          if (!createdRepo || createdRepo.installationAccess !== "ready") throw new Error("Project files cannot be written before a private repository is ready");
          if (reply.input.repository !== createdRepo.fullName) throw new Error("Innovation agent attempted to write outside the repository created for this task");
          reply.input.branch = createdRepo.defaultBranch;
          if (reply.input.path === ".github/workflows/ci.yml") {
            const workflow = String(reply.input.content ?? "");
            const hasManualTrigger = /workflow_dispatch\s*:/m.test(workflow);
            const hasAutomaticTrigger = /^\s*(push|pull_request|pull_request_target|schedule|workflow_run|repository_dispatch|issues|issue_comment|release|create|delete|deployment|deployment_status|check_run|check_suite|watch|fork|public|discussion|merge_group|workflow_call):/m.test(workflow);
            const hasReadOnlyPermissions = /permissions:\s*\n\s+contents:\s*read/m.test(workflow);
            if (!hasManualTrigger || hasAutomaticTrigger || !hasReadOnlyPermissions || /secrets\./i.test(workflow) || /write-all|permissions:\s*write/i.test(workflow)) {
              throw new Error("Generated CI must be workflow_dispatch-only, contents-read-only and contain no secrets or automatic triggers");
            }
          }
        }
        output = await this.#githubTools.invoke({
          actor, capability: reply.capability, input: reply.input,
          correlationId: randomUUID(), taskId: context.taskId, stepId: context.step.id, signal: context.signal
        });
      } else {
        if (reply.capability === "project.quality.evaluate") {
          if (!opportunityScore?.eligible) throw new Error("Project quality evaluation requires a passing opportunity score");
          reply.input.opportunity = opportunityScore;
        }
        output = await this.#researchTools.invoke({
          actor, capability: reply.capability, input: reply.input,
          correlationId: randomUUID(), taskId: context.taskId, stepId: context.step.id, signal: context.signal
        });
      }
      if (reply.capability === "opportunity.score") opportunityScore = output as OpportunityScore;
      if (reply.capability === "project.quality.evaluate") {
        qualityResult = output as ProjectQualityResult;
        specification = reply.input.specification as ProjectSpecification;
      }
      if (reply.capability === "github.repo.create") {
        createdRepo = output as RepoResult;
        if (createdRepo.private !== true || createdRepo.installationAccess !== "ready") throw new Error("Private repository exists but the GitHub App installation cannot access it");
      }
      if (reply.capability === "github.file.write") {
        const path = reply.input.path;
        if (typeof path !== "string") throw new Error("Project file write is missing a path");
        filesWritten.add(path);
        fileContents.set(path,String(reply.input.content ?? ""));
      }
      const serialized = JSON.stringify(output) ?? "null";
      if (serialized.length > 100000) throw new Error("Innovation tool output exceeds the context limit");
      history.push({ capability: reply.capability, output });
      if (history.length > 10) history.shift();
    }
    throw new Error("Innovation agent reached its execution budget before completing the project scaffold");
  }
}
