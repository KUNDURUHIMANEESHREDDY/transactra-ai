import { PostgresSearchQuota } from "../../../packages/storage/src/search-quota.js";
import { TavilySearchProvider } from "../../../packages/research/src/tavily-search.js";
import { SearchEvidenceRegistry } from "../../../packages/research/src/evidence-registry.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(name + " is required for intelligence runtime");
  return value.trim();
}
function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 900) throw new Error(name + " must be between 1 and 900");
  return value;
}

/** Creates the real Tavily provider and evidence registry; registration happens on the shared gateway. */
export function createResearchRuntime(): {
  provider: TavilySearchProvider;
  evidence: SearchEvidenceRegistry;
  quota: PostgresSearchQuota;
  close: () => Promise<void>;
} {
  const databaseUrl = required("DATABASE_URL");
  const quota = new PostgresSearchQuota(databaseUrl);
  try {
    const provider = new TavilySearchProvider({
      apiKey: required("TAVILY_API_KEY"),
      quota,
      requestCap: positiveInteger("TAVILY_MONTHLY_REQUEST_CAP",800),
      creditCap: positiveInteger("TAVILY_MONTHLY_CREDIT_CAP",800),
      paygDisabledConfirmed: process.env.TAVILY_PAYG_DISABLED_CONFIRMED === "true"
    });
    return {
      provider,
      evidence: new SearchEvidenceRegistry(),
      quota,
      close: async () => { await quota.close(); }
    };
  } catch (error) {
    void quota.close();
    throw error;
  }
}
