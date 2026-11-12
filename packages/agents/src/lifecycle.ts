import type { AgentLifecycleStatus } from "../../contracts/src/index.js";

export interface AgentPerformanceEvidence {
  sampleSize: number;
  successRate: number | null;
  openAttempts: number;
}

export type LifecycleRecommendation =
  | { action: "promote"; reason: string }
  | { action: "quarantine"; reason: string }
  | { action: "restore_candidate"; reason: string }
  | { action: "retirement_candidate"; reason: string }
  | { action: "observe"; reason: string };

function valid(evidence: AgentPerformanceEvidence): void {
  if (!Number.isInteger(evidence.sampleSize) || evidence.sampleSize < 0) throw new Error("Agent sample size must be a non-negative integer");
  if (evidence.successRate !== null && (!Number.isFinite(evidence.successRate) || evidence.successRate < 0 || evidence.successRate > 100)) {
    throw new Error("Agent success rate must be between 0 and 100");
  }
  if (!Number.isInteger(evidence.openAttempts) || evidence.openAttempts < 0) throw new Error("Open attempts must be a non-negative integer");
}

/**
 * Safe lifecycle transitions may be applied automatically in the restrictive direction.
 * Promotion, restoration and retirement remain owner decisions.
 */
export function recommendAgentLifecycle(status: AgentLifecycleStatus, evidence: AgentPerformanceEvidence): LifecycleRecommendation {
  valid(evidence);
  const rate = evidence.successRate ?? 0;
  if (status === "retired") return { action: "observe", reason: "Agent is retired" };
  if (evidence.openAttempts > 3) {
    return { action: "quarantine", reason: "More than three step attempts have no terminal event; worker reconciliation is required" };
  }
  if (evidence.sampleSize >= 10 && rate < 60) {
    return { action: "quarantine", reason: "Execution success rate is below 60% across at least ten finalized steps" };
  }
  if (status === "quarantined") {
    if (evidence.sampleSize >= 20 && rate >= 85) return { action: "restore_candidate", reason: "Post-quarantine evidence meets the restoration threshold" };
    return { action: "observe", reason: "Quarantined; owner review required before restoring" };
  }
  if (evidence.sampleSize >= 30 && rate < 40) {
    return { action: "retirement_candidate", reason: "Success rate is below 40% across at least thirty finalized steps; owner approval required to retire" };
  }
  if (status === "probation" && evidence.sampleSize >= 5 && rate >= 85 && evidence.openAttempts === 0) {
    return { action: "promote", reason: "Probationary agent meets the promotion threshold with five successful finalized steps" };
  }
  if (evidence.sampleSize < 5) return { action: "observe", reason: "Insufficient execution evidence" };
  return { action: "observe", reason: "Performance is inside the retained band" };
}

export function isAutomaticallyApplicable(recommendation: LifecycleRecommendation): boolean {
  return recommendation.action === "promote" || recommendation.action === "quarantine";
}
