import { Buffer } from "node:buffer";
import type { ProviderRequest, ProviderResponse } from "../../contracts/src/index.js";

export interface ProviderQuotaReservation { reserve(tokens: number): Promise<void>; }
export interface OpenAICompatibleConfig {
  id: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  freeTierVerifiedAt: string;
  timeoutMs?: number;
}
interface ModelListResponse { data?: Array<{ id?: string }> }
interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAICompatibleProvider {
  readonly id: string;
  readonly zeroCostAuthorized = true;
  readonly model: string;
  readonly #apiKey: string;
  readonly #baseUrl: URL;
  readonly #timeoutMs: number;
  readonly #quota: ProviderQuotaReservation;
  #modelVerified = false;

  constructor(config: OpenAICompatibleConfig,quota: ProviderQuotaReservation) {
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(config.id) || config.id === "nvidia-nim") throw new Error("Secondary provider ID must be a unique lowercase slug");
    const apiKey = config.apiKey.trim();
    const model = config.model.trim();
    if (!apiKey) throw new Error("Secondary provider API key is required");
    if (!model || model.length > 200) throw new Error("Secondary provider model ID is required");
    const verifiedAt = Date.parse(config.freeTierVerifiedAt.trim());
    if (!Number.isFinite(verifiedAt) || Date.now()-verifiedAt > 30*24*60*60*1000 || verifiedAt > Date.now()+5*60*1000) {
      throw new Error("Secondary provider free-tier terms and quota must be verified within the last 30 days");
    }
    const baseUrl = new URL(config.baseUrl.trim());
    const localHttp = baseUrl.protocol === "http:" && ["localhost","127.0.0.1","::1"].includes(baseUrl.hostname);
    if (baseUrl.protocol !== "https:" && !localHttp) throw new Error("Secondary provider endpoint must use HTTPS (except loopback self-hosted endpoints)");
    if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || !baseUrl.pathname.replace(/\/+$/,"").endsWith("/v1")) {
      throw new Error("Secondary provider base URL must end in /v1 and contain no credentials, query parameters or fragments");
    }
    baseUrl.pathname = baseUrl.pathname.replace(/\/+$/,"") + "/";
    this.id = config.id;
    this.model = model;
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl;
    this.#timeoutMs = config.timeoutMs ?? 45000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1000 || this.#timeoutMs > 180000) throw new Error("Secondary provider timeout must be between 1000 and 180000 ms");
    this.#quota = quota;
  }

  async verifyModel(): Promise<void> {
    if (this.#modelVerified) return;
    const response = await fetch(new URL("models",this.#baseUrl),{
      method:"GET",
      headers:{ authorization:"Bearer "+this.#apiKey,accept:"application/json" },
      signal:AbortSignal.timeout(this.#timeoutMs)
    });
    if (!response.ok) throw new Error("Secondary provider model discovery failed with HTTP "+response.status);
    const payload = await response.json() as ModelListResponse;
    if (!(payload.data?.some((item) => item.id === this.model) ?? false)) throw new Error("Configured secondary model is not listed by its endpoint");
    this.#modelVerified = true;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    if (request.estimatedCostInr !== 0) throw new Error("Secondary provider dispatch blocked: estimated cost must be exactly INR 0");
    if (!request.input.trim() || Buffer.byteLength(request.input,"utf8") > 1_000_000) throw new Error("Secondary provider input must be non-empty and at most 1 MB");
    if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 || request.maxOutputTokens > 32768) throw new Error("maxOutputTokens must be between 1 and 32768");
    await this.verifyModel();
    const promptBytes = Buffer.byteLength(request.input,"utf8")+Buffer.byteLength(request.systemPrompt ?? "","utf8");
    await this.#quota.reserve(promptBytes+request.maxOutputTokens+1024);
    const response = await fetch(new URL("chat/completions",this.#baseUrl),{
      method:"POST",
      headers:{ authorization:"Bearer "+this.#apiKey,"content-type":"application/json",accept:"application/json" },
      body:JSON.stringify({
        model:this.model,
        messages:[
          ...(request.systemPrompt ? [{ role:"system",content:request.systemPrompt }] : []),
          { role:"user",content:request.input }
        ],
        max_tokens:request.maxOutputTokens,
        temperature:0.2,
        stream:false
      }),
      signal:AbortSignal.timeout(this.#timeoutMs)
    });
    if (!response.ok) throw new Error("Secondary provider inference failed with HTTP "+response.status);
    const payload = await response.json() as ChatResponse;
    const output = payload.choices?.[0]?.message?.content;
    if (typeof output !== "string") throw new Error("Secondary provider returned no text completion");
    return {
      output,
      provider:this.id,
      model:this.model,
      ...(payload.usage ? { usage:{ inputTokens:payload.usage.prompt_tokens ?? 0,outputTokens:payload.usage.completion_tokens ?? 0 } } : {})
    };
  }
}
