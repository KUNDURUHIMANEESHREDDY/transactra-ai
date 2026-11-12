import { createHash } from "node:crypto";
import type { SearchResult } from "./tavily-search.js";
import type { EvidenceItem, EvidenceKind } from "../../intelligence/src/opportunity-scoring.js";

interface StoredEvidence { result: SearchResult; retrievedAt: string; }
const OFFICIAL_DOMAINS = new Set(["openai.com","nvidia.com","microsoft.com","google.com","apple.com","github.blog","developer.chrome.com","aws.amazon.com"]);
const RESEARCH_DOMAINS = new Set(["arxiv.org","nature.com","science.org","acm.org","ieee.org","dl.acm.org","jamanetwork.com","nejm.org"]);
const NEWS_DOMAINS = new Set(["reuters.com","techcrunch.com","theverge.com","wired.com","bloomberg.com","cnbc.com","venturebeat.com","arstechnica.com","axios.com"]);
const COMMUNITY_DOMAINS = new Set(["reddit.com","news.ycombinator.com","stackoverflow.com","dev.to"]);

function kindFor(hostname: string): EvidenceKind {
  const host = hostname.toLowerCase().replace(/^www\./,"");
  if (host.endsWith(".gov") || host === "gov.uk" || host.endsWith(".gov.uk") || host === "sec.gov" || host === "data.gov") return "market_data";
  if (host.endsWith(".edu") || [...RESEARCH_DOMAINS].some((domain) => host === domain || host.endsWith("." + domain))) return "research";
  if ([...OFFICIAL_DOMAINS].some((domain) => host === domain || host.endsWith("." + domain))) return "official";
  if ([...COMMUNITY_DOMAINS].some((domain) => host === domain || host.endsWith("." + domain))) return "community";
  if ([...NEWS_DOMAINS].some((domain) => host === domain || host.endsWith("." + domain))) return "news";
  return "news";
}
function credibilityFor(kind: EvidenceKind): number {
  return kind === "official" || kind === "research" || kind === "market_data" ? 4.8 : kind === "news" ? 3.8 : 3;
}
function evidenceId(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0,24);
}

export class SearchEvidenceRegistry {
  readonly #tasks = new Map<string, Map<string, StoredEvidence>>();
  add(taskId: string, results: readonly SearchResult[]): void {
    let entries = this.#tasks.get(taskId);
    if (!entries) { entries = new Map(); this.#tasks.set(taskId,entries); }
    const retrievedAt = new Date().toISOString();
    for (const result of results) {
      entries.set(new URL(result.url).toString(), { result, retrievedAt });
      if (entries.size > 100) entries.delete(entries.keys().next().value as string);
    }
  }
  resolve(taskId: string, urls: readonly string[]): EvidenceItem[] {
    const entries = this.#tasks.get(taskId);
    if (!entries) throw new Error("No web evidence has been collected for this task");
    const resolved: EvidenceItem[] = [];
    for (const suppliedUrl of urls) {
      const url = new URL(suppliedUrl).toString();
      const stored = entries.get(url);
      if (!stored) throw new Error("Opportunity scoring only accepts URLs returned by this task's real search calls");
      if (!stored.result.publishedAt) continue;
      const hostname = new URL(url).hostname.toLowerCase();
      const kind = kindFor(hostname);
      resolved.push({
        id: evidenceId(url),
        url,
        title: stored.result.title,
        publisher: hostname,
        claim: stored.result.content,
        kind,
        publishedAt: stored.result.publishedAt,
        retrievedAt: stored.retrievedAt,
        credibility: credibilityFor(kind),
        relevance: Math.max(0,Math.min(5,stored.result.score * 5))
      });
    }
    return resolved;
  }
  clear(taskId: string): void { this.#tasks.delete(taskId); }
}
