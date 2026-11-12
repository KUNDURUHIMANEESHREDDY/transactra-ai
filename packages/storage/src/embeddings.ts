/**
 * Dependency-free, deterministic local embeddings. This is intentionally a lexical
 * feature-hashing model: it costs nothing, runs offline and never leaks content to a
 * third party. Vectors are L2-normalised so cosine similarity is a single dot product.
 */
export const EMBEDDING_MODEL = "transactra-hash-v1";
export const EMBEDDING_DIMENSIONS = 256;

const STOPWORDS = new Set([
  "the","and","for","with","that","this","from","into","are","was","were","been","being",
  "have","has","had","will","would","can","could","should","may","might","must","not",
  "but","you","your","our","their","his","her","its","they","them","then","than","when",
  "where","which","who","what","how","why","all","any","each","more","most","some","such",
  "only","also","just","about","after","before","over","under","between","through","during",
  "out","off","again","further","once","here","there","other","very","too","same","both"
]);

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/;

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function tokenize(text: string): string[] {
  const normalized = text.toLowerCase().normalize("NFKC");
  const tokens: string[] = [];
  const words = normalized.split(/[^\p{L}\p{N}_+#.-]+/u).filter(Boolean);
  for (const word of words) {
    const cleaned = word.replace(/^[.-]+|[.-]+$/g, "");
    if (cleaned.length < 2 || STOPWORDS.has(cleaned)) continue;
    if (CJK.test(cleaned)) {
      for (const character of cleaned) if (character.trim()) tokens.push(character);
      continue;
    }
    tokens.push(cleaned);
  }
  return tokens;
}

export function embedText(text: string): number[] {
  if (typeof text !== "string" || !text.trim()) return new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const tokens = tokenize(text);
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const bigram = (tokens[index] ?? "") + "_" + (tokens[index + 1] ?? "");
    counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
  }
  for (const [feature, count] of counts) {
    const hash = fnv1a(feature);
    const bucket = hash % EMBEDDING_DIMENSIONS;
    const sign = (hash >>> 16) % 2 === 0 ? 1 : -1;
    vector[bucket] = (vector[bucket] ?? 0) + sign * (1 + Math.log(count));
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm === 0) return vector;
  return vector.map((value) => Math.round((value / norm) * 1e8) / 1e8);
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) throw new Error("Embedding dimensions do not match");
  if (left.length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  const value = dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}

export type EntityKind = "term" | "technology" | "organization" | "person" | "product" | "url";
export interface EntityCandidate { name: string; normalizedName: string; kind: EntityKind; }

const TECHNOLOGIES = new Map<string, string>([
  ["typescript","TypeScript"],["javascript","JavaScript"],["node.js","Node.js"],["nodejs","Node.js"],
  ["react","React"],["next.js","Next.js"],["nextjs","Next.js"],["vue","Vue"],["svelte","Svelte"],
  ["kubernetes","Kubernetes"],["docker","Docker"],["postgresql","PostgreSQL"],["postgres","PostgreSQL"],
  ["mysql","MySQL"],["redis","Redis"],["graphql","GraphQL"],["rest","REST"],["grpc","gRPC"],
  ["python","Python"],["rust","Rust"],["golang","Go"],["java","Java"],["kotlin","Kotlin"],
  ["swift","Swift"],["terraform","Terraform"],["aws","AWS"],["azure","Azure"],["gcp","GCP"],
  ["github","GitHub"],["openai","OpenAI"],["nvidia","NVIDIA"],["tavily","Tavily"],["telegram","Telegram"],
  ["whatsapp","WhatsApp"],["llm","LLM"],["rag","RAG"],["embeddings","embeddings"],["vector","vector search"]
]);
const ORGANISATION_SUFFIXES = /\b(Inc|Ltd|LLC|GmbH|Corp|Corporation|Company|Labs|Foundation|University|Institute)\b/;
const CAPITALISED_PHRASE = /\b[A-Z][A-Za-z0-9.+#-]*(?:\s+[A-Z][A-Za-z0-9.+#-]*){0,3}\b/g;
const URL_PATTERN = /https?:\/\/[^\s<>()"']+/g;
const LEADING_WORDS = new Set(["The","A","An","This","That","These","Those","It","We","You","They","If","When","After","Before","In","On","For","With","And","But","Or","At","From","To","By","As","Is","Are","Was","Were","Be","Been","Being","Our","Your","Their","Its","His","Her"]);

function normalise(value: string): string {
  return value.toLowerCase().normalize("NFKC").replace(/[^a-z0-9\u00c0-\uffff]+/g," ").trim();
}

export function extractEntities(text: string, limit = 16): EntityCandidate[] {
  if (typeof text !== "string" || !text.trim()) return [];
  const found = new Map<string, EntityCandidate>();
  const add = (display: string, kind: EntityKind): void => {
    const normalizedName = normalise(display);
    if (normalizedName.length < 2 || normalizedName.length > 120) return;
    const key = kind + ":" + normalizedName;
    if (!found.has(key)) found.set(key, { name: display.trim().slice(0,120), normalizedName, kind });
  };
  for (const match of text.match(URL_PATTERN) ?? []) {
    try { add(new URL(match).hostname, "url"); } catch { /* ignore malformed URL */ }
  }
  const lower = text.toLowerCase();
  for (const [token, canonical] of TECHNOLOGIES) {
    if (lower.includes(token)) add(canonical, "technology");
  }
  for (const match of text.match(CAPITALISED_PHRASE) ?? []) {
    const words = match.trim().split(/\s+/);
    while (words.length > 0 && LEADING_WORDS.has(words[0] ?? "")) words.shift();
    if (words.length === 0) continue;
    const phrase = words.join(" ");
    if (phrase.length < 3) continue;
    if (ORGANISATION_SUFFIXES.test(phrase)) add(phrase, "organization");
    else add(phrase, "term");
  }
  return [...found.values()].slice(0, Math.max(1, limit));
}
