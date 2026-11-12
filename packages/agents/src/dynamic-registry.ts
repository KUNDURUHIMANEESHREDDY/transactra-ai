import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import type { AgentDefinition, AgentLifecycleStatus, TaskDepartment } from "../../contracts/src/index.js";
import { AGENT_CATALOGUE } from "./registry.js";
import { recommendAgentLifecycle, isAutomaticallyApplicable, type AgentPerformanceEvidence } from "./lifecycle.js";

export const AGENT_DEPARTMENTS: readonly TaskDepartment[] = ["orchestration","engineering","intelligence","innovation","operations","security","evolution"];

/** Capabilities a dynamically created agent may hold. Self-management and root system changes stay with reviewed agents. */
export const DYNAMIC_AGENT_CAPABILITIES: ReadonlySet<string> = new Set([
  "research.search","opportunity.score","intelligence.report",
  "project.quality.evaluate","github.repo.create","github.file.write","innovation.persist",
  "github.issues.read","github.issue.create","github.issue.comment","github.file.read",
  "github.branch.create","github.pr.create","github.pr.read","github.pr.files.read",
  "github.pr.review","github.pr.merge","github.actions.status","github.actions.dispatch",
  "sandbox.verify","system.observe","incident.analyze","recovery.propose",
  "operations.monitor","notifications.enqueue","policy.review","security.audit","approval.recommend",
  "memory.search","memory.write","task.delegate","task.evaluate","organization.status",
  "evolution.audit","evolution.propose","evolution.validate","evolution.ci_status",
  "deployment.dispatch","deployment.status"
]);

export interface StoredAgent {
  id: string;
  name: string;
  department: TaskDepartment;
  system_prompt: string;
  capabilities: string[];
  max_concurrent_tasks: number;
  lifecycle_status: AgentLifecycleStatus;
  parent_agent_id: string | null;
  model: string | null;
  evaluation: Record<string, unknown>;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreateAgentInput {
  name: string;
  department: TaskDepartment;
  systemPrompt: string;
  capabilities: readonly string[];
  maxConcurrentTasks?: number;
  parentAgentId?: string;
  model?: string;
  createdBy: string;
}

const TRANSITIONS: Readonly<Record<AgentLifecycleStatus, readonly AgentLifecycleStatus[]>> = {
  probation: ["enabled","quarantined","retired"],
  enabled: ["quarantined","disabled","retired"],
  quarantined: ["enabled","retired"],
  disabled: ["enabled","retired"],
  retired: []
};

function asDefinition(row: StoredAgent): AgentDefinition {
  return {
    id: row.id,
    name: row.name,
    department: row.department,
    capabilities: row.capabilities,
    maxConcurrentTasks: row.max_concurrent_tasks,
    systemPrompt: row.system_prompt,
    lifecycleStatus: row.lifecycle_status,
    ...(row.parent_agent_id ? { parentAgentId: row.parent_agent_id } : {}),
    ...(row.model ? { model: row.model } : {})
  };
}

export class AgentRegistry {
  readonly #pool: Pool;
  constructor(connectionString: string) {
    if (!connectionString.trim()) throw new Error("DATABASE_URL is required");
    this.#pool = new Pool({ connectionString, max: 4, application_name: "transactra-agent-registry" });
  }
  async close(): Promise<void> { await this.#pool.end(); }

  /** Static code-defined agents are the minimum viable workforce and are kept in sync with code. */
  async ensureStaticAgents(catalogue: readonly AgentDefinition[] = AGENT_CATALOGUE): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      for (const agent of catalogue) {
        await client.query(
          `INSERT INTO agents(id,name,department,system_prompt,capabilities,max_concurrent_tasks,lifecycle_status,definition_version,created_by)
           VALUES($1,$2,$3,$4,$5::text[],$6,'enabled',1,'system:static')
           ON CONFLICT(id) DO UPDATE SET
             name=EXCLUDED.name,
             department=EXCLUDED.department,
             system_prompt=EXCLUDED.system_prompt,
             capabilities=EXCLUDED.capabilities,
             max_concurrent_tasks=EXCLUDED.max_concurrent_tasks,
             definition_version=agents.definition_version + CASE
               WHEN agents.name IS DISTINCT FROM EXCLUDED.name
                 OR agents.department IS DISTINCT FROM EXCLUDED.department
                 OR agents.system_prompt IS DISTINCT FROM EXCLUDED.system_prompt
                 OR agents.capabilities IS DISTINCT FROM EXCLUDED.capabilities
                 OR agents.max_concurrent_tasks IS DISTINCT FROM EXCLUDED.max_concurrent_tasks
               THEN 1 ELSE 0 END,
             updated_at=now()
           WHERE agents.created_by='system:static'`,
          [agent.id,agent.name,agent.department,agent.systemPrompt ?? "",agent.capabilities,agent.maxConcurrentTasks]
        );
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async list(departments: readonly TaskDepartment[] = AGENT_DEPARTMENTS, includeInactive = false): Promise<StoredAgent[]> {
    if (departments.length === 0) return [];
    const result = await this.#pool.query<StoredAgent>(
      "SELECT * FROM agents WHERE department = ANY($1::text[]) AND ($2::boolean OR lifecycle_status IN ('enabled','probation')) ORDER BY department ASC,name ASC",
      [departments,includeInactive]
    );
    return result.rows;
  }

  async definitions(departments: readonly TaskDepartment[] = AGENT_DEPARTMENTS): Promise<AgentDefinition[]> {
    return (await this.list(departments,false)).map(asDefinition);
  }

  async get(id: string, includeInactive = false): Promise<StoredAgent | null> {
    const result = await this.#pool.query<StoredAgent>(
      "SELECT * FROM agents WHERE id=$1 AND ($2::boolean OR lifecycle_status IN ('enabled','probation'))",
      [id,includeInactive]
    );
    return result.rows[0] ?? null;
  }

  async createDynamic(input: CreateAgentInput): Promise<StoredAgent> {
    const name = input.name.trim();
    if (name.length < 3 || name.length > 80) throw new Error("Agent name must be between 3 and 80 characters");
    if (!/^[A-Za-z][A-Za-z0-9 ._-]{2,79}$/.test(name)) throw new Error("Agent name contains unsupported characters");
    if (!AGENT_DEPARTMENTS.includes(input.department)) throw new Error("Unknown agent department");
    const prompt = input.systemPrompt.trim();
    if (prompt.length < 40 || prompt.length > 8000) throw new Error("Agent system prompt must be between 40 and 8000 characters");
    if (input.capabilities.length === 0 || input.capabilities.length > 20) throw new Error("An agent needs between 1 and 20 capabilities");
    const capabilities = [...new Set(input.capabilities)];
    for (const capability of capabilities) {
      if (!DYNAMIC_AGENT_CAPABILITIES.has(capability)) throw new Error("Dynamic agent capability is not permitted: " + capability);
    }
    const maxConcurrentTasks = input.maxConcurrentTasks ?? 1;
    if (!Number.isInteger(maxConcurrentTasks) || maxConcurrentTasks < 1 || maxConcurrentTasks > 4) throw new Error("Dynamic agent concurrency must be between 1 and 4");
    if (input.parentAgentId) {
      const parent = await this.get(input.parentAgentId);
      if (!parent) throw new Error("Parent agent does not exist or is not active");
      if (parent.department !== input.department) throw new Error("Child agent must remain in the parent's department");
    }
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,32) || "agent";
    const id = "dyn-" + slug + "-" + randomBytes(4).toString("hex");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<StoredAgent>(
        `INSERT INTO agents(id,name,department,system_prompt,capabilities,max_concurrent_tasks,lifecycle_status,parent_agent_id,model,created_by)
         VALUES($1,$2,$3,$4,$5::text[],$6,'probation',$7,$8,$9) RETURNING *`,
        [id,name,input.department,prompt,capabilities,maxConcurrentTasks,input.parentAgentId ?? null,input.model ?? null,input.createdBy]
      );
      const agent = result.rows[0];
      if (!agent) throw new Error("Dynamic agent was not persisted");
      await client.query(
        "INSERT INTO agent_lifecycle_events(agent_id,event_type,payload,actor_id) VALUES($1,'agent.created',$2,$3)",
        [id,JSON.stringify({ name, department:input.department, capabilities, parentAgentId:input.parentAgentId ?? null }),input.createdBy]
      );
      await client.query("COMMIT");
      return agent;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async transition(input: { agentId: string; to: AgentLifecycleStatus; actorId: string; reason: string }): Promise<StoredAgent> {
    const reason = input.reason.trim();
    if (!reason || reason.length > 1000) throw new Error("Lifecycle transition requires a reason of at most 1000 characters");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{ lifecycle_status: AgentLifecycleStatus; created_by: string }>(
        "SELECT lifecycle_status,created_by FROM agents WHERE id=$1 FOR UPDATE",[input.agentId]
      );
      const row = current.rows[0];
      if (!row) throw new Error("Agent not found");
      if (row.lifecycle_status === input.to) throw new Error("Agent already has lifecycle status " + input.to);
      if (!TRANSITIONS[row.lifecycle_status].includes(input.to)) throw new Error("Lifecycle transition " + row.lifecycle_status + " -> " + input.to + " is not permitted");
      const result = await client.query<StoredAgent>(
        "UPDATE agents SET lifecycle_status=$2,updated_at=now(),definition_version=definition_version+1 WHERE id=$1 RETURNING *",
        [input.agentId,input.to]
      );
      const agent = result.rows[0];
      if (!agent) throw new Error("Agent transition was not persisted");
      await client.query(
        "INSERT INTO agent_lifecycle_events(agent_id,event_type,payload,actor_id) VALUES($1,'agent.lifecycle_changed',$2,$3)",
        [input.agentId,JSON.stringify({ from:row.lifecycle_status,to:input.to,reason }),input.actorId]
      );
      await client.query("COMMIT");
      return agent;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async performance(agentId: string): Promise<AgentPerformanceEvidence> {
    const result = await this.#pool.query<{ finalized:string; completed:string; open_attempts:string }>(`
      WITH started AS (
        SELECT task_id,payload->>'stepId' AS step_id,payload->>'executionId' AS execution_id
        FROM task_events
        WHERE event_type='task.step_started' AND actor_id=$1 AND created_at >= now()-interval '30 days'
      ), finished AS (
        SELECT task_id,payload->>'stepId' AS step_id,payload->>'executionId' AS execution_id,event_type
        FROM task_events
        WHERE event_type IN ('task.step_completed','task.step_failed','task.step_waiting_approval')
          AND actor_id=$1 AND created_at >= now()-interval '30 days'
      )
      SELECT
        COUNT(*) FILTER (WHERE f.event_type IN ('task.step_completed','task.step_failed'))::text AS finalized,
        COUNT(*) FILTER (WHERE f.event_type='task.step_completed')::text AS completed,
        COUNT(*) FILTER (WHERE f.event_type IS NULL)::text AS open_attempts
      FROM started s LEFT JOIN finished f
        ON f.task_id=s.task_id AND f.step_id=s.step_id AND f.execution_id=s.execution_id
    `,[agentId]);
    const row = result.rows[0];
    const finalized = Number(row?.finalized ?? "0");
    const completed = Number(row?.completed ?? "0");
    const openAttempts = Number(row?.open_attempts ?? "0");
    return {
      sampleSize: finalized,
      successRate: finalized === 0 ? null : Math.round((completed / finalized) * 1000) / 10,
      openAttempts
    };
  }

  /** Applies only restrictive/promotional transitions; retirement and restoration stay owner-gated. */
  async applySafeLifecycleTransitions(): Promise<Array<{ agentId: string; action: string; reason: string }>> {
    const agents = await this.list(AGENT_DEPARTMENTS,true);
    const applied: Array<{ agentId: string; action: string; reason: string }> = [];
    for (const agent of agents) {
      if (agent.lifecycle_status === "retired") continue;
      const evidence = await this.performance(agent.id);
      const recommendation = recommendAgentLifecycle(agent.lifecycle_status,evidence);
      if (isAutomaticallyApplicable(recommendation)) {
        const to: AgentLifecycleStatus = recommendation.action === "promote" ? "enabled" : "quarantined";
        try {
          await this.transition({ agentId:agent.id,to,actorId:"system:lifecycle",reason:recommendation.reason });
          await this.#pool.query(
            "INSERT INTO notifications(owner_id,kind,message) SELECT owner_id,$2,$3 FROM owners WHERE status='active'",
            ["agent_lifecycle","Agent " + agent.id + " moved to " + to + ": " + recommendation.reason]
          );
          applied.push({ agentId:agent.id, action:to, reason:recommendation.reason });
        } catch {
          // A concurrent transition is not an error for the sweep; the next cycle re-evaluates.
        }
      } else if (recommendation.action === "restore_candidate" || recommendation.action === "retirement_candidate") {
        applied.push({ agentId:agent.id, action:recommendation.action, reason:recommendation.reason });
      }
      await this.#pool.query(
        "UPDATE agents SET evaluation=$2::jsonb,updated_at=now() WHERE id=$1",
        [agent.id,JSON.stringify({ ...evidence, recommendation:recommendation.action, evaluatedAt:new Date().toISOString() })]
      );
    }
    return applied;
  }

  async events(agentId: string, limit = 50): Promise<Array<{ event_type:string; payload:unknown; actor_id:string; created_at:Date }>> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Agent event limit must be between 1 and 200");
    const result = await this.#pool.query(
      "SELECT event_type,payload,actor_id,created_at FROM agent_lifecycle_events WHERE agent_id=$1 ORDER BY id DESC LIMIT $2",
      [agentId,limit]
    );
    return result.rows;
  }
}
