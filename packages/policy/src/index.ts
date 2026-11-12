import type { PolicyDecision, RiskLevel } from "../../contracts/src/index.js";
export const POLICY_VERSION = "2026-11-08.1";
export const MONTHLY_SPEND_LIMIT_INR = 0;
export type Action =
  | { kind: "model_inference"; estimatedCostInr: number }
  | { kind: "external_search"; estimatedCostInr: number }
  | { kind: "local_computation"; estimatedCostInr: number }
  | { kind: "repository_read" }
  | { kind: "repository_write"; visibilityChange?: boolean }
  | { kind: "production_deploy" }
  | { kind: "destructive_operation" }
  | { kind: "permission_change" }
  | { kind: "agent_creation" }
  | { kind: "system_change" }
  | { kind: "deployment_rollback" }
  | { kind: "external_message"; recipientAllowlisted: boolean };
const APPROVAL_ACTIONS = new Set<Action["kind"]>(["production_deploy", "destructive_operation", "permission_change", "agent_creation", "system_change", "deployment_rollback"]);
export function authorizeAction(action: Action, risk: RiskLevel): PolicyDecision {
  const deny = (reason: string): PolicyDecision => ({ allowed: false, requiresApproval: false, reason, policyVersion: POLICY_VERSION });
  if (action.kind === "model_inference" || action.kind === "external_search" || action.kind === "local_computation") {
    if (!Number.isFinite(action.estimatedCostInr) || action.estimatedCostInr < 0) return deny("Provider cost estimate is invalid; fail closed.");
    if (action.estimatedCostInr > MONTHLY_SPEND_LIMIT_INR) return deny("Spend ceiling is INR 0; paid provider usage is prohibited.");
  }
  if (action.kind === "repository_write" && action.visibilityChange) return { allowed: true, requiresApproval: true, reason: "Repository visibility changes require owner approval.", policyVersion: POLICY_VERSION };
  if (action.kind === "external_message" && !action.recipientAllowlisted) return deny("Recipient is not allowlisted.");
  if (APPROVAL_ACTIONS.has(action.kind) || risk === "critical" || risk === "high") return { allowed: true, requiresApproval: true, reason: "Sensitive or high-risk action requires explicit owner approval.", policyVersion: POLICY_VERSION };
  return { allowed: true, requiresApproval: false, reason: "Action is within the baseline policy.", policyVersion: POLICY_VERSION };
}
