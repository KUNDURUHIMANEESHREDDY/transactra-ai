import { Pool } from "pg";

export type ProviderHealthStatus = "healthy" | "degraded" | "unavailable" | "unconfigured";
export interface ProviderHealthEvent {
  provider: string;
  model: string;
  status: ProviderHealthStatus;
  latencyMs?: number;
  failureReason?: string;
}

export class PostgresProviderHealthStore {
  readonly #pool: Pool;
  constructor(connectionString: string) {
    if (!connectionString.trim()) throw new Error("DATABASE_URL is required");
    this.#pool = new Pool({ connectionString,max:2,application_name:"transactra-provider-health",connectionTimeoutMillis:5000,query_timeout:5000 });
  }
  async close(): Promise<void> { await this.#pool.end(); }

  async record(event: ProviderHealthEvent): Promise<void> {
    if (!event.provider.trim() || event.provider.length > 100) throw new Error("Provider health event requires a valid provider ID");
    if (!event.model.trim() || event.model.length > 200) throw new Error("Provider health event requires a valid model ID");
    if (!["healthy","degraded","unavailable","unconfigured"].includes(event.status)) throw new Error("Invalid provider health status");
    const latency = event.latencyMs ?? null;
    if (latency !== null && (!Number.isInteger(latency) || latency < 0 || latency > 600000)) throw new Error("Provider latency must be between 0 and 600000 ms");
    const reason = event.failureReason?.trim().slice(0,300) ?? null;
    await this.#pool.query(
      "INSERT INTO provider_health(provider,model,status,latency_ms,failure_reason) VALUES($1,$2,$3,$4,$5)",
      [event.provider,event.model,event.status,latency,reason]
    );
  }
}
