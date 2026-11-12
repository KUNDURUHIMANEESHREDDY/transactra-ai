import type { ProviderRequest, ProviderResponse } from "../../contracts/src/index.js";

export interface ZeroCostProvider {
  readonly id: string;
  readonly zeroCostAuthorized: boolean;
  readonly model?: string;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}
export interface ProviderCircuitSnapshot {
  provider: string;
  state: "closed" | "open" | "half_open";
  consecutiveFailures: number;
  retryAt: number | null;
}
export interface ProviderHealthEvent {
  provider: string;
  model: string;
  status: "healthy" | "degraded" | "unavailable";
  latencyMs: number;
  failureReason?: string;
}
export interface ProviderRouterOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
  onHealth?: (event: ProviderHealthEvent) => Promise<void>;
}
interface CircuitState {
  consecutiveFailures: number;
  openUntil: number | null;
  halfOpenInFlight: boolean;
  epoch: number;
}

/** Sequential failover across explicitly authorized no-cost providers only. */
export class ProviderRouter {
  readonly #providers: readonly ZeroCostProvider[];
  readonly #states = new Map<string,CircuitState>();
  readonly #failureThreshold: number;
  readonly #cooldownMs: number;
  readonly #now: () => number;
  readonly #onHealth: ((event: ProviderHealthEvent) => Promise<void>) | undefined;

  constructor(providers: readonly ZeroCostProvider[],options: ProviderRouterOptions = {}) {
    this.#providers = [...providers];
    if (new Set(this.#providers.map((provider) => provider.id)).size !== this.#providers.length) throw new Error("Provider IDs must be unique");
    if (this.#providers.some((provider) => !provider.id.trim())) throw new Error("Provider IDs cannot be empty");
    this.#failureThreshold = options.failureThreshold ?? 3;
    this.#cooldownMs = options.cooldownMs ?? 30000;
    this.#now = options.now ?? Date.now;
    this.#onHealth = options.onHealth;
    if (!Number.isInteger(this.#failureThreshold) || this.#failureThreshold < 1 || this.#failureThreshold > 20) throw new Error("failureThreshold must be between 1 and 20");
    if (!Number.isInteger(this.#cooldownMs) || this.#cooldownMs < 1000 || this.#cooldownMs > 15 * 60 * 1000) throw new Error("cooldownMs must be between 1000 ms and 15 minutes");
    for (const provider of this.#providers) {
      this.#states.set(provider.id,{ consecutiveFailures:0,openUntil:null,halfOpenInFlight:false,epoch:0 });
    }
  }

  getCircuitStates(): ProviderCircuitSnapshot[] {
    const now = this.#now();
    return this.#providers.map((provider) => {
      const state = this.#states.get(provider.id);
      if (!state) throw new Error("Provider circuit state is missing");
      const circuit = state.openUntil === null ? "closed" : state.openUntil > now ? "open" : "half_open";
      return {
        provider: provider.id,
        state: circuit,
        consecutiveFailures: state.consecutiveFailures,
        retryAt: state.openUntil
      };
    });
  }

  async #recordHealth(event: ProviderHealthEvent): Promise<void> {
    try { await this.#onHealth?.(event); }
    catch { process.stderr.write(JSON.stringify({ event: "provider_health_persist_failed", provider: event.provider }) + "\n"); }
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    if (request.estimatedCostInr !== 0) throw new Error("Provider router blocks all positive-cost requests under the INR 0 ceiling");
    const eligible = this.#providers.filter((provider) => provider.zeroCostAuthorized);
    if (eligible.length === 0) throw new Error("No verified no-cost provider is configured; task must pause without paid fallback");
    const failures: string[] = [];
    for (const provider of eligible) {
      const state = this.#states.get(provider.id);
      if (!state) throw new Error("Provider circuit state is missing: " + provider.id);
      const now = this.#now();
      let halfOpenProbe = false;
      if (state.openUntil !== null) {
        if (state.openUntil > now) {
          failures.push(provider.id + ": circuit open until " + new Date(state.openUntil).toISOString());
          continue;
        }
        if (state.halfOpenInFlight) {
          failures.push(provider.id + ": half-open probe already in progress");
          continue;
        }
        state.halfOpenInFlight = true;
        halfOpenProbe = true;
      }
      const attemptEpoch = state.epoch;
      const attemptStartedAt = this.#now();
      try {
        const response = await provider.complete(request);
        if (state.epoch === attemptEpoch) {
          state.consecutiveFailures = 0;
          state.openUntil = null;
          state.halfOpenInFlight = false;
        }
        await this.#recordHealth({ provider:provider.id,model:response.model,status:"healthy",latencyMs:Math.max(0,Math.round(this.#now()-attemptStartedAt)) });
        return response;
      } catch (error) {
        if (state.epoch === attemptEpoch) {
          state.consecutiveFailures += 1;
          state.halfOpenInFlight = false;
          if (state.consecutiveFailures >= this.#failureThreshold || halfOpenProbe) {
            state.openUntil = this.#now() + this.#cooldownMs;
            state.epoch += 1;
          }
        }
        await this.#recordHealth({ provider:provider.id,model:provider.model ?? request.model ?? "provider-default",status:state.openUntil !== null && state.openUntil > this.#now() ? "unavailable" : "degraded",latencyMs:Math.max(0,Math.round(this.#now()-attemptStartedAt)),failureReason:"provider_request_failed" });
        failures.push(provider.id + ": " + (error instanceof Error ? error.message : String(error)));
      }
    }
    throw new AggregateError(failures.map((message) => new Error(message)),"All configured no-cost providers failed or are circuit-open; no paid fallback was attempted");
  }
}
