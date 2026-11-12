import type { OpportunityScore } from "../../intelligence/src/opportunity-scoring.js";

export interface ProjectSpecification {
  name: string;
  elevatorPitch: string;
  targetUser: string;
  problem: string;
  solution: string;
  differentiator: string;
  architecture: string;
  acceptanceCriteria: readonly string[];
  testStrategy: string;
  securityPlan: string;
  dataHandlingPlan: string;
  deploymentPlan: string;
  monitoringPlan: string;
  rollbackPlan: string;
  maintenancePlan: string;
  successMetrics: readonly string[];
  evidenceIds: readonly string[];
  estimatedMonthlyCostInr: number;
  repositoryVisibility: "private" | "public";
}
export interface ProjectQualityResult {
  approved: boolean;
  score: number;
  threshold: 90;
  reasons: string[];
}

export function evaluateProjectQuality(spec: ProjectSpecification, opportunity: OpportunityScore): ProjectQualityResult {
  const reasons = [...opportunity.reasons];
  if (!opportunity.eligible || opportunity.score < 90) reasons.push("Opportunity has not passed the evidence-backed 90/100 gate.");
  const required: Array<[keyof ProjectSpecification,string]> = [
    ["name","Project name"],["elevatorPitch","Elevator pitch"],["targetUser","Target user"],
    ["problem","Problem statement"],["solution","Solution"],["differentiator","Differentiation"],
    ["architecture","Architecture"],["testStrategy","Test strategy"],["securityPlan","Security plan"],
    ["dataHandlingPlan","Data handling plan"],["deploymentPlan","Deployment plan"],
    ["monitoringPlan","Monitoring plan"],["rollbackPlan","Rollback plan"],["maintenancePlan","Maintenance plan"]
  ];
  for (const [key,label] of required) {
    const value = spec[key];
    if (typeof value !== "string" || !value.trim()) reasons.push(label + " is missing.");
  }
  if (!Array.isArray(spec.acceptanceCriteria) || spec.acceptanceCriteria.filter((item) => typeof item === "string" && item.trim()).length < 3) reasons.push("At least three measurable acceptance criteria are required.");
  if (!Array.isArray(spec.successMetrics) || spec.successMetrics.filter((item) => typeof item === "string" && item.trim()).length < 2) reasons.push("At least two success metrics are required.");
  if (!Array.isArray(spec.evidenceIds) || spec.evidenceIds.length < 3 || spec.evidenceIds.some((id) => !opportunity.evidenceIds.includes(id))) {
    reasons.push("Project specification must cite at least three evidence items from the scored opportunity.");
  }
  if (!Number.isFinite(spec.estimatedMonthlyCostInr) || spec.estimatedMonthlyCostInr !== 0) {
    reasons.push("Estimated monthly operating cost must be exactly INR 0.");
  }
  if (spec.repositoryVisibility !== "private") reasons.push("New project repositories must be private by default.");
  return { approved: reasons.length === 0, score: opportunity.score, threshold: 90, reasons: [...new Set(reasons)] };
}
