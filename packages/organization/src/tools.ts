import type { TaskDepartment } from "../../contracts/src/index.js";
import type { Action } from "../../policy/src/index.js";
import { authorizeAction, MONTHLY_SPEND_LIMIT_INR, POLICY_VERSION } from "../../policy/src/index.js";
import type { RiskLevel } from "../../contracts/src/index.js";
import type { ToolGateway } from "../../security/src/tool-gateway.js";
import type { ApprovalStore } from "../../storage/src/approvals.js";
import type { MemoryStore } from "../../storage/src/memory.js";
import type { PostgresTaskStore } from "../../storage/src/postgres.js";
import type { IntelligenceStore } from "../../storage/src/intelligence.js";
import type { OrganizationStore, ProposalStatus } from "../../storage/src/organization.js";
import type { AgentDefinition, AgentLifecycleStatus } from "../../contracts/src/index.js";
import { AGENT_DEPARTMENTS, type AgentRegistry } from "../../agents/src/dynamic-registry.js";
import { evaluateOperations, type OperationsMonitor } from "./operations.js";
import type { DeploymentEngine } from "./deployments.js";
import type { SecurityAuditor } from "./security.js";
import type { EvolutionEngine } from "./evolution.js";

const LOCAL = (): Action => ({ kind: "local_computation", estimatedCostInr: 0 });
const READ = (): Action => ({ kind: "repository_read" });
const POLICY_ACTION_KINDS: ReadonlySet<string> = new Set([
  "model_inference","external_search","local_computation","repository_read","repository_write",
  "production_deploy","destructive_operation","permission_change","agent_creation",
  "system_change","deployment_rollback","external_message"
]);

function requireText(value: unknown, name: string, max = 4000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(name + " must be a non-empty string of at most " + max + " characters");
  return value.trim();
}
function optionalText(value: unknown, name: string, max = 4000): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireText(value, name, max);
}
function requireDepartment(value: unknown): TaskDepartment {
  if (typeof value !== "string" || !AGENT_DEPARTMENTS.includes(value as TaskDepartment)) throw new Error("Unknown task department");
  return value as TaskDepartment;
}
function requireRisk(value: unknown): RiskLevel {
  if (value !== "low" && value !== "medium" && value !== "high" && value !== "critical") throw new Error("Task risk must be low, medium, high or critical");
  return value;
}
function requireStatus(value: unknown): "scaffolded" | "verified" | "validation_failed" | "deployed" | "archived" {
  if (value !== "scaffolded" && value !== "verified" && value !== "validation_failed" && value !== "deployed" && value !== "archived") {
    throw new Error("Unknown project status");
  }
  return value;
}
function requireId(value: unknown, name: string): string {
  const id = requireText(value, name, 200);
  return id;
}

export interface OrganizationToolDependencies {
  store: OrganizationStore;
  memory: MemoryStore;
  intelligence: IntelligenceStore;
  operations: OperationsMonitor;
  registry: AgentRegistry;
  taskStore: PostgresTaskStore;
  approvals: ApprovalStore;
  security: SecurityAuditor;
  deployments?: DeploymentEngine;
  evolution?: EvolutionEngine;
}

/** Registers every real organisation, workforce, memory and operations tool on the shared gateway. */
export function registerOrganizationTools(gateway: ToolGateway, deps: OrganizationToolDependencies): void {
  const { store, memory, intelligence, operations, registry, taskStore, approvals, security } = deps;

  gateway.register<{ query: string; limit?: number; projectId?: string }, unknown>({
    capability: "memory.search",
    resource: (input) => "memory:" + input.query.slice(0,200),
    action: LOCAL, risk: (): RiskLevel => "low",
    execute: (input, context) => memory.search(
      context.actor.ownerId,
      requireText(input.query,"Memory query",500),
      input.limit ?? 10,
      input.projectId
    )
  });

  gateway.register<{ content: string; sourceType?: string; sourceRef?: string; projectId?: string; sensitivity?: "public" | "internal" | "confidential" }, unknown>({
    capability: "memory.write",
    resource: (input) => "memory:write:" + input.content.slice(0,120),
    action: LOCAL, risk: (): RiskLevel => "low",
    execute: (input, context) => memory.add({
      ownerId: context.actor.ownerId,
      content: requireText(input.content,"Memory content",100000),
      sourceType: input.sourceType ?? (context.taskId ? "task" : "agent"),
      ...(input.sourceRef ?? context.taskId ? { sourceRef: input.sourceRef ?? context.taskId } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.sensitivity ? { sensitivity: input.sensitivity } : {})
    })
  });

  gateway.register<Record<string, never>, unknown>({
    capability: "organization.status",
    resource: () => "organization:status",
    action: LOCAL, risk: (): RiskLevel => "low",
    execute: async (_input, context) => {
      const ownerId = context.actor.ownerId;
      const [snapshot, agents, incidents, tasks, projects, proposals, deployments, reports, audits] = await Promise.all([
        operations.snapshot(ownerId),
        registry.list(AGENT_DEPARTMENTS,true),
        store.openIncidentCounts(ownerId),
        taskStore.list(ownerId,25),
        store.listProjects(ownerId,10),
        store.listProposals(ownerId,10),
        store.listDeployments(ownerId,10),
        intelligence.listReports(ownerId,5),
        store.listAudits(ownerId,1)
      ]);
      return {
        observedAt: snapshot.observedAt,
        operations: snapshot,
        agents: {
          total: agents.length,
          byStatus: agents.reduce<Record<string,number>>((counts,agent) => {
            counts[agent.lifecycle_status] = (counts[agent.lifecycle_status] ?? 0) + 1;
            return counts;
          },{}),
          active: agents.filter((agent) => agent.lifecycle_status === "enabled" || agent.lifecycle_status === "probation").map((agent) => agent.id)
        },
        incidents,
        recentTasks: tasks.map((task) => ({ id:task.id,title:task.title,department:task.department,status:task.status,risk:task.risk,attempt:task.attempt,createdAt:task.created_at })),
        projects: projects.map((project) => ({ id:project.id,name:project.name,status:project.status,repository:project.repository_full_name })),
        proposals: proposals.map((proposal) => ({ id:proposal.id,title:proposal.title,status:proposal.status,updatedAt:proposal.updated_at })),
        deployments: deployments.map((deployment) => ({ id:deployment.id,repository:deployment.repository,environment:deployment.environment,status:deployment.status })),
        latestReports: reports.map((report) => ({ id:report.id,summary:report.summary,createdAt:report.created_at })),
        latestAudit: audits[0] ? { id:audits[0].id,score:audits[0].score,createdAt:audits[0].created_at } : null
      };
    }
  });

  gateway.register<{ title: string; objective: string; department: string; risk: string; priority?: number; idempotencyKey: string }, unknown>({
    capability: "task.delegate",
    resource: (input) => "task:" + input.department + ":" + input.idempotencyKey.slice(0,120),
    action: LOCAL, risk: (): RiskLevel => "low",
    execute: async (input, context) => {
      const department = requireDepartment(input.department);
      const risk = requireRisk(input.risk);
      const result = await taskStore.enqueue({
        ownerId: context.actor.ownerId,
        title: requireText(input.title,"Task title",300),
        objective: requireText(input.objective,"Task objective",12000),
        department,
        risk,
        idempotencyKey: requireText(input.idempotencyKey,"Task idempotency key",200),
        requestedBy: { id: context.actor.agentId, kind: "agent" },
        ...(input.priority !== undefined ? { priority: input.priority } : {})
      });
      return { taskId: result.task.id, created: result.created, status: result.task.status };
    }
  });

  gateway.register<{ taskId: string }, unknown>({
    capability: "task.evaluate",
    resource: (input) => "task:evaluate:" + input.taskId,
    action: LOCAL, risk: (): RiskLevel => "low",
    execute: async (input, context) => {
      const taskId = requireId(input.taskId,"Task ID");
      const task = await taskStore.get(context.actor.ownerId,taskId);
      if (!task) throw new Error("Task not found in owner scope");
      const events = await taskStore.events(context.actor.ownerId,taskId);
      const counts: Record<string,number> = {};
      for (const event of events) counts[event.event_type] = (counts[event.event_type] ?? 0) + 1;
      const terminal = counts["task.completed"] ?? counts["task.succeeded"] ?? 0;
      return {
        taskId, title: task.title, department: task.department, status: task.status,
        risk: task.risk, attempt: task.attempt, maxAttempts: task.max_attempts,
        eventCounts: counts,
        completedSteps: counts["task.step_completed"] ?? 0,
        failedSteps: counts["task.step_failed"] ?? 0,
        approvalWaits: counts["task.step_waiting_approval"] ?? 0,
        terminalCompletions: terminal,
        verdict: task.status === "succeeded" ? "succeeded" : task.status === "failed" ? "failed" : "in_progress"
      };
    }
  });

  gateway.register<{ name: string; department: string; systemPrompt: string; capabilities: string[]; maxConcurrentTasks?: number; parentAgentId?: string; model?: string }, unknown>({
    capability: "agent.create",
    resource: (input) => "agent:create:" + input.name.slice(0,80),
    action: (): Action => ({ kind: "agent_creation" }), risk: (): RiskLevel => "high",
    execute: (input, context) => registry.createDynamic({
      name: requireText(input.name,"Agent name",80),
      department: requireDepartment(input.department),
      systemPrompt: requireText(input.systemPrompt,"Agent system prompt",8000),
      capabilities: Array.isArray(input.capabilities) ? input.capabilities : [],
      ...(input.maxConcurrentTasks !== undefined ? { maxConcurrentTasks: input.maxConcurrentTasks } : {}),
      ...(input.parentAgentId ? { parentAgentId: input.parentAgentId } : {}),
      ...(input.model ? { model: input.model } : {}),
      createdBy: context.actor.actorId
    })
  });

  gateway.register<{ agentId: string }, unknown>({
    capability: "agent.evaluate",
    resource: (input) => "agent:evaluate:" + input.agentId,
    action: LOCAL, risk: (): RiskLevel => "low",
    execute: async (input, context) => {
      const agent = await registry.get(requireId(input.agentId,"Agent ID"),true);
      if (!agent) throw new Error("Agent not found");
      const [performance, events] = await Promise.all([registry.performance(agent.id),registry.events(agent.id,20)]);
      return {
        agent: {
          id: agent.id, name: agent.name, department: agent.department,
          capabilities: agent.capabilities, lifecycleStatus: agent.lifecycle_status,
          parentAgentId: agent.parent_agent_id, evaluation: agent.evaluation,
          createdBy: agent.created_by, updatedAt: agent.updated_at
        },
        performance,
        recentEvents: events
      };
    }
  });

  gateway.register<{ agentId: string; to: string; reason: string }, unknown>({
    capability: "agent.transition",
    resource: (input) => "agent:transition:" + input.agentId + ":" + input.to,
    action: (input): Action => {
      if (input.to === "retired") return { kind: "destructive_operation" };
      if (input.to === "enabled") return { kind: "system_change" };
      return { kind: "local_computation", estimatedCostInr: 0 };
    },
    risk: (input): RiskLevel => input.to === "retired" ? "high" : input.to === "enabled" ? "high" : "medium",
    execute: async (input, context) => {
      const to = input.to as AgentLifecycleStatus;
      if (!["probation","enabled","quarantined","disabled","retired"].includes(to)) throw new Error("Unknown agent lifecycle status");
      return registry.transition({
        agentId: requireId(input.agentId,"Agent ID"),
        to,
        actorId: context.actor.actorId,
        reason: requireText(input.reason,"Lifecycle reason",1000)
      });
    }
  });

  gateway.register<{ summary: string; findings: unknown[]; recommendations: unknown[]; sources: string[]; scores: unknown; taskId?: string }, unknown>({
    capability: "intelligence.report",
    resource: (input) => "intelligence:report:" + input.summary.slice(0,120),
    action: LOCAL, risk: (): RiskLevel => "low",
    execute: async (input, context) => {
      const taskId = input.taskId ?? context.taskId;
      if (!taskId) throw new Error("Intelligence reports must be scoped to a task");
      return intelligence.saveReport({
        ownerId: context.actor.ownerId,
        taskId,
        summary: requireText(input.summary,"Report summary",10000),
        findings: input.findings,
        recommendations: input.recommendations,
        sources: Array.isArray(input.sources) ? input.sources : [],
        scores: input.scores
      });
    }
  });

  gateway.register<{ name: string; repositoryFullName: string; repositoryUrl: string; specification: unknown; opportunityScore: unknown; verification?: unknown; status: string; taskId?: string }, unknown>({
    capability: "innovation.persist",
    resource: (input) => "project:" + input.repositoryFullName,
    action: LOCAL, risk: (): RiskLevel => "low",
    execute: async (input, context) => {
      const status = requireStatus(input.status);
      const taskId = input.taskId ?? context.taskId;
      return store.saveProject({
        ownerId: context.actor.ownerId,
        ...(taskId ? { taskId } : {}),
        name: requireText(input.name,"Project name",200),
        repositoryFullName: requireText(input.repositoryFullName,"Repository name",200),
        repositoryUrl: requireText(input.repositoryUrl,"Repository URL",500),
        specification: input.specification,
        opportunityScore: input.opportunityScore,
        ...(input.verification !== undefined ? { verification: input.verification } : {}),
        status
      });
    }
  });

  gateway.register<Record<string, never>, unknown>({
    capability: "system.observe",
    resource: () => "system:observe",
    action: LOCAL, risk: (): RiskLevel => "low",
    execute: (_input, context) => operations.snapshot(context.actor.ownerId)
  });

  gateway.register<Record<string, never>, unknown>({
    capability: "incident.analyze",
    resource: () => "incidents:analyze",
    action: LOCAL, risk: (): RiskLevel => "low",
    execute: async (_input, context) => {
      const [incidents, counts, snapshot] = await Promise.all([
        store.listIncidents(context.actor.ownerId,50,"open"),
        store.openIncidentCounts(context.actor.ownerId),
        operations.snapshot(context.actor.ownerId)
      ]);
      return {
        openCounts: counts,
        incidents: incidents.map((incident) => ({
          id: incident.id, key: incident.incident_key, severity: incident.severity,
          title: incident.title, details: incident.details, openedAt: incident.opened_at
        })),
        staleLeases: snapshot.staleLeases,
        stuckInvocations: snapshot.stuckToolInvocations,
        findings: evaluateOperations(snapshot)
      };
    }
  });

  gateway.register<Record<string, never>, unknown>({
    capability: "recovery.propose",
    resource: () => "recovery:propose",
    action: LOCAL, risk: (): RiskLevel => "low",
    execute: async (_input, context) => {
      const snapshot = await operations.snapshot(context.actor.ownerId);
      return {
        basedOn: snapshot.observedAt,
        proposals: evaluateOperations(snapshot).map((finding) => ({
          incidentKey: finding.key, severity: finding.severity,
          action: finding.recommendation, requiresApproval: finding.severity === "critical"
        })),
        safety: "Critical recovery actions require explicit owner approval; non-idempotent external effects are never replayed automatically."
      };
    }
  });

  gateway.register<{ notify?: boolean }, unknown>({
    capability: "operations.monitor",
    resource: () => "operations:monitor",
    action: LOCAL, risk: (): RiskLevel => "low",
    execute: (input, context) => operations.run(context.actor.ownerId,{ notify: input.notify ?? true })
  });

  gateway.register<{ kind: string; message: string; channel?: string }, unknown>({
    capability: "notifications.enqueue",
    resource: (input) => "notification:" + input.kind.slice(0,80),
    action: LOCAL, risk: (): RiskLevel => "low",
    execute: (input, context) => store.enqueueNotification({
      ownerId: context.actor.ownerId,
      kind: requireText(input.kind,"Notification kind",80),
      message: requireText(input.message,"Notification message",4000),
      ...(input.channel ? { channel: requireText(input.channel,"Notification channel",40) } : {})
    })
  });

  gateway.register<{ action: unknown; risk: string }, unknown>({
    capability: "policy.review",
    resource: () => "policy:review",
    action: LOCAL, risk: (): RiskLevel => "low",
    execute: async (input) => {
      if (!input.action || typeof input.action !== "object" || Array.isArray(input.action)) throw new Error("Policy review requires an action object");
      const candidate = input.action as Record<string, unknown>;
      if (typeof candidate.kind !== "string" || !POLICY_ACTION_KINDS.has(candidate.kind)) throw new Error("Unknown policy action kind");
      const action = candidate as unknown as Action;
      if ((action.kind === "model_inference" || action.kind === "external_search" || action.kind === "local_computation")
        && (typeof action.estimatedCostInr !== "number" || !Number.isFinite(action.estimatedCostInr))) {
        action.estimatedCostInr = 0;
      }
      const decision = authorizeAction(action,requireRisk(input.risk));
      return { ...decision, policyVersion: POLICY_VERSION, monthlySpendLimitInr: MONTHLY_SPEND_LIMIT_INR };
    }
  });

  gateway.register<Record<string, never>, unknown>({
    capability: "security.audit",
    resource: () => "security:audit",
    action: LOCAL, risk: (): RiskLevel => "low",
    execute: (_input, context) => security.audit(context.actor.ownerId)
  });

  gateway.register<Record<string, never>, unknown>({
    capability: "approval.recommend",
    resource: () => "approvals:recommend",
    action: LOCAL, risk: (): RiskLevel => "low",
    execute: async (_input, context) => {
      const pending = await approvals.listPending(context.actor.ownerId,50);
      const now = Date.now();
      return {
        pending: pending.map((approval) => {
          const action = (approval.action ?? {}) as Record<string, unknown>;
          const ageSeconds = Math.round((now - approval.created_at.getTime()) / 1000);
          return {
            approvalId: approval.id, taskId: approval.task_id,
            capability: action.capability ?? null, policyAction: action.policyAction ?? null,
            ageSeconds,
            expiresAt: approval.expires_at,
            recommendation: ageSeconds > 604800 ? "reject_or_revalidate" : "owner_review_required",
            reason: "Approval decisions remain with the owner; the agent can only surface evidence and age."
          };
        }),
        note: "Agents must never approve or reject their own approval requests."
      };
    }
  });

  if (deps.deployments) {
    const deployments = deps.deployments;
    gateway.register<{ repository: string; environment: "staging" | "production"; commitSha?: string }, unknown>({
      capability: "deployment.dispatch",
      resource: (input) => "deploy:" + input.repository + ":" + input.environment,
      action: (): Action => ({ kind: "production_deploy" }),
      risk: (): RiskLevel => "high",
      execute: (input, context) => deployments.dispatch({
        ownerId: context.actor.ownerId,
        ...(context.taskId ? { taskId: context.taskId } : {}),
        repository: requireText(input.repository,"Deployment repository",200),
        environment: input.environment === "staging" ? "staging" : "production",
        ...(input.commitSha ? { commitSha: input.commitSha } : {}),
        ...(context.approvalId ? { approvalId: context.approvalId } : {}),
        actorId: context.actor.actorId
      })
    });

    gateway.register<{ deploymentId: string }, unknown>({
      capability: "deployment.status",
      resource: (input) => "deploy:status:" + input.deploymentId,
      action: READ, risk: (): RiskLevel => "low",
      execute: (input, context) => deployments.status(context.actor.ownerId,requireId(input.deploymentId,"Deployment ID"))
    });

    gateway.register<{ deploymentId: string }, unknown>({
      capability: "deployment.rollback",
      resource: (input) => "deploy:rollback:" + input.deploymentId,
      action: (): Action => ({ kind: "deployment_rollback" }),
      risk: (): RiskLevel => "high",
      execute: (input, context) => deployments.rollback({
        ownerId: context.actor.ownerId,
        deploymentId: requireId(input.deploymentId,"Deployment ID"),
        approvalId: context.approvalId ?? "",
        actorId: context.actor.actorId
      })
    });
  }

  if (deps.evolution) {
    const evolution = deps.evolution;
    gateway.register<Record<string, never>, unknown>({
      capability: "evolution.audit",
      resource: () => "evolution:audit",
      action: LOCAL, risk: (): RiskLevel => "low",
      execute: (_input, context) => evolution.audit(context.actor.ownerId,context.taskId)
    });

    gateway.register<{ title: string; rationale: string; changes: unknown; baseline?: unknown; auditId?: string }, unknown>({
      capability: "evolution.propose",
      resource: (input) => "evolution:propose:" + input.title.slice(0,120),
      action: LOCAL, risk: (): RiskLevel => "medium",
      execute: (input, context) => evolution.propose({
        ownerId: context.actor.ownerId,
        ...(context.taskId ? { taskId: context.taskId } : {}),
        ...(input.auditId ? { auditId: input.auditId } : {}),
        title: requireText(input.title,"Proposal title",200),
        rationale: requireText(input.rationale,"Proposal rationale",5000),
        changes: input.changes,
        ...(input.baseline !== undefined ? { baseline: input.baseline } : {})
      })
    });

    gateway.register<{ proposalId: string }, unknown>({
      capability: "evolution.validate",
      resource: (input) => "evolution:validate:" + input.proposalId,
      action: LOCAL, risk: (): RiskLevel => "medium",
      execute: (input, context) => evolution.validate(context.actor.ownerId,requireId(input.proposalId,"Proposal ID"))
    });

    gateway.register<{ proposalId: string }, unknown>({
      capability: "evolution.apply",
      resource: (input) => "evolution:apply:" + input.proposalId,
      action: (): Action => ({ kind: "system_change" }),
      risk: (): RiskLevel => "high",
      execute: (input, context) => evolution.apply({
        ownerId: context.actor.ownerId,
        proposalId: requireId(input.proposalId,"Proposal ID"),
        approvalId: context.approvalId ?? "",
        actorId: context.actor.actorId
      })
    });

    gateway.register<{ proposalId: string }, unknown>({
      capability: "evolution.rollback",
      resource: (input) => "evolution:rollback:" + input.proposalId,
      action: (): Action => ({ kind: "system_change" }),
      risk: (): RiskLevel => "high",
      execute: (input, context) => evolution.rollback({
        ownerId: context.actor.ownerId,
        proposalId: requireId(input.proposalId,"Proposal ID"),
        approvalId: context.approvalId ?? "",
        actorId: context.actor.actorId
      })
    });

    gateway.register<{ proposalId: string }, unknown>({
      capability: "evolution.ci_status",
      resource: (input) => "evolution:ci:" + input.proposalId,
      action: READ, risk: (): RiskLevel => "low",
      execute: (input, context) => evolution.ciStatus(context.actor.ownerId,requireId(input.proposalId,"Proposal ID"))
    });
  }
}

/** Small helper used by the control plane and tests to describe the registered capability surface. */
export function registeredCapabilities(gateway: ToolGateway): string[] {
  return gateway.capabilities();
}

/** Re-exported for consumers that need to type an agent list entry without importing contracts. */
export type { AgentDefinition, ProposalStatus };
