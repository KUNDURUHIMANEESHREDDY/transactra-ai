import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { assertNoLikelySecrets } from "../../security/src/secrets.js";
import {
  cosineSimilarity, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, embedText, extractEntities
} from "./embeddings.js";

export interface MemoryInput {
  ownerId: string; projectId?: string; content: string;
  sourceType: string; sourceRef?: string;
  sensitivity?: "public" | "internal" | "confidential";
  retentionUntil?: Date;
}
export interface MemoryRecord {
  id: string; project_id: string | null; content: string;
  source_type: string; source_ref: string | null; sensitivity: string;
  created_at: Date;
}
export interface MemorySearchResult extends MemoryRecord {
  score: number;
  matched_by: "full_text" | "vector" | "hybrid";
}
export interface MemoryGraphNode extends MemoryRecord { distance: number; }
export interface MemoryGraphEdge {
  from_memory_id: string; to_memory_id: string; relation: string; weight: number;
}

interface FtsRow extends MemoryRecord { rank: number; }
interface VectorRow extends MemoryRecord { vector: number[]; }

export class MemoryStore {
  readonly #pool: Pool;
  constructor(connectionString: string) {
    if (!connectionString.trim()) throw new Error("DATABASE_URL is required");
    this.#pool = new Pool({ connectionString, max: 3, application_name: "transactra-memory" });
  }
  async close(): Promise<void> { await this.#pool.end(); }

  async add(input: MemoryInput): Promise<MemoryRecord> {
    if (!input.content.trim()) throw new Error("Memory content cannot be empty");
    if (!input.sourceType.trim()) throw new Error("Memory sourceType is required");
    if (input.content.length > 100000) throw new Error("Memory content is limited to 100000 characters");
    assertNoLikelySecrets(input.content, "Memory content");
    const hash = createHash("sha256").update(input.content).digest("hex");
    const vector = embedText(input.content);
    const entities = extractEntities(input.content);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<MemoryRecord>(
        `INSERT INTO memory_items(owner_id,project_id,content,content_hash,source_type,source_ref,sensitivity,retention_until)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT(owner_id,content_hash) DO UPDATE SET content=EXCLUDED.content
         RETURNING id,project_id,content,source_type,source_ref,sensitivity,created_at`,
        [input.ownerId,input.projectId ?? null,input.content,hash,input.sourceType,input.sourceRef ?? null,input.sensitivity ?? "internal",input.retentionUntil ?? null]
      );
      const item = result.rows[0];
      if (!item) throw new Error("Memory item was not persisted");
      await this.#writeEmbedding(client,item.id,vector);
      await this.#writeEntities(client,input.ownerId,item.id,entities);
      await this.#linkSimilar(client,input.ownerId,item.id,vector);
      await client.query("COMMIT");
      return item;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async #writeEmbedding(client: PoolClient, memoryId: string, vector: number[]): Promise<void> {
    if (vector.length !== EMBEDDING_DIMENSIONS) throw new Error("Embedding vector has an unexpected dimension");
    await client.query(
      `INSERT INTO memory_embeddings(memory_item_id,model,dimensions,vector) VALUES($1,$2,$3,$4::double precision[])
       ON CONFLICT(memory_item_id) DO UPDATE SET model=EXCLUDED.model,dimensions=EXCLUDED.dimensions,vector=EXCLUDED.vector,created_at=now()`,
      [memoryId,EMBEDDING_MODEL,EMBEDDING_DIMENSIONS,vector]
    );
  }

  async #writeEntities(client: PoolClient, ownerId: string, memoryId: string, entities: ReturnType<typeof extractEntities>): Promise<void> {
    for (const entity of entities) {
      const stored = await client.query<{ id: string }>(
        `INSERT INTO memory_entities(owner_id,normalized_name,display_name,entity_kind) VALUES($1,$2,$3,$4)
         ON CONFLICT(owner_id,normalized_name,entity_kind) DO UPDATE SET display_name=EXCLUDED.display_name
         RETURNING id`,
        [ownerId,entity.normalizedName,entity.name,entity.kind]
      );
      const id = stored.rows[0]?.id;
      if (!id) continue;
      await client.query(
        "INSERT INTO memory_entity_mentions(memory_item_id,entity_id,salience) VALUES($1,$2,1) ON CONFLICT(memory_item_id,entity_id) DO NOTHING",
        [memoryId,id]
      );
    }
  }

  async #linkSimilar(client: PoolClient, ownerId: string, memoryId: string, vector: number[]): Promise<void> {
    const candidates = await client.query<{ id: string; vector: number[] }>(
      `SELECT m.id,e.vector FROM memory_items m JOIN memory_embeddings e ON e.memory_item_id=m.id
       WHERE m.owner_id=$1 AND m.id<>$2 AND (m.retention_until IS NULL OR m.retention_until>now())
       ORDER BY m.created_at DESC LIMIT 200`,
      [ownerId,memoryId]
    );
    const ranked = candidates.rows
      .map((row) => ({ id: row.id, similarity: cosineSimilarity(vector,row.vector) }))
      .filter((row) => row.similarity >= 0.35)
      .sort((left,right) => right.similarity - left.similarity)
      .slice(0,3);
    for (const row of ranked) {
      const weight = Math.round(row.similarity * 1000) / 1000;
      await client.query(
        `INSERT INTO memory_links(owner_id,from_memory_id,to_memory_id,relation,weight) VALUES($1,$2,$3,'semantic', $4)
         ON CONFLICT(from_memory_id,to_memory_id,relation) DO UPDATE SET weight=EXCLUDED.weight`,
        [ownerId,memoryId,row.id,weight]
      );
    }
  }

  async search(ownerId: string, query: string, limit = 10, projectId?: string): Promise<MemorySearchResult[]> {
    if (!query.trim()) return [];
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Memory search limit must be between 1 and 50");
    const projectFilter = projectId ?? null;
    const [fts, vectors] = await Promise.all([
      this.#pool.query<FtsRow>(
        `SELECT id,project_id,content,source_type,source_ref,sensitivity,created_at,
                ts_rank(to_tsvector('simple',content),websearch_to_tsquery('simple',$2)) AS rank
         FROM memory_items
         WHERE owner_id=$1 AND (retention_until IS NULL OR retention_until>now()) AND ($3::text IS NULL OR project_id=$3)
           AND to_tsvector('simple',content) @@ websearch_to_tsquery('simple',$2)
         ORDER BY rank DESC, created_at DESC LIMIT 100`,
        [ownerId,query,projectFilter]
      ),
      this.#pool.query<VectorRow>(
        `SELECT m.id,m.project_id,m.content,m.source_type,m.source_ref,m.sensitivity,m.created_at,e.vector
         FROM memory_items m JOIN memory_embeddings e ON e.memory_item_id=m.id
         WHERE m.owner_id=$1 AND (m.retention_until IS NULL OR m.retention_until>now()) AND ($2::text IS NULL OR m.project_id=$2)
         ORDER BY m.created_at DESC LIMIT 500`,
        [ownerId,projectFilter]
      )
    ]);
    const queryVector = embedText(query);
    const maxRank = Math.max(...fts.rows.map((row) => row.rank),0);
    const merged = new Map<string, { record: MemoryRecord; fts: number; vector: number }>();
    for (const row of fts.rows) {
      const normalised = maxRank > 0 ? row.rank / maxRank : 0;
      merged.set(row.id,{ record: row, fts: normalised, vector: 0 });
    }
    for (const row of vectors.rows) {
      const similarity = Math.max(0,cosineSimilarity(queryVector,row.vector));
      if (similarity < 0.05) continue;
      const existing = merged.get(row.id);
      if (existing) existing.vector = similarity;
      else merged.set(row.id,{ record: row, fts: 0, vector: similarity });
    }
    const results: MemorySearchResult[] = [...merged.values()].map((entry) => {
      const score = Math.round((entry.fts * 0.4 + entry.vector * 0.6) * 1000) / 1000;
      const matched_by: MemorySearchResult["matched_by"] = entry.fts > 0 && entry.vector > 0 ? "hybrid" : entry.fts > 0 ? "full_text" : "vector";
      return {
        id: entry.record.id, project_id: entry.record.project_id, content: entry.record.content,
        source_type: entry.record.source_type, source_ref: entry.record.source_ref,
        sensitivity: entry.record.sensitivity, created_at: entry.record.created_at,
        score, matched_by
      };
    });
    results.sort((left,right) => right.score - left.score || right.created_at.getTime() - left.created_at.getTime());
    return results.slice(0,limit);
  }

  async graph(ownerId: string, memoryId: string, depth = 1): Promise<{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] }> {
    if (!Number.isInteger(depth) || depth < 1 || depth > 2) throw new Error("Memory graph depth must be 1 or 2");
    const root = await this.#pool.query<MemoryRecord>(
      "SELECT id,project_id,content,source_type,source_ref,sensitivity,created_at FROM memory_items WHERE owner_id=$1 AND id=$2",
      [ownerId,memoryId]
    );
    if (!root.rows[0]) throw new Error("Memory item not found");
    const nodes = new Map<string, MemoryGraphNode>([[memoryId,{ ...root.rows[0], distance: 0 }]]);
    const edges = new Map<string, MemoryGraphEdge>();
    let frontier = [memoryId];
    for (let level = 1; level <= depth; level += 1) {
      const links = await this.#pool.query<MemoryGraphEdge & { neighbour: string }>(
        `SELECT from_memory_id,to_memory_id,relation,weight,
                CASE WHEN from_memory_id = ANY($2::uuid[]) THEN to_memory_id ELSE from_memory_id END AS neighbour
         FROM memory_links
         WHERE owner_id=$1 AND (from_memory_id = ANY($2::uuid[]) OR to_memory_id = ANY($2::uuid[]))`,
        [ownerId,frontier]
      );
      const next: string[] = [];
      for (const link of links.rows) {
        edges.set(link.from_memory_id + ":" + link.to_memory_id + ":" + link.relation,{
          from_memory_id: link.from_memory_id, to_memory_id: link.to_memory_id,
          relation: link.relation, weight: link.weight
        });
        if (!nodes.has(link.neighbour)) next.push(link.neighbour);
      }
      if (next.length > 0) {
        const records = await this.#pool.query<MemoryRecord>(
          "SELECT id,project_id,content,source_type,source_ref,sensitivity,created_at FROM memory_items WHERE owner_id=$1 AND id = ANY($2::uuid[])",
          [ownerId,next]
        );
        for (const record of records.rows) nodes.set(record.id,{ ...record, distance: level });
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    return { nodes: [...nodes.values()], edges: [...edges.values()] };
  }

  async entities(ownerId: string, limit = 50): Promise<Array<{ id: string; display_name: string; entity_kind: string; mentions: number }>> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Entity limit must be between 1 and 200");
    const result = await this.#pool.query(
      `SELECT e.id,e.display_name,e.entity_kind,count(m.memory_item_id)::int AS mentions
       FROM memory_entities e LEFT JOIN memory_entity_mentions m ON m.entity_id=e.id
       WHERE e.owner_id=$1 GROUP BY e.id ORDER BY mentions DESC,e.display_name ASC LIMIT $2`,
      [ownerId,limit]
    );
    return result.rows;
  }

  async delete(ownerId: string, memoryId: string): Promise<boolean> {
    const result = await this.#pool.query("DELETE FROM memory_items WHERE owner_id=$1 AND id=$2 RETURNING id", [ownerId,memoryId]);
    return result.rowCount === 1;
  }

  async purgeExpired(): Promise<number> {
    const result = await this.#pool.query("DELETE FROM memory_items WHERE retention_until IS NOT NULL AND retention_until <= now()");
    return result.rowCount ?? 0;
  }
}
