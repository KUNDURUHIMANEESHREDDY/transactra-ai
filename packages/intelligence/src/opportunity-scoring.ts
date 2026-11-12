export type EvidenceKind = "official" | "research" | "market_data" | "news" | "community";
export interface EvidenceItem {
  id: string;
  url: string;
  title: string;
  publisher: string;
  claim: string;
  kind: EvidenceKind;
  publishedAt: string;
  retrievedAt: string;
  credibility: number;
  relevance: number;
}
export interface OpportunityCandidate {
  id: string;
  problem: string;
  targetUser: string;
  proposedSolution: string;
  differentiation: string;
  problemSeverity: number;
  marketDemand: number;
  competitiveGap: number;
  feasibility: number;
  productDifferentiation: number;
  evidence: readonly EvidenceItem[];
}
export interface OpportunityScore {
  score: number;
  eligible: boolean;
  threshold: 90;
  components: {
    problemSeverity: number; marketDemand: number; evidenceQuality: number;
    competitiveGap: number; feasibility: number; productDifferentiation: number;
  };
  evidenceAssessment: {
    independentDomains: number; qualifyingSources: number; recentSources: number;
    primarySources: number; quality: number;
  };
  reasons: string[];
  evidenceIds: string[];
}

function bounded(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 5) throw new Error(field + " must be between 0 and 5");
  return value;
}
function validDate(value: string, field: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(field + " must be a valid ISO date");
  return time;
}
const MULTI_LABEL_SUFFIXES = new Set(["co.uk","org.uk","ac.uk","gov.uk","com.au","net.au","org.au","edu.au","gov.au","co.nz","org.nz","govt.nz","co.in","firm.in","net.in","org.in","gen.in","com.br","com.cn","com.sg","com.my","com.mx","com.za","co.za","co.jp","co.kr","co.id","com.tr","com.tw","com.hk"]);
export function registrableDomain(hostname: string): string {
  const labels = hostname.toLowerCase().replace(/^www\./,"").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const suffix = labels.slice(-2).join(".");
  return labels.slice(-(MULTI_LABEL_SUFFIXES.has(suffix) ? 3 : 2)).join(".");
}
function sourceWeight(kind: EvidenceKind): number {
  switch (kind) {
    case "official": return 1;
    case "research": return 1;
    case "market_data": return 1;
    case "news": return 0.8;
    case "community": return 0.6;
  }
}

export function scoreOpportunity(candidate: OpportunityCandidate, asOf = new Date()): OpportunityScore {
  for (const [field, value] of [
    ["problemSeverity",candidate.problemSeverity],["marketDemand",candidate.marketDemand],
    ["competitiveGap",candidate.competitiveGap],["feasibility",candidate.feasibility],
    ["productDifferentiation",candidate.productDifferentiation]
  ] as const) bounded(value, field);
  if (!candidate.problem.trim() || !candidate.targetUser.trim() || !candidate.proposedSolution.trim() || !candidate.differentiation.trim()) {
    throw new Error("Opportunity must define a problem, target user, solution and differentiation");
  }
  const unique = new Map<string, EvidenceItem>();
  for (const item of candidate.evidence) {
    if (!item.id.trim() || !item.title.trim() || !item.publisher.trim() || !item.claim.trim()) throw new Error("Evidence item is missing required provenance fields");
    const url = new URL(item.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Evidence URLs must use HTTP or HTTPS");
    bounded(item.credibility, "evidence credibility");
    bounded(item.relevance, "evidence relevance");
    unique.set(url.toString(), item);
  }
  const evidence = [...unique.values()];
  const domains = new Set(evidence.map((item) => registrableDomain(new URL(item.url).hostname)));
  const now = asOf.getTime();
  if (!Number.isFinite(now)) throw new Error("asOf must be a valid date");
  const recentSources = evidence.filter((item) => {
    const published = validDate(item.publishedAt, "publishedAt");
    const retrieved = validDate(item.retrievedAt, "retrievedAt");
    if (published > now || retrieved > now) throw new Error("Evidence timestamps cannot be in the future");
    return now - published <= 90 * 86400000;
  }).length;
  const primarySources = evidence.filter((item) => ["official","research","market_data"].includes(item.kind)).length;
  const quality = evidence.length === 0 ? 0 : evidence.reduce((sum,item) => {
    const published = validDate(item.publishedAt, "publishedAt");
    if (published > now) throw new Error("Evidence publication date cannot be in the future");
    const ageDays = Math.max(0, (now - published) / 86400000);
    const freshness = ageDays <= 90 ? 1 : ageDays <= 180 ? 0.6 : 0.25;
    return sum + (item.credibility / 5) * (item.relevance / 5) * sourceWeight(item.kind) * freshness;
  },0) / evidence.length;
  const components = {
    problemSeverity: candidate.problemSeverity / 5 * 20,
    marketDemand: candidate.marketDemand / 5 * 20,
    evidenceQuality: quality * 20,
    competitiveGap: candidate.competitiveGap / 5 * 15,
    feasibility: candidate.feasibility / 5 * 15,
    productDifferentiation: candidate.productDifferentiation / 5 * 10
  };
  const score = Math.round(Object.values(components).reduce((sum,value) => sum + value,0));
  const reasons: string[] = [];
  if (evidence.length < 3) reasons.push("At least three distinct evidence URLs are required.");
  if (domains.size < 2) reasons.push("Evidence must cover at least two independent publisher domains.");
  if (recentSources < 2) reasons.push("At least two evidence sources must be published within the last 90 days.");
  if (primarySources < 1) reasons.push("At least one official, research or market-data source is required.");
  if (quality < 0.75) reasons.push("Evidence quality is below the 0.75 confidence gate.");
  if (score < 90) reasons.push("Weighted opportunity score is below 90/100.");
  return {
    score, eligible: score >= 90 && reasons.length === 0, threshold: 90,
    components,
    evidenceAssessment: { independentDomains: domains.size, qualifyingSources: evidence.length, recentSources, primarySources, quality: Number(quality.toFixed(3)) },
    reasons, evidenceIds: evidence.map((item) => item.id)
  };
}
