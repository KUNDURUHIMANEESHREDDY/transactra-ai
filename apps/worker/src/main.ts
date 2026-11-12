import { ApprovalStore } from "../../../packages/storage/src/approvals.js";
import { PostgresTaskStore } from "../../../packages/storage/src/postgres.js";
import { MemoryStore } from "../../../packages/storage/src/memory.js";
import { IntelligenceStore } from "../../../packages/storage/src/intelligence.js";
import { OrganizationStore } from "../../../packages/storage/src/organization.js";
import { AgentRegistry } from "../../../packages/agents/src/dynamic-registry.js";
import { WorkforceRuntime, type ExecutorFactory } from "../../../packages/agents/src/workforce.js";
import { PlannedTaskExecutor } from "../../../packages/agents/src/task-executor.js";
import { OperationsAgentExecutor } from "../../../packages/agents/src/operations-executor.js";
import { GitHubEngineeringAgentExecutor } from "../../../packages/agents/src/github-engineering-executor.js";
import { ResearchAgentExecutor } from "../../../packages/agents/src/research-executor.js";
import { InnovationAgentExecutor } from "../../../packages/agents/src/innovation-executor.js";
import { TaskWorker } from "../../../packages/orchestrator/src/worker.js";
import { ToolGateway } from "../../../packages/security/src/tool-gateway.js";
import { registerGitHubTools } from "../../../packages/github/src/tools.js";
import { registerResearchTools } from "../../../packages/research/src/tools.js";
import { registerSandboxTools } from "../../../packages/sandbox/src/tools.js";
import { DockerSandboxRunner } from "../../../packages/sandbox/src/docker-runner.js";
import { OperationsMonitor } from "../../../packages/organization/src/operations.js";
import { SecurityAuditor } from "../../../packages/organization/src/security.js";
import { DeploymentEngine } from "../../../packages/organization/src/deployments.js";
import { EvolutionEngine } from "../../../packages/organization/src/evolution.js";
import { registerOrganizationTools } from "../../../packages/organization/src/tools.js";
import { ProviderRouter } from "../../../packages/providers/src/router.js";
import { createProviderRuntime } from "./provider-runtime.js";
import { createGitHubRuntime } from "./github-runtime.js";
import { createResearchRuntime } from "./research-runtime.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

// An inference provider is optional: a control-plane-only or Telegram-only deployment starts
// with an empty router, and any inference request then fails closed at the router boundary.
const providerRuntime = createProviderRuntime();
const providers: ProviderRouter = providerRuntime
  ? providerRuntime.router
  : new ProviderRouter([],{ onHealth: async () => undefined });
const approvals = new ApprovalStore(databaseUrl);
const gateway = new ToolGateway(databaseUrl, approvals);
const store = new PostgresTaskStore(databaseUrl);
const organizationStore = new OrganizationStore(databaseUrl);
const intelligenceStore = new IntelligenceStore(databaseUrl);
const memoryStore = new MemoryStore(databaseUrl);
const operations = new OperationsMonitor(databaseUrl);
const securityAuditor = new SecurityAuditor(databaseUrl);
const registry = new AgentRegistry(databaseUrl);

let githubRuntime: ReturnType<typeof createGitHubRuntime> | undefined;
let researchRuntime: ReturnType<typeof createResearchRuntime> | undefined;
let sandboxRunner: DockerSandboxRunner | undefined;
let operationsExecutor: OperationsAgentExecutor | undefined;

function hasAnyGitHubConfig(): boolean {
  return ["GITHUB_APP_ID","GITHUB_APP_INSTALLATION_ID","GITHUB_APP_PRIVATE_KEY","GITHUB_REPOSITORY_ALLOWLIST"]
    .some((key) => Boolean(process.env[key]?.trim()));
}
function hasCompleteGitHubConfig(): boolean {
  return ["GITHUB_APP_ID","GITHUB_APP_INSTALLATION_ID","GITHUB_APP_PRIVATE_KEY","GITHUB_REPOSITORY_ALLOWLIST"]
    .every((key) => Boolean(process.env[key]?.trim()));
}
function hasAnyResearchConfig(): boolean {
  return ["TAVILY_API_KEY"].some((key) => Boolean(process.env[key]?.trim()));
}

const controller = new AbortController();
process.on("SIGINT", () => controller.abort(new Error("SIGINT")));
process.on("SIGTERM", () => controller.abort(new Error("SIGTERM")));

try {
  await registry.ensureStaticAgents();

  if (hasAnyGitHubConfig()) {
    if (!hasCompleteGitHubConfig()) throw new Error("GitHub App configuration is partial; provide all required values or leave all unset");
    githubRuntime = createGitHubRuntime();
    registerGitHubTools(gateway, githubRuntime.client);
  }
  if (hasAnyResearchConfig()) {
    researchRuntime = createResearchRuntime();
    registerResearchTools(gateway,researchRuntime.provider,researchRuntime.evidence,intelligenceStore);
  }
  if (process.env.TRANSACTRA_SANDBOX_IMAGE?.trim()) {
    sandboxRunner = new DockerSandboxRunner({
      imageDigest: process.env.TRANSACTRA_SANDBOX_IMAGE.trim(),
      ...(process.env.TRANSACTRA_DOCKER_BINARY?.trim() ? { dockerBinary: process.env.TRANSACTRA_DOCKER_BINARY.trim() } : {})
    });
    registerSandboxTools(gateway,sandboxRunner);
  }

  const deployments = githubRuntime
    ? new DeploymentEngine({ store: organizationStore, repository: githubRuntime.client })
    : undefined;
  const evolution = githubRuntime && sandboxRunner
    ? new EvolutionEngine({
        store: organizationStore,
        repository: githubRuntime.client,
        sandbox: sandboxRunner,
        repositoryName: process.env.TRANSACTRA_EVOLUTION_REPOSITORY?.trim() || "KUNDURUHIMANEESHREDDY/transactra"
      })
    : undefined;

  registerOrganizationTools(gateway, {
    store: organizationStore,
    memory: memoryStore,
    intelligence: intelligenceStore,
    operations,
    registry,
    taskStore: store,
    approvals,
    security: securityAuditor,
    ...(deployments ? { deployments } : {}),
    ...(evolution ? { evolution } : {})
  });

  operationsExecutor = new OperationsAgentExecutor(databaseUrl,providers);
  const factories = new Map<string, ExecutorFactory>();
  factories.set("site-reliability-engineer", () => operationsExecutor);
  if (githubRuntime) {
    factories.set("engineering-lead", () => new GitHubEngineeringAgentExecutor("engineering-lead",providers,gateway));
    factories.set("software-engineer", () => new GitHubEngineeringAgentExecutor("software-engineer",providers,gateway));
    factories.set("quality-engineer", () => new GitHubEngineeringAgentExecutor("quality-engineer",providers,gateway));
  }
  if (researchRuntime) {
    factories.set("product-researcher", () => new ResearchAgentExecutor(providers,gateway,intelligenceStore));
  }
  if (researchRuntime && githubRuntime) {
    factories.set("innovation-architect", () => new InnovationAgentExecutor(providers,gateway,gateway));
  }

  const workforce = new WorkforceRuntime({
    registry,
    providers,
    tools: gateway,
    availableCapabilities: gateway.capabilities(),
    factories
  });
  const snapshot = await workforce.refresh(true);
  const executor = new PlannedTaskExecutor({ store, providers, workforce, globalConcurrency: 6 });
  const worker = new TaskWorker(store, executor, {
    workerId: process.env.TRANSACTRA_WORKER_ID?.trim() || "transactra-worker-" + process.pid,
    leaseSeconds: 90,
    idlePollMs: 1500,
    retryDelaySeconds: 45
  });
  process.stdout.write(JSON.stringify({
    event: "worker_started",
    departments: executor.supportedDepartments,
    agents: snapshot.definitions.map((definition) => definition.id),
    registeredCapabilities: gateway.capabilities().length,
    githubEnabled: Boolean(githubRuntime),
    researchEnabled: Boolean(researchRuntime),
    sandboxEnabled: Boolean(sandboxRunner),
    deploymentEnabled: Boolean(deployments),
    evolutionEnabled: Boolean(evolution)
  }) + "\n");
  await worker.run(controller.signal);
} catch (error) {
  process.stderr.write(JSON.stringify({ event: "worker_stopped_with_error", message: error instanceof Error ? error.message : "unknown" }) + "\n");
  process.exitCode = 1;
} finally {
  await Promise.allSettled([
    store.close(),
    organizationStore.close(),
    intelligenceStore.close(),
    memoryStore.close(),
    operations.close(),
    securityAuditor.close(),
    registry.close(),
    gateway.close(),
    approvals.close(),
    (providerRuntime ? providerRuntime.close() : Promise.resolve()),
    ...(operationsExecutor ? [operationsExecutor.close()] : []),
    ...(researchRuntime ? [researchRuntime.close()] : []),
    ...(githubRuntime ? [githubRuntime.close()] : [])
  ]);
}
