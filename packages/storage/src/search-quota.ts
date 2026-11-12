import { Pool } from "pg";

export class PostgresSearchQuota {
  readonly #pool: Pool;
  constructor(connectionString: string) {
    if (!connectionString.trim()) throw new Error("DATABASE_URL is required");
    this.#pool = new Pool({ connectionString, max: 2, application_name: "transactra-search-quota" });
  }
  async close(): Promise<void> { await this.#pool.end(); }

  async reserve(input: { provider: string; requests: number; credits: number; requestCap: number; creditCap: number }): Promise<boolean> {
    for (const [key,value] of Object.entries({ requests: input.requests, credits: input.credits, requestCap: input.requestCap, creditCap: input.creditCap })) {
      if (!Number.isInteger(value) || value < 0) throw new Error(key + " must be a non-negative integer");
    }
    if (input.requests < 1 || input.credits < 1 || input.requestCap < input.requests || input.creditCap < input.credits) return false;
    const result = await this.#pool.query(
      "INSERT INTO search_usage_monthly(provider,month_start,requests_used,credits_used) VALUES($1,date_trunc('month',now() AT TIME ZONE 'UTC')::date,$2,$3) ON CONFLICT(provider,month_start) DO UPDATE SET requests_used=search_usage_monthly.requests_used+EXCLUDED.requests_used,credits_used=search_usage_monthly.credits_used+EXCLUDED.credits_used,updated_at=now() WHERE search_usage_monthly.requests_used+EXCLUDED.requests_used<=$4 AND search_usage_monthly.credits_used+EXCLUDED.credits_used<=$5 RETURNING requests_used,credits_used",
      [input.provider,input.requests,input.credits,input.requestCap,input.creditCap]
    );
    return result.rowCount === 1;
  }
}
