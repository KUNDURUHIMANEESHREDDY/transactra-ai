import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { RiskLevel } from "../../contracts/src/index.js";
import type { Action } from "../../policy/src/index.js";
import { authorizeAction, POLICY_VERSION } from "../../policy/src/index.js";
import { ApprovalStore } from "../../storage/src/approvals.js";
import { assertNoLikelySecrets } from "./secrets.js";

export class ApprovalRequiredError extends Error {
  constructor(readonly approvalId: string) { super("Owner approval required: " + approvalId); }
}

export interface ToolActor {
  ownerId: string;
  actorId: string;
  agentId: string;
  capabilities: readonly string[];
}
export interface ToolContext {
  actor: ToolActor;
  correlationId: string;
  taskId?: string;
  stepId?: string;
  approvalId?: string;
  signal: AbortSignal;
}
export interface ToolDefinition<TInput, TOutput> {
  capability: string;
  resource(input: TInput): string;
  action(input: TInput): Action;
  risk(input: TInput): RiskLevel;
  execute(input: TInput, context: ToolContext): Promise<TOutput>;
}
interface RegisteredTool {
  capability: string;
  resource(input: never): string;
  action(input: never): Action;
  risk(input: never): RiskLevel;
  execute(input: never, context: ToolContext): Promise<unknown>;
}
export interface ToolInvocationRequest<TInput> {
  actor: ToolActor;
  capability: string;
  input: TInput;
  correlationId: string;
  approvalId?: string;
  taskId?: string;
  stepId?: string;
  signal: AbortSignal;
}

export class ToolGateway {
  readonly #pool: Pool;
  readonly #approvals: ApprovalStore;
  readonly #tools = new Map<string, RegisteredTool>();

  constructor(connectionString: string, approvals: ApprovalStore) {
    if (!connectionString.trim()) throw new Error("DATABASE_URL is required");
    this.#pool = new Pool({ connectionString, max: 4, application_name: "transactra-tool-gateway" });
    this.#approvals = approvals;
  }
  async close(): Promise<void> { await this.#pool.end(); }

  has(capability: string): boolean { return this.#tools.has(capability); }

  capabilities(): string[] { return [...this.#tools.keys()].sort(); }

  register<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): void {
    if (!/^[a-z][a-z0-9.-]{2,100}$/.test(definition.capability)) throw new Error("Invalid tool capability name");
    if (this.#tools.has(definition.capability)) throw new Error("Tool capability already registered: " + definition.capability);
    this.#tools.set(definition.capability, definition as unknown as RegisteredTool);
  }

  async invoke<TInput, TOutput>(request: ToolInvocationRequest<TInput>): Promise<TOutput> {
    if (request.signal.aborted) throw request.signal.reason ?? new Error("Tool invocation cancelled");
    if (!request.correlationId.trim()) throw new Error("correlationId is required");
    const tool = this.#tools.get(request.capability);
    if (!tool) throw new Error("Tool capability is not registered: " + request.capability);
    const serialized = JSON.stringify(request.input);
    if (typeof serialized !== "string") throw new Error("Tool input must be JSON-serializable");
    assertNoLikelySecrets(serialized, "Tool input");
    const inputHash = createHash("sha256").update(serialized).digest("hex");
    const resource = String(tool.resource(request.input as never)).slice(0, 500);
    const invocationId = randomUUID();
    const hasCapability = request.actor.capabilities.includes(request.capability);
    const action = tool.action(request.input as never);
    assertNoLikelySecrets(JSON.stringify(action) ?? "null", "Tool policy action");
    const risk = tool.risk(request.input as never);
    const decision = authorizeAction(action, risk);
    const taskId = request.taskId ?? null;
    const approvalId = request.approvalId ?? null;
    if (approvalId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(approvalId)) throw new Error("approvalId must be a UUID");
    const approvalAction = {
      version: 1,
      taskId,
      stepId: request.stepId ?? null,
      actorId: request.actor.actorId,
      agentId: request.actor.agentId,
      capability: request.capability,
      resource,
      inputHash,
      input: request.input,
      policyAction: action,
      correlationId: request.correlationId
    };
    assertNoLikelySecrets(JSON.stringify(approvalAction) ?? "null", "Approval payload");

    await this.#pool.query(
      "INSERT INTO tool_invocations(id,task_id,actor_id,capability,resource,input_hash,policy_version,allowed,approval_id,outcome,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10)",
      [invocationId,taskId,request.actor.actorId,request.capability,resource,inputHash,POLICY_VERSION,decision.allowed && hasCapability,approvalId,request.correlationId]
    );

    if (!hasCapability || !decision.allowed) {
      await this.#completeAudit(invocationId, request.actor, request.capability, resource, inputHash, "denied", request.correlationId, decision.reason);
      throw new Error(!hasCapability ? "Agent does not hold the required capability" : decision.reason);
    }
    let approvedToolInvocation: string | undefined;
    if (decision.requiresApproval) {
      const consumed = await this.#approvals.consume({
        ownerId: request.actor.ownerId, action: approvalAction,
        ...(taskId ? { taskId } : {}),
        ...(approvalId ? { approvalId } : {})
      });
      if (!consumed && !approvalId) {
        const approval = await this.#approvals.request({
          ownerId: request.actor.ownerId,
          ...(taskId ? { taskId } : {}),
          action: approvalAction,
          requestedBy: request.actor.actorId
        });
        await this.#pool.query("UPDATE tool_invocations SET approval_id=$2 WHERE id=$1", [invocationId,approval.id]);
        await this.#notifyApprovalRequired(request.actor.ownerId, approval.id, request.capability, resource);
        await this.#completeAudit(invocationId, request.actor, request.capability, resource, inputHash, "waiting_approval", request.correlationId, "Approval request created");
        throw new ApprovalRequiredError(approval.id);
      }
      if (!consumed) {
        await this.#completeAudit(invocationId, request.actor, request.capability, resource, inputHash, "denied", request.correlationId, "The supplied approval is invalid, expired, already consumed, or does not match this action");
        throw new Error("The supplied approval is invalid, expired, already consumed, or does not match this action");
      }
      approvedToolInvocation = consumed;
    } else if (approvalId) {
      await this.#completeAudit(invocationId, request.actor, request.capability, resource, inputHash, "denied", request.correlationId, "Unexpected approval token for an action that does not require approval");
      throw new Error("Unexpected approval token for an action that does not require approval");
    }

    let output: unknown;
    try {
      if (request.signal.aborted) throw request.signal.reason ?? new Error("Tool invocation cancelled");
      output = await tool.execute(request.input as never, {
        actor: request.actor, correlationId: request.correlationId,
        ...(taskId ? { taskId } : {}),
        ...(request.stepId ? { stepId: request.stepId } : {}),
        ...(approvedToolInvocation ? { approvalId: approvedToolInvocation } : {}),
        signal: request.signal
      });
      assertNoLikelySecrets(JSON.stringify(output) ?? "null", "Tool output");
    } catch (error) {
      const reason = error instanceof Error ? error.name + ": " + error.message : "Tool failed";
      await this.#completeAudit(invocationId, request.actor, request.capability, resource, inputHash, "failed", request.correlationId, reason);
      throw error;
    }
    // If audit persistence fails after an external side effect, leave the invocation pending for reconciliation.
    await this.#completeAudit(invocationId, request.actor, request.capability, resource, inputHash, "succeeded", request.correlationId, "Tool completed");
    return output as TOutput;
  }

  async resumeApproved(actor: ToolActor, taskId: string, stepId: string, signal: AbortSignal): Promise<Array<{ approvalId: string; output: unknown }>> {
    const result = await this.#pool.query<{ id: string; action: unknown }>(
      "SELECT id,action FROM approvals WHERE owner_id=$1 AND task_id=$2 AND action->>'stepId'=$3 AND status='approved' AND consumed_at IS NULL AND expires_at>now() ORDER BY decided_at ASC",
      [actor.ownerId,taskId,stepId]
    );
    const resumed: Array<{ approvalId: string; output: unknown }> = [];
    for (const row of result.rows) {
      const payload = row.action as Record<string, unknown>;
      if (payload.version !== 1 || payload.agentId !== actor.agentId || payload.actorId !== actor.actorId || typeof payload.capability !== "string" || !actor.capabilities.includes(payload.capability)) {
        continue;
      }
      const output = await this.invoke({
        actor,
        capability: payload.capability,
        input: payload.input,
        correlationId: typeof payload.correlationId === "string" ? payload.correlationId : randomUUID(),
        taskId,
        stepId,
        approvalId: row.id,
        signal
      });
      resumed.push({ approvalId: row.id, output });
    }
    return resumed;
  }

  /**
   * Queues the owner-facing alert for a newly created approval so every channel surface can
   * deliver it durably, even if the worker that requested the approval exits immediately.
   */
  async #notifyApprovalRequired(ownerId: string, approvalId: string, capability: string, resource: string): Promise<void> {
    const message = [
      "Approval required",
      capability,
      resource,
      "Approve: /approve " + approvalId + " <reason>",
      "Reject: /reject " + approvalId + " <reason>"
    ].join("\n").slice(0,4000);
    try { assertNoLikelySecrets(message, "Approval notification"); } catch { return; }
    try {
      await this.#pool.query(
        "INSERT INTO notifications(owner_id,channel,kind,message) VALUES($1,'owner',$2,$3)",
        [ownerId,"approval_required",message]
      );
    } catch (error) {
      // The approval itself is already durable and visible through the control plane; a failed
      // alert must never invalidate the approval or fail the tool invocation that created it.
      process.stderr.write(JSON.stringify({ event: "approval_notification_failed", approvalId, errorType: error instanceof Error ? error.name : "Error" }) + "\n");
    }
  }

  async #completeAudit(
    invocationId: string, actor: ToolActor, capability: string, resource: string,
    inputHash: string, outcome: "succeeded" | "failed" | "denied" | "waiting_approval",
    correlationId: string, reason: string
  ): Promise<void> {
    try { assertNoLikelySecrets(reason, "Tool audit reason"); } catch { reason = "redacted_error"; }
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE tool_invocations SET outcome=$2,completed_at=now() WHERE id=$1", [invocationId,outcome]);
      await client.query(
        "INSERT INTO audit_events(owner_id,actor_id,action,resource,outcome,details,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [actor.ownerId,actor.actorId,capability,resource,outcome,JSON.stringify({ inputHash, reason }),correlationId]
      );
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}
