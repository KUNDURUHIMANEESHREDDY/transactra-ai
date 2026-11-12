export interface SearchRequest {
  query: string;
  topic?: "general" | "news" | "finance";
  timeRange?: "day" | "week" | "month" | "year";
  maxResults?: number;
  includeDomains?: readonly string[];
  excludeDomains?: readonly string[];
}
export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  publishedAt?: string;
}
export interface SearchResponse {
  provider: "tavily";
  query: string;
  results: SearchResult[];
  creditsReserved: 1;
}

interface SearchQuota { reserve(input: { provider: string; requests: number; credits: number; requestCap: number; creditCap: number }): Promise<boolean>; }
interface TavilyPayload {
  results?: Array<{ title?: string; url?: string; content?: string; score?: number; published_date?: string }>;
}

export class TavilySearchProvider {
  readonly #apiKey: string;
  readonly #quota: SearchQuota;
  readonly #requestCap: number;
  readonly #creditCap: number;

  constructor(input: {
    apiKey: string;
    quota: SearchQuota;
    requestCap?: number;
    creditCap?: number;
    paygDisabledConfirmed: boolean;
  }) {
    if (!input.apiKey.trim()) throw new Error("TAVILY_API_KEY is required");
    if (!input.paygDisabledConfirmed) throw new Error("Tavily PAYG must be confirmed disabled before Transactra search is enabled");
    this.#apiKey = input.apiKey;
    this.#quota = input.quota;
    this.#requestCap = input.requestCap ?? 800;
    this.#creditCap = input.creditCap ?? 800;
    if (!Number.isInteger(this.#requestCap) || this.#requestCap < 1 || this.#requestCap > 900) throw new Error("Tavily request cap must be between 1 and 900");
    if (!Number.isInteger(this.#creditCap) || this.#creditCap < 1 || this.#creditCap > 900) throw new Error("Tavily credit cap must be between 1 and 900");
  }

  async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
    if (!request.query.trim() || request.query.length > 1000) throw new Error("Search query must be between 1 and 1000 characters");
    const maxResults = request.maxResults ?? 8;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10) throw new Error("maxResults must be between 1 and 10");
    if (request.topic !== undefined && !["general","news","finance"].includes(request.topic)) throw new Error("Invalid Tavily topic");
    if (request.timeRange !== undefined && !["day","week","month","year"].includes(request.timeRange)) throw new Error("Invalid Tavily time range");
    if (request.topic === "news" && !request.timeRange) throw new Error("News searches require an explicit time range");
    for (const domains of [request.includeDomains ?? [],request.excludeDomains ?? []]) {
      if (domains.length > 20 || domains.some((domain) => !/^[a-z0-9.-]+$/i.test(domain) || domain.includes(".."))) throw new Error("Invalid domain filter");
    }
    const reserved = await this.#quota.reserve({
      provider: "tavily", requests: 1, credits: 1,
      requestCap: this.#requestCap, creditCap: this.#creditCap
    });
    if (!reserved) throw new Error("Tavily free-tier monthly hard stop reached; no request was sent");
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        authorization: "Bearer " + this.#apiKey,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        query: request.query,
        search_depth: "basic",
        topic: request.topic ?? "general",
        max_results: maxResults,
        include_answer: false,
        include_raw_content: false,
        ...(request.timeRange ? { time_range: request.timeRange } : {}),
        ...(request.includeDomains ? { include_domains: request.includeDomains } : {}),
        ...(request.excludeDomains ? { exclude_domains: request.excludeDomains } : {})
      }),
      signal: signal ?? AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error("Tavily search failed with HTTP " + response.status + "; reserved credit is retained conservatively");
    const payload = await response.json() as TavilyPayload;
    const results = (payload.results ?? []).flatMap((item) => {
      if (typeof item.title !== "string" || typeof item.url !== "string" || typeof item.content !== "string" || typeof item.score !== "number") return [];
      try {
        const url = new URL(item.url);
        if (url.protocol !== "https:" && url.protocol !== "http:") return [];
      } catch { return []; }
      return [{
        title: item.title.slice(0,500), url: item.url, content: item.content.slice(0,12000),
        score: Math.max(0,Math.min(1,item.score)),
        ...(typeof item.published_date === "string" ? { publishedAt: item.published_date } : {})
      }];
    });
    return { provider: "tavily", query: request.query, results, creditsReserved: 1 };
  }
}
