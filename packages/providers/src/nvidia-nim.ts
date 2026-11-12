import { Buffer } from "node:buffer";
import type { ProviderRequest, ProviderResponse } from "../../contracts/src/index.js";
import type { PostgresProviderQuota } from "../../storage/src/provider-quota.js";

export interface NvidiaNimConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  freeTierVerifiedAt: string;
  timeoutMs?: number;
}
interface ModelListResponse { data?: Array<{ id?: string }> }
interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class NvidiaNimProvider {
  readonly id = "nvidia-nim";
  readonly zeroCostAuthorized = true;
  readonly model: string;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseUrl: URL;
  readonly #timeoutMs: number;
  readonly #quota: PostgresProviderQuota;
  #modelVerified = false;

  constructor(config: NvidiaNimConfig, quota: PostgresProviderQuota) {
    if (!config.apiKey.trim()) throw new Error("NVIDIA_NIM_API_KEY is required");
    if (!config.model.trim()) throw new Error("NVIDIA_NIM_MODEL is required; discover it from /v1/models");
    const verifiedAt = Date.parse(config.freeTierVerifiedAt);
    if (!Number.isFinite(verifiedAt) || Date.now() - verifiedAt > 30 * 24 * 60 * 60 * 1000 || verifiedAt > Date.now() + 5 * 60 * 1000) {
      throw new Error("NVIDIA NIM free-tier terms and quota must be verified within the last 30 days");
    }
    this.#apiKey = config.apiKey;
    this.#model = config.model;
    this.model = config.model;
    this.#baseUrl = new URL(config.baseUrl ?? "https://integrate.api.nvidia.com");
    const localHttp = this.#baseUrl.protocol === "http:" && ["localhost","127.0.0.1","::1"].includes(this.#baseUrl.hostname);
    if (this.#baseUrl.protocol !== "https:" && !localHttp) throw new Error("NVIDIA NIM endpoint must use HTTPS (except loopback self-hosted NIM)");
    if (this.#baseUrl.username || this.#baseUrl.password || this.#baseUrl.search || this.#baseUrl.hash) throw new Error("NVIDIA NIM base URL must not contain credentials, query parameters or fragments");
    this.#timeoutMs = config.timeoutMs ?? 45000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1000 || this.#timeoutMs > 180000) throw new Error("NIM timeout must be between 1000 and 180000 ms");
    this.#quota = quota;
  }

  async verifyModel(): Promise<void> {
    if (this.#modelVerified) return;
    const response = await fetch(new URL("/v1/models", this.#baseUrl), {
      method: "GET",
      headers: { authorization: "Bearer " + this.#apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(this.#timeoutMs)
    });
    if (!response.ok) throw new Error("NVIDIA NIM model discovery failed with HTTP " + response.status);
    const payload = await response.json() as ModelListResponse;
    const available = payload.data?.some((item) => item.id === this.#model) ?? false;
    if (!available) throw new Error("Configured NVIDIA NIM model is not listed as available by this endpoint");
    this.#modelVerified = true;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    if (request.estimatedCostInr !== 0) throw new Error("NVIDIA NIM dispatch blocked: estimated cost must be exactly INR 0");
    if (!request.input.trim() || Buffer.byteLength(request.input, "utf8") > 1_000_000) throw new Error("NIM input must be non-empty and at most 1 MB");
    if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 || request.maxOutputTokens > 32768) {
      throw new Error("maxOutputTokens must be between 1 and 32768");
    }
    await this.verifyModel();
    // Reserve a conservative upper bound before dispatch. Failed requests consume quota too.
    const promptBytes = Buffer.byteLength(request.input, "utf8") + Buffer.byteLength(request.systemPrompt ?? "", "utf8");
    const tokenReservation = promptBytes + request.maxOutputTokens + 1024;
    await this.#quota.reserve(tokenReservation);
    const response = await fetch(new URL("/v1/chat/completions", this.#baseUrl), {
      method: "POST",
      headers: {
        authorization: "Bearer " + this.#apiKey,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        model: this.#model,
        messages: [
          ...(request.systemPrompt ? [{ role: "system", content: request.systemPrompt }] : []),
          { role: "user", content: request.input }
        ],
        max_tokens: request.maxOutputTokens,
        temperature: 0.2,
        stream: false
      }),
      signal: AbortSignal.timeout(this.#timeoutMs)
    });
    if (!response.ok) throw new Error("NVIDIA NIM inference failed with HTTP " + response.status);
    const payload = await response.json() as ChatResponse;
    const output = payload.choices?.[0]?.message?.content;
    if (typeof output !== "string") throw new Error("NVIDIA NIM returned no text completion");
    const usage = payload.usage;
    return {
      output,
      provider: this.id,
      model: this.#model,
      ...(usage ? { usage: { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 } } : {})
    };
  }
}
