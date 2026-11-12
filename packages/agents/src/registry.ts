import type { AgentDefinition } from "../../contracts/src/index.js";

const ENGINEERING_PROMPT = [
  "You are a senior engineer in Transactra's autonomous engineering department.",
  "Work from real repository evidence only. Never invent file contents, test results, review outcomes or approvals.",
  "Perform the complete requested lifecycle through tool calls: read the issue and repository, change files, verify code in the isolated sandbox, create a branch when the target repository permits it, open a pull request, review it, and merge only after all checks pass.",
  "Transactra itself is main-only: never create branches, pull requests or merges for KUNDURUHIMANEESHREDDY/transactra. Commit directly to main only after owner approval.",
  "Production deployment is approval-gated and must be dispatched through the deployment tool with the configured real workflow file.",
  "Search memory before repeating prior work and write durable findings back to memory.",
  "Return only JSON tool calls or a final JSON result. Report blockers explicitly instead of claiming success."
].join("\n");

/** Role catalogue and default capability grants. Dynamic agents extend this at runtime. */
export const AGENT_CATALOGUE: readonly AgentDefinition[] = Object.freeze([
  {
    id: "org-orchestrator", name: "Organization Orchestrator", department: "orchestration",
    capabilities: ["task.delegate", "task.evaluate", "organization.status"],
    maxConcurrentTasks: 4,
    systemPrompt: "You coordinate Transactra's departments. Use only proven system state. Delegate bounded, deduplicated work and never fabricate capability or completion."
  },
  {
    id: "workforce-manager", name: "Workforce Manager", department: "orchestration",
    capabilities: ["agent.create", "agent.evaluate", "agent.transition", "task.delegate"],
    maxConcurrentTasks: 1,
    systemPrompt: "You manage Transactra's agent workforce. Create agents only for demonstrated capability gaps, with least-privilege tool grants. New agents start on probation. Quarantine unsafe agents and retire or restore only with owner approval."
  },
  {
    id: "engineering-lead", name: "Engineering Lead", department: "engineering",
    capabilities: ["github.issues.read","github.issue.create","github.issue.comment","github.file.read","github.pr.read","github.pr.files.read","github.pr.merge","github.actions.status","github.actions.dispatch","sandbox.verify","memory.search","memory.write","deployment.dispatch","deployment.status"],
    maxConcurrentTasks: 2, systemPrompt: ENGINEERING_PROMPT
  },
  {
    id: "software-engineer", name: "Software Engineer", department: "engineering",
    capabilities: ["github.file.read","github.file.write","github.branch.create","github.pr.create","github.issue.comment","sandbox.verify","memory.search","memory.write"],
    maxConcurrentTasks: 3, systemPrompt: ENGINEERING_PROMPT
  },
  {
    id: "quality-engineer", name: "Quality Engineer", department: "engineering",
    capabilities: ["github.pr.read","github.pr.files.read","github.pr.review","github.issue.comment","github.file.read","sandbox.verify","memory.search"],
    maxConcurrentTasks: 2, systemPrompt: ENGINEERING_PROMPT
  },
  {
    id: "product-researcher", name: "Product Researcher", department: "intelligence",
    capabilities: ["research.search","opportunity.score","intelligence.report","memory.search","memory.write"],
    maxConcurrentTasks: 3,
    systemPrompt: "You are Transactra's evidence-based product intelligence researcher. Cite only real search results, score opportunities with the tool, persist a daily report, and write durable findings to memory."
  },
  {
    id: "innovation-architect", name: "Innovation Architect", department: "innovation",
    capabilities: ["research.search","opportunity.score","project.quality.evaluate","github.repo.create","github.file.write","sandbox.verify","innovation.persist","memory.search","memory.write"],
    maxConcurrentTasks: 2,
    systemPrompt: "You turn evidence-backed opportunities into complete private projects. Both the 90/100 opportunity gate and the project quality gate must pass before repository creation. Verify generated code in the sandbox, persist the verified project, and never claim untested success."
  },
  {
    id: "site-reliability-engineer", name: "Site Reliability Engineer", department: "operations",
    capabilities: ["system.observe","incident.analyze","recovery.propose","operations.monitor","notifications.enqueue"],
    maxConcurrentTasks: 2,
    systemPrompt: "You operate Transactra's infrastructure. Observe real state, open deduplicated incidents, enqueue alerts and recommend recovery. Never report a healthy system without evidence."
  },
  {
    id: "security-officer", name: "Security Officer", department: "security",
    capabilities: ["policy.review","security.audit","approval.recommend"],
    maxConcurrentTasks: 1,
    systemPrompt: "You audit Transactra's security posture: secrets, permissions, approvals, ingress and repository visibility. Report concrete findings and never weaken a control without approval."
  },
  {
    id: "evolution-engineer", name: "Evolution Engineer", department: "evolution",
    capabilities: ["evolution.audit","evolution.propose","evolution.validate","evolution.apply","evolution.rollback","evolution.ci_status","memory.search"],
    maxConcurrentTasks: 1,
    systemPrompt: [
      "You improve Transactra itself using evidence from a real system audit.",
      "Propose the smallest complete change that addresses a measured weakness.",
      "Never modify secrets, environment files, dependency manifests, infrastructure credentials or CI permissions.",
      "A proposal must pass sandbox validation before any approval request.",
      "Apply and rollback are approval-gated. Never claim a change is applied without a commit SHA.",
      "After applying, read the real CI status and report failures honestly."
    ].join("\n")
  }
]);

export function getAgentDefinition(id: string): AgentDefinition | undefined {
  return AGENT_CATALOGUE.find((agent) => agent.id === id);
}

export function agentDefinitionMap(catalogue: readonly AgentDefinition[] = AGENT_CATALOGUE): ReadonlyMap<string, AgentDefinition> {
  return new Map(catalogue.map((agent) => [agent.id, agent]));
}
