import { Pool } from "pg";

export interface MonthlyQuotaLimits { requests: number; tokens: number; }
export class PostgresProviderQuota {
  readonly #pool: Pool;
  readonly #limits: MonthlyQuotaLimits;
  readonly #provider: string;
  constructor(connectionString: string, limits: MonthlyQuotaLimits, provider = "nvidia-nim") {
    if (!connectionString.trim()) throw new Error("DATABASE_URL is required");
    if (!Number.isSafeInteger(limits.requests) || limits.requests < 1) throw new Error("Monthly free request quota must be a positive integer");
    if (!Number.isSafeInteger(limits.tokens) || limits.tokens < 1) throw new Error("Monthly free token quota must be a positive integer");
    this.#pool = new Pool({ connectionString, max: 2, application_name: "transactra-provider-quota" });
    this.#limits = limits;
    this.#provider = provider;
  }
  async close(): Promise<void> { await this.#pool.end(); }
  async reserve(tokens: number): Promise<void> {
    if (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > this.#limits.tokens) throw new Error("Provider request exceeds the configured free token budget");
    const result = await this.#pool.query(
      "INSERT INTO provider_usage_monthly(provider,month_key,requests_used,tokens_reserved) VALUES($1,date_trunc('month',now() AT TIME ZONE 'UTC')::date,1,$4) ON CONFLICT(provider,month_key) DO UPDATE SET requests_used=provider_usage_monthly.requests_used+1,tokens_reserved=provider_usage_monthly.tokens_reserved+EXCLUDED.tokens_reserved,updated_at=now() WHERE provider_usage_monthly.requests_used < $2 AND provider_usage_monthly.tokens_reserved+EXCLUDED.tokens_reserved <= $3 RETURNING requests_used,tokens_reserved",
      [this.#provider,this.#limits.requests,this.#limits.tokens,tokens]
    );
    if (result.rowCount !== 1) throw new Error("Configured no-cost provider quota exhausted; request blocked before inference");
  }
}
