import { createHash } from "node:crypto";
import { Pool } from "pg";
import { assertNoLikelySecrets } from "../../security/src/secrets.js";
import type { SearchResponse, SearchResult } from "../../research/src/tavily-search.js";
import type { EvidenceItem, OpportunityCandidate, OpportunityScore } from "../../intelligence/src/opportunity-scoring.js";

export interface ResearchSourceRecord {
  id: string; owner_id: string; task_id: string | null; url: string;
  title: string; publisher: string; kind: string; published_at: Date | null;
  retrieved_at: Date; content_hash: string; metadata: unknown; created_at: Date;
}
export interface IntelligenceReportRecord {
  id: string; owner_id: string; task_id: string | null; summary: string;
  findings: unknown; recommendations: unknown; sources: unknown; scores: unknown;
  created_at: Date;
}
export interface OpportunityRecord {
  id: string; owner_id: string; task_id: string | null; candidate: unknown;
  score: unknown; eligible: boolean; created_at: Date;
}

export interface IntelligenceReportInput {
  ownerId: string; taskId?: string; summary: string;
  findings: unknown; recommendations: unknown;
  sources: readonly string[]; scores: unknown;
}

/** Direct persistence for the research and innovation executors. */
export interface ResearchPersistence {
  recordSearch(input: { ownerId: string; taskId: string; response: SearchResponse }): Promise<void>;
  recordEvidence(input: { ownerId: string; taskId: string; items: readonly EvidenceItem[] }): Promise<void>;
  recordOpportunity(input: { ownerId: string; taskId: string; candidate: OpportunityCandidate; score: OpportunityScore }): Promise<void>;
}

function publisherOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./,""); }
  catch { throw new Error("Research source URL is invalid"); }
}
function publishedAtOf(result: SearchResult): Date | null {
  if (!result.publishedAt) return null;
  const time = Date.parse(result.publishedAt);
  return Number.isFinite(time) ? new Date(time) : null;
}
function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export class IntelligenceStore implements ResearchPersistence {
  readonly #pool: Pool;
  constructor(connectionString: string) {
    if (!connectionString.trim()) throw new Error("DATABASE_URL is required");
    this.#pool = new Pool({ connectionString, max: 4, application_name: "transactra-intelligence" });
  }
  async close(): Promise<void> { await this.#pool.end(); }

  async recordSearch(input: { ownerId: string; taskId: string; response: SearchResponse }): Promise<void> {
    if (input.response.results.length === 0) return;
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      for (const result of input.response.results) {
        const url = new URL(result.url).toString();
        assertNoLikelySecrets(result.title + "\n" + result.content.slice(0,4000), "Research source");
        await client.query(
          `INSERT INTO research_sources(owner_id,task_id,url,title,publisher,kind,published_at,retrieved_at,content_hash,metadata)
           VALUES($1,$2,$3,$4,$5,'web',$6,now(),$7,$8)
           ON CONFLICT(owner_id,task_id,url) DO UPDATE SET
             title=EXCLUDED.title,publisher=EXCLUDED.publisher,published_at=EXCLUDED.published_at,
             retrieved_at=EXCLUDED.retrieved_at,content_hash=EXCLUDED.content_hash,metadata=EXCLUDED.metadata`,
          [
            input.ownerId, input.taskId, url, result.title.slice(0,500), publisherOf(url),
            publishedAtOf(result), hashContent(result.content),
            JSON.stringify({ query: input.response.query, score: result.score })
          ]
        );
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async recordEvidence(input: { ownerId: string; taskId: string; items: readonly EvidenceItem[] }): Promise<void> {
    if (input.items.length === 0) return;
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      for (const item of input.items) {
        const url = new URL(item.url).toString();
        const source = await client.query<{ id: string }>(
          "SELECT id FROM research_sources WHERE owner_id=$1 AND task_id=$2 AND url=$3 LIMIT 1",
          [input.ownerId,input.taskId,url]
        );
        const sourceId = source.rows[0]?.id;
        if (!sourceId) throw new Error("Evidence item has no persisted research source: " + url);
        await client.query(
          `INSERT INTO evidence_items(id,source_id,owner_id,task_id,claim,kind,credibility,relevance)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT(id) DO UPDATE SET claim=EXCLUDED.claim,kind=EXCLUDED.kind,
             credibility=EXCLUDED.credibility,relevance=EXCLUDED.relevance`,
          [item.id,sourceId,input.ownerId,input.taskId,item.claim.slice(0,12000),item.kind,item.credibility,item.relevance]
        );
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async recordOpportunity(input: { ownerId: string; taskId: string; candidate: OpportunityCandidate; score: OpportunityScore }): Promise<void> {
    assertNoLikelySecrets(JSON.stringify(input.candidate) ?? "null", "Opportunity candidate");
    await this.#pool.query(
      "INSERT INTO opportunities(owner_id,task_id,candidate,score,eligible) VALUES($1,$2,$3,$4,$5)",
      [input.ownerId,input.taskId,JSON.stringify(input.candidate),JSON.stringify(input.score),input.score.eligible]
    );
  }

  async saveReport(input: IntelligenceReportInput): Promise<IntelligenceReportRecord> {
    const summary = input.summary.trim();
    if (!summary || summary.length > 10000) throw new Error("Intelligence report summary must be between 1 and 10000 characters");
    if (!Array.isArray(input.findings) || input.findings.length === 0) throw new Error("Intelligence report requires at least one finding");
    if (!Array.isArray(input.recommendations) || input.recommendations.length === 0) throw new Error("Intelligence report requires at least one recommendation");
    const uniqueSources = [...new Set(input.sources.map((url) => new URL(url).toString()))];
    if (uniqueSources.length < 3) throw new Error("Intelligence report requires at least three real sources");
    const scores = Array.isArray(input.scores) ? input.scores : [input.scores];
    if (scores.length === 0) throw new Error("Intelligence report requires at least one tool-generated opportunity score");
    assertNoLikelySecrets(summary + "\n" + JSON.stringify(input.findings) + "\n" + JSON.stringify(input.recommendations), "Intelligence report");
    const taskId = input.taskId ?? null;
    for (const url of uniqueSources) {
      const result = taskId
        ? await this.#pool.query("SELECT 1 FROM research_sources WHERE owner_id=$1 AND task_id=$2 AND url=$3",[input.ownerId,taskId,url])
        : await this.#pool.query("SELECT 1 FROM research_sources WHERE owner_id=$1 AND task_id IS NULL AND url=$2",[input.ownerId,url]);
      if (result.rowCount !== 1) throw new Error("Intelligence report cited a source that was not persisted for this task: " + url);
    }
    const result = await this.#pool.query<IntelligenceReportRecord>(
      `INSERT INTO intelligence_reports(owner_id,task_id,summary,findings,recommendations,sources,scores)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(task_id) DO UPDATE SET summary=EXCLUDED.summary,findings=EXCLUDED.findings,
         recommendations=EXCLUDED.recommendations,sources=EXCLUDED.sources,scores=EXCLUDED.scores
       RETURNING *`,
      [input.ownerId,taskId,summary,JSON.stringify(input.findings),JSON.stringify(input.recommendations),JSON.stringify(uniqueSources),JSON.stringify(scores)]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Intelligence report was not persisted");
    return row;
  }

  async listReports(ownerId: string, limit = 20): Promise<IntelligenceReportRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Report limit must be between 1 and 100");
    const result = await this.#pool.query<IntelligenceReportRecord>(
      "SELECT * FROM intelligence_reports WHERE owner_id=$1 ORDER BY created_at DESC LIMIT $2",[ownerId,limit]
    );
    return result.rows;
  }

  async getReport(ownerId: string, reportId: string): Promise<IntelligenceReportRecord | null> {
    const result = await this.#pool.query<IntelligenceReportRecord>(
      "SELECT * FROM intelligence_reports WHERE owner_id=$1 AND id=$2",[ownerId,reportId]
    );
    return result.rows[0] ?? null;
  }

  async listOpportunities(ownerId: string, limit = 50, eligibleOnly = false): Promise<OpportunityRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Opportunity limit must be between 1 and 100");
    const result = eligibleOnly
      ? await this.#pool.query<OpportunityRecord>("SELECT * FROM opportunities WHERE owner_id=$1 AND eligible=true ORDER BY created_at DESC LIMIT $2",[ownerId,limit])
      : await this.#pool.query<OpportunityRecord>("SELECT * FROM opportunities WHERE owner_id=$1 ORDER BY created_at DESC LIMIT $2",[ownerId,limit]);
    return result.rows;
  }

  async sourceCount(ownerId: string, taskId?: string): Promise<number> {
    const result = taskId
      ? await this.#pool.query<{ count: string }>("SELECT count(*)::text AS count FROM research_sources WHERE owner_id=$1 AND task_id=$2",[ownerId,taskId])
      : await this.#pool.query<{ count: string }>("SELECT count(*)::text AS count FROM research_sources WHERE owner_id=$1",[ownerId]);
    return Number(result.rows[0]?.count ?? "0");
  }
}
