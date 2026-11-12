export type RiskLevel = "low" | "medium" | "high" | "critical";
export type TaskStatus = "queued" | "running" | "waiting_approval" | "succeeded" | "failed" | "cancelled";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type TaskDepartment = "orchestration" | "engineering" | "intelligence" | "innovation" | "operations" | "security" | "evolution";
export type AgentLifecycleStatus = "probation" | "enabled" | "quarantined" | "disabled" | "retired";
export interface Actor { id: string; kind: "owner" | "agent" | "system"; }
export interface TaskRequest { id: string; title: string; objective: string; department: TaskDepartment; requestedBy: Actor; risk: RiskLevel; createdAt: string; idempotencyKey: string; }
export interface PolicyDecision { allowed: boolean; requiresApproval: boolean; reason: string; policyVersion: string; }
export interface AgentDefinition { id: string; name: string; department: TaskDepartment; capabilities: readonly string[]; maxConcurrentTasks: number; systemPrompt?: string; lifecycleStatus?: AgentLifecycleStatus; parentAgentId?: string; model?: string; }
export interface ProviderRequest { model?: string; systemPrompt?: string; input: string; maxOutputTokens: number; estimatedCostInr: number; }
export interface ProviderResponse { output: string; provider: string; model: string; usage?: { inputTokens: number; outputTokens: number }; }
