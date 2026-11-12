import test from "node:test";
import assert from "node:assert/strict";
import { scoreOpportunity } from "../dist/packages/intelligence/src/opportunity-scoring.js";
import { evaluateProjectQuality } from "../dist/packages/innovation/src/quality-gate.js";

const asOf = new Date("2026-11-08T00:00:00.000Z");
const evidence = [
  { id: "e1", url: "https://developer.example.com/report", title: "Official platform report", publisher: "Platform", claim: "Demand is rising.", kind: "official", publishedAt: "2026-11-01T00:00:00Z", retrievedAt: "2026-11-07T00:00:00Z", credibility: 5, relevance: 5 },
  { id: "e2", url: "https://research.example.org/study", title: "Independent study", publisher: "Research group", claim: "Users report this unmet need.", kind: "research", publishedAt: "2026-10-30T00:00:00Z", retrievedAt: "2026-11-07T00:00:00Z", credibility: 5, relevance: 5 },
  { id: "e3", url: "https://news.example.net/analysis", title: "Industry analysis", publisher: "News outlet", claim: "Competitors have not solved the workflow.", kind: "news", publishedAt: "2026-09-20T00:00:00Z", retrievedAt: "2026-11-07T00:00:00Z", credibility: 5, relevance: 5 }
];
const candidate = {
  id: "opportunity-1", problem: "A costly repeated workflow", targetUser: "Small engineering teams",
  proposedSolution: "A reliable automation product", differentiation: "Evidence-backed end-to-end workflow",
  problemSeverity: 5, marketDemand: 5, competitiveGap: 5, feasibility: 5,
  productDifferentiation: 5, evidence
};

test("evidence-rich opportunity can pass the 90-point threshold", () => {
  const score = scoreOpportunity(candidate, asOf);
  assert.equal(score.eligible, true);
  assert.ok(score.score >= 90);
  assert.equal(score.evidenceAssessment.independentDomains, 3);
});
test("opportunity with insufficient independent evidence is blocked", () => {
  const score = scoreOpportunity({ ...candidate, evidence: [evidence[0]] }, asOf);
  assert.equal(score.eligible, false);
  assert.ok(score.reasons.some((reason) => reason.includes("three distinct evidence URLs")));
});
test("project quality gate requires private repo and zero monthly cost", () => {
  const score = scoreOpportunity(candidate, asOf);
  const spec = {
    name: "Private Automation Project", elevatorPitch: "Automate the workflow safely.",
    targetUser: "Small engineering teams", problem: "Repeated manual work.",
    solution: "A verified automation engine.", differentiator: "Evidence-first.",
    architecture: "API, worker, PostgreSQL and isolated execution.",
    acceptanceCriteria: ["Criterion one", "Criterion two", "Criterion three"],
    testStrategy: "Unit, integration and security tests.",
    securityPlan: "Least privilege and approval gates.",
    dataHandlingPlan: "Private by default with retention controls.",
    deploymentPlan: "No-cost deployment after quota verification.",
    monitoringPlan: "Health, queue and incident metrics.",
    rollbackPlan: "Revert to known-good artifact.",
    maintenancePlan: "Scheduled dependency and security reviews.",
    successMetrics: ["Activation", "Time saved"], evidenceIds: ["e1","e2","e3"],
    estimatedMonthlyCostInr: 0, repositoryVisibility: "private"
  };
  assert.equal(evaluateProjectQuality(spec, score).approved, true);
  assert.equal(evaluateProjectQuality({ ...spec, estimatedMonthlyCostInr: 1 }, score).approved, false);
  assert.equal(evaluateProjectQuality({ ...spec, repositoryVisibility: "public" }, score).approved, false);
});
