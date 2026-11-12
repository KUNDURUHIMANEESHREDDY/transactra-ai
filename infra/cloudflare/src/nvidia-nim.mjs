const PROVIDER = "nvidia-nim";
// No Transactra-imposed daily request or token ceiling. NVIDIA account limits and billing terms remain authoritative.
const MAX_REQUESTS_PER_DAY = Number.MAX_SAFE_INTEGER;
const MAX_TOKENS_PER_DAY = Number.MAX_SAFE_INTEGER;
const MAX_INPUT_BYTES = 8000;
const MAX_OUTPUT_TOKENS = 1000;
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 120000;
const VERIFICATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function isFreshAttestation(raw, now = Date.now()) {
  if (typeof raw !== "string" || !raw.trim()) return false;
  const verifiedAt = Date.parse(raw);
  return Number.isFinite(verifiedAt)
    && verifiedAt <= now + 5 * 60 * 1000
    && now - verifiedAt <= VERIFICATION_MAX_AGE_MS;
}

export function isNvidiaNimDeveloperAccessConfirmed(env, now = Date.now()) {
  // Transactra is a private development/testing project. NVIDIA Developer Program
  // access is sufficient here; this is not a production/customer entitlement.
  return isFreshAttestation(env.NVIDIA_NIM_FREE_TIER_VERIFIED_AT, now);
}

const VERIFIED_FREE_MODELS = Object.freeze(["stepfun-ai/step-5-preview"]);

export function getNvidiaNimModels(env) {
  const primary = typeof env.NVIDIA_NIM_MODEL === "string" ? env.NVIDIA_NIM_MODEL.trim() : "";
  const fallback = typeof env.NVIDIA_NIM_FALLBACK_MODELS === "string"
    ? env.NVIDIA_NIM_FALLBACK_MODELS.split(",").map(value => value.trim()).filter(Boolean)
    : [];
  if (primary !== "stepfun-ai/step-5-preview" || !VERIFIED_FREE_MODELS.includes(primary) || fallback.length > 0) {
    throw new Error("Transactra is locked to NVIDIA NIM stepfun-ai/step-5-preview; alternate models and fallbacks are disabled");
  }
  return [primary];
}

export function isNvidiaNimZeroCostConfirmed(env, now = Date.now()) {
  return isNvidiaNimDeveloperAccessConfirmed(env, now)
    && env.NVIDIA_NIM_ZERO_COST_LIMIT_INR === "0";
}

export function getNvidiaNimReadiness(env, runtimeEnabled = false, now = Date.now()) {
  const developerAccess = isNvidiaNimDeveloperAccessConfirmed(env, now);
  const zeroCost = isNvidiaNimZeroCostConfirmed(env, now);
  const configured = isNvidiaNimConfigured(env, now);
  const flagsEnabled = env.NVIDIA_NIM_EXECUTION_ENABLED === "true"
    || env.NVIDIA_NIM_PLANNING_ENABLED === "true";
  let reason = null;
  if (!developerAccess) reason = "developer_access_unverified";
  else if (!zeroCost) reason = "free_endpoint_terms_unverified";
  else if (!configured) reason = "provider_configuration_incomplete";
  else if (!flagsEnabled) reason = "feature_flags_disabled";
  else if (!runtimeEnabled) reason = "runtime_disabled";
  return {
    status: reason ? "disabled" : "ready",
    configured,
    runtime_enabled: Boolean(runtimeEnabled),
    developer_access_verified: developerAccess,
    zero_cost_verified: zeroCost,
    billing_mode: "nvidia_developer_program_free_endpoint",
    models: configured ? getNvidiaNimModels(env) : [],
    reason
  };
}

function validateConfig(env, now = Date.now()) {
  if (!isNvidiaNimDeveloperAccessConfirmed(env, now)) {
    throw new Error("NVIDIA NIM disabled: fresh NVIDIA Developer Program access verification is required");
  }
  if (!isNvidiaNimZeroCostConfirmed(env, now)) {
    throw new Error("NVIDIA NIM disabled: zero-cost account terms are missing or unverified");
  }
  
  if (typeof env.NVIDIA_NIM_API_KEY !== "string" || !env.NVIDIA_NIM_API_KEY.trim()) {
    throw new Error("NVIDIA NIM disabled: Worker secret NVIDIA_NIM_API_KEY is missing");
  }
  if (typeof env.NVIDIA_NIM_MODEL !== "string" || !env.NVIDIA_NIM_MODEL.trim()) {
    throw new Error("NVIDIA NIM disabled: NVIDIA_NIM_MODEL is not configured");
  }
  const base = new URL(env.NVIDIA_NIM_BASE_URL || "https://integrate.api.nvidia.com");
  if (base.origin !== "https://integrate.api.nvidia.com" || base.pathname !== "/" || base.username || base.password || base.search || base.hash) {
    throw new Error("NVIDIA NIM endpoint is restricted to https://integrate.api.nvidia.com");
  }
  const timeout = Number(env.NVIDIA_NIM_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > MAX_TIMEOUT_MS) {
    throw new Error("NVIDIA NIM timeout must be between 1000 and 120000 ms");
  }
  return { apiKey: env.NVIDIA_NIM_API_KEY, model: env.NVIDIA_NIM_MODEL.trim(), models: getNvidiaNimModels(env), base, timeout };
}

export function isNvidiaNimConfigured(env, now = Date.now()) {
  try { validateConfig(env, now); return true; }
  catch { return false; }
}

async function readNvidiaNimStream(response, expectedModel) {
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error("NVIDIA NIM streaming response body is unavailable");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  let returnedModel = null;
  let usage = null;
  let done = false;

  const consumeLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") { done = true; return; }
    if (!data) return;
    let chunk;
    try { chunk = JSON.parse(data); }
    catch { throw new Error("NVIDIA NIM returned malformed streaming JSON"); }
    if (typeof chunk.model === "string") {
      if (returnedModel && returnedModel !== chunk.model) throw new Error("NVIDIA NIM stream changed model identifiers");
      returnedModel = chunk.model;
    }
    const delta = chunk.choices?.[0]?.delta;
    if (typeof delta?.content === "string") output += delta.content;
    if (chunk.usage && Number.isSafeInteger(chunk.usage.prompt_tokens)
        && Number.isSafeInteger(chunk.usage.completion_tokens)) {
      usage = { promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens };
    }
  };

  try {
    while (!done) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        consumeLine(line);
        if (done) break;
      }
    }
    buffer += decoder.decode();
    if (!done && buffer.trim()) consumeLine(buffer);
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  if (!done) throw new Error("NVIDIA NIM stream ended before [DONE]");
  if (returnedModel !== expectedModel) throw new Error("NVIDIA NIM returned an unverified model identifier");
  if (!output.trim()) throw new Error("NVIDIA NIM returned no text completion");
  if (!usage || !Number.isSafeInteger(usage.promptTokens) || usage.promptTokens < 0
      || !Number.isSafeInteger(usage.completionTokens) || usage.completionTokens < 0) {
    throw new Error("NVIDIA NIM did not return verifiable streamed token usage");
  }
  return { output, model: returnedModel, usage };
}

async function reserveDailyQuota(db, provider, tokens, now = new Date()) {
  if (!db || typeof db.prepare !== "function") throw new Error("D1 quota store unavailable; inference blocked");
  if (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > MAX_TOKENS_PER_DAY) {
    throw new Error("NVIDIA NIM token reservation exceeds the safe accounting range");
  }
  const day = now.toISOString().slice(0, 10);
  const updatedAt = now.toISOString();
  // Single conditional UPSERT is atomic; daily counters remain observable without imposing a practical Transactra ceiling.
  const result = await db.prepare(`
    INSERT INTO inference_quota_daily
      (quota_date, provider, requests_reserved, requests_used, tokens_reserved, tokens_used,
       max_requests, max_tokens, cost_microunits, max_cost_microunits, status, updated_at)
    VALUES (?, ?, 1, 0, ?, 0, ?, ?, 0, 0, 'active', ?)
    ON CONFLICT(quota_date, provider) DO UPDATE SET
      requests_reserved = inference_quota_daily.requests_reserved + 1,
      tokens_reserved = inference_quota_daily.tokens_reserved + excluded.tokens_reserved,
      updated_at = excluded.updated_at
    WHERE inference_quota_daily.status = 'active'
      AND inference_quota_daily.cost_microunits = 0
      AND inference_quota_daily.max_cost_microunits = 0
      AND inference_quota_daily.requests_reserved + inference_quota_daily.requests_used < inference_quota_daily.max_requests
      AND inference_quota_daily.tokens_reserved + inference_quota_daily.tokens_used + excluded.tokens_reserved <= inference_quota_daily.max_tokens
    RETURNING quota_date, provider, requests_reserved, tokens_reserved
  `).bind(day, provider, tokens, MAX_REQUESTS_PER_DAY, MAX_TOKENS_PER_DAY, updatedAt).first();
  if (!result) throw new Error("NVIDIA NIM zero-cost quota is paused or unavailable; inference blocked");
  return { day, tokens };
}

async function settleReservation(db, provider, reservation, actualTokens, now = new Date()) {
  if (!Number.isSafeInteger(actualTokens) || actualTokens < 0 || actualTokens > reservation.tokens) {
    // Keep the reservation consumed if provider usage is missing or exceeds the reservation.
    throw new Error("NVIDIA NIM usage exceeded its reservation; quota remains conservatively reserved");
  }
  const result = await db.prepare(`
    UPDATE inference_quota_daily
    SET requests_reserved = requests_reserved - 1,
        requests_used = requests_used + 1,
        tokens_reserved = tokens_reserved - ?,
        tokens_used = tokens_used + ?,
        updated_at = ?
    WHERE quota_date = ? AND provider = ?
      AND requests_reserved >= 1 AND tokens_reserved >= ?
      AND cost_microunits = 0 AND max_cost_microunits = 0
    RETURNING requests_used, tokens_used
  `).bind(reservation.tokens, actualTokens, now.toISOString(), reservation.day, provider, reservation.tokens).first();
  if (!result) throw new Error("NVIDIA NIM quota settlement failed; reservation remains conservative");
}

/**
 * Cloudflare Workers-native NVIDIA NIM adapter.
 * Always uses the single approved Step 5 Preview model. Retries only an
 * explicit HTTP 429 rejection once; all other failures retain their reservation
 * and are never replayed. No model failover or provider fallback is permitted.
 */
export async function completeNvidiaNim(env, request, options = {}) {
  const now = options.now ?? Date.now();
  const config = validateConfig(env, now);
  const ownerId = String(env.TELEGRAM_OWNER_ID || "");
  if (!ownerId || !env.DB || typeof env.DB.prepare !== "function") throw new Error("NVIDIA NIM service control store unavailable; inference blocked");
  const serviceState = await env.DB.prepare("SELECT enabled FROM nvidia_runtime_control WHERE owner_id=?").bind(ownerId).first();
  if (Number(serviceState?.enabled || 0) !== 1) throw new Error("NVIDIA NIM service is OFF; owner must enable it through Telegram");
  if (!request || request.estimatedCostInr !== 0) throw new Error("NVIDIA NIM dispatch blocked: estimated cost must be exactly INR 0");
  if (typeof request.input !== "string" || !request.input.trim()) throw new Error("NVIDIA NIM input must be non-empty");
  const systemPrompt = typeof request.systemPrompt === "string" ? request.systemPrompt : "";
  const inputBytes = new TextEncoder().encode(systemPrompt + request.input).byteLength;
  if (inputBytes > MAX_INPUT_BYTES) throw new Error("NVIDIA NIM input exceeds the 8000-byte limit");
  const outputTokens = request.maxOutputTokens;
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 1 || outputTokens > MAX_OUTPUT_TOKENS) {
    throw new Error("NVIDIA NIM maxOutputTokens must be between 1 and 1000");
  }

  const failures = [];
  for (const model of config.models) {
    const provider = PROVIDER + ":" + model;
    let retry429 = true;
    while (true) {
      const reservation = await reserveDailyQuota(env.DB, provider, inputBytes + outputTokens, new Date(now));
      const requestStartedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort("NVIDIA NIM timeout"), config.timeout);
      let response;
      let streamed;
      try {
        response = await fetch(new URL("/v1/chat/completions", config.base), {
          method: "POST",
          headers: {
            authorization: "Bearer " + config.apiKey,
            "content-type": "application/json",
            accept: "text/event-stream"
          },
          body: JSON.stringify({
            model,
            messages: [
              ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
              { role: "user", content: request.input }
            ],
            max_tokens: outputTokens,
            temperature: 0.2,
            stream: true,
            stream_options: { include_usage: true }
          }),
          signal: controller.signal
        });
        if (response.ok) streamed = await readNvidiaNimStream(response, model);
      } catch (error) {
        // A network error/timeout can happen after NVIDIA accepted the request.
        // Retain its reservation and stop: never replay an ambiguous dispatch.
        console.error(JSON.stringify({
          event: "nvidia_nim_transport_failure",
          model,
          endpoint: config.base.origin,
          timeout_ms: config.timeout,
          latency_ms: Date.now() - requestStartedAt,
          error_name: error instanceof Error ? error.name : "unknown"
        }));
        throw new Error("NVIDIA NIM request failed or timed out; reservation retained and replay blocked");
      } finally {
        clearTimeout(timer);
      }
      const responseReceivedAt = Date.now();

      if (response.status === 429 && retry429) {
        // HTTP 429 is an explicit rejection. Release the unused token reservation,
        // wait briefly, and retry this model once before moving to the next NIM model.
        await settleReservation(env.DB, provider, reservation, 0, new Date());
        retry429 = false;
        await new Promise(resolve => setTimeout(resolve, 250));
        continue;
      }
      if (response.status === 404 || response.status === 410 || response.status === 429) {
        // These statuses indicate explicit rejection. There is no alternate model; stop here.
        await settleReservation(env.DB, provider, reservation, 0, new Date());
        failures.push(model + ": HTTP " + response.status);
        break;
      }
      if (!response.ok) {
        // Treat all other failures, especially 5xx, as ambiguous and do not fail over.
        throw new Error("NVIDIA NIM inference failed with HTTP " + response.status + "; reservation retained, replay blocked");
      }

      if (!streamed) throw new Error("NVIDIA NIM returned no verified streaming completion; reservation retained");
      const { output, model: returnedModel, usage } = streamed;
      await settleReservation(env.DB, provider, reservation, usage.promptTokens + usage.completionTokens, new Date());
      return {
        output,
        provider: PROVIDER,
        model: returnedModel,
        latencyMs: responseReceivedAt - requestStartedAt,
        usage: { inputTokens: usage.promptTokens, outputTokens: usage.completionTokens }
      };
    }
  }
  throw new AggregateError(failures.map(message => new Error(message)),
    "The configured NVIDIA NIM Step 5 Preview endpoint rejected the request; no model or provider fallback was attempted");
}

export const NVIDIA_NIM_LIMITS = Object.freeze({
  maxRequestsPerDay: MAX_REQUESTS_PER_DAY,
  maxTokensPerDay: MAX_TOKENS_PER_DAY,
  maxInputBytes: MAX_INPUT_BYTES,
  maxOutputTokens: MAX_OUTPUT_TOKENS,
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  maxTimeoutMs: MAX_TIMEOUT_MS
});
