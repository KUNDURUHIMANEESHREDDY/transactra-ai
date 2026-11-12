const encoder = new TextEncoder();
const MAX_INPUT_BYTES = 8000;
const MAX_OUTPUT_TOKENS = 1000;
const MAX_DAILY_REQUESTS = 100;
const MAX_DAILY_TOKENS = 50000;

function base64UrlToBytes(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function encryptionKey(env, usages) {
  const secret = String(env.MODEL_REGISTRY_ENCRYPTION_KEY || "");
  if (encoder.encode(secret).byteLength < 32) throw new Error("Model registry encryption key is unavailable");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode("transactra-model-key-v1:" + secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, usages);
}

export async function decryptModelApiKey(env, encrypted) {
  const packed = base64UrlToBytes(encrypted);
  if (packed.byteLength < 29) throw new Error("Stored model credential is malformed");
  const iv = packed.slice(0, 12);
  const ciphertext = packed.slice(12);
  const key = await encryptionKey(env, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

export async function hasRegisteredTaskModel(db, ownerId, taskType) {
  if (!db?.prepare || !ownerId || !taskType) return false;
  const row = await db.prepare(`
    SELECT p.id FROM task_model_routes r
    JOIN model_providers p ON p.id=r.model_provider_id
    WHERE r.owner_id=? AND r.task_type=? AND p.owner_id=? AND p.enabled=1
  `).bind(String(ownerId), String(taskType), String(ownerId)).first();
  return Boolean(row?.id);
}

async function loadProvider(db, ownerId, id) {
  if (!id) return null;
  return db.prepare("SELECT id,name,provider,base_url,model_id,encrypted_api_key,max_output_tokens FROM model_providers WHERE id=? AND owner_id=? AND enabled=1")
    .bind(String(id), String(ownerId)).first();
}

async function reserveUsage(db, ownerId, providerId, estimatedTokens, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const result = await db.prepare(`
    INSERT INTO model_usage_daily
      (owner_id,provider_id,usage_date,requests_reserved,requests_used,tokens_reserved,tokens_used,max_requests,max_tokens,updated_at)
    VALUES (?,?,?,1,0,?,0,?,?,?)
    ON CONFLICT(owner_id,provider_id,usage_date) DO UPDATE SET
      requests_reserved=model_usage_daily.requests_reserved+1,
      tokens_reserved=model_usage_daily.tokens_reserved+excluded.tokens_reserved,
      updated_at=excluded.updated_at
    WHERE model_usage_daily.requests_reserved+model_usage_daily.requests_used < model_usage_daily.max_requests
      AND model_usage_daily.tokens_reserved+model_usage_daily.tokens_used+excluded.tokens_reserved <= model_usage_daily.max_tokens
    RETURNING usage_date,requests_reserved,tokens_reserved
  `).bind(String(ownerId), String(providerId), day, estimatedTokens, MAX_DAILY_REQUESTS, MAX_DAILY_TOKENS, now.toISOString()).first();
  if (!result) throw new Error("Model provider daily request/token budget is exhausted; inference blocked");
  return { day, estimatedTokens };
}

async function settleUsage(db, ownerId, providerId, reservation, actualTokens, now = new Date()) {
  if (!Number.isSafeInteger(actualTokens) || actualTokens < 0 || actualTokens > reservation.estimatedTokens) {
    throw new Error("Provider usage exceeded the reserved token budget; reservation retained");
  }
  const result = await db.prepare(`
    UPDATE model_usage_daily
    SET requests_reserved=requests_reserved-1,requests_used=requests_used+1,
        tokens_reserved=tokens_reserved-?,tokens_used=tokens_used+?,updated_at=?
    WHERE owner_id=? AND provider_id=? AND usage_date=? AND requests_reserved>=1 AND tokens_reserved>=?
    RETURNING requests_used,tokens_used
  `).bind(reservation.estimatedTokens, actualTokens, now.toISOString(), String(ownerId), String(providerId), reservation.day, reservation.estimatedTokens).first();
  if (!result) throw new Error("Model provider usage settlement failed; reservation retained");
}

function completionEndpoint(baseUrl) {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash
      || !base.hostname || base.hostname === "localhost" || base.hostname.endsWith(".local")
      || base.hostname.endsWith(".internal") || /^\d{1,3}(\.\d{1,3}){3}$/.test(base.hostname)
      || base.hostname.startsWith("[") || base.port && !["443"].includes(base.port)) {
    throw new Error("Registered model endpoint is not an allowed public HTTPS URL");
  }
  base.pathname = base.pathname.replace(/\/$/, "") + "/chat/completions";
  return base;
}

async function callProvider(env, db, ownerId, provider, request) {
  const systemPrompt = typeof request.systemPrompt === "string" ? request.systemPrompt : "";
  const input = String(request.input || "");
  const inputBytes = encoder.encode(systemPrompt + input).byteLength;
  if (!input.trim() || inputBytes > MAX_INPUT_BYTES) throw new Error("Model input is empty or exceeds the 8000-byte limit");
  const maxTokens = Number(request.maxOutputTokens);
  const providerMax = Math.min(MAX_OUTPUT_TOKENS, Math.max(1, Number(provider.max_output_tokens || 512)));
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > providerMax) {
    throw new Error("Model output token request exceeds the provider's configured limit");
  }
  const reservation = await reserveUsage(db, ownerId, provider.id, inputBytes + maxTokens);
  const apiKey = await decryptModelApiKey(env, provider.encrypted_api_key);
  const endpoint = completionEndpoint(provider.base_url);
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: "Bearer " + apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        model: provider.model_id,
        messages: [...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []), { role: "user", content: input }],
        max_tokens: maxTokens,
        temperature: 0.2
      }),
      redirect: "error",
      signal: AbortSignal.timeout(30000)
    });
  } catch {
    // A timeout/network failure can occur after provider acceptance. Keep the reservation and never replay it.
    throw new Error("Model provider transport failed or timed out; usage reservation retained and automatic replay blocked");
  }
  if (!response.ok) {
    if ([400, 401, 403, 404, 410, 429].includes(response.status)) {
      await settleUsage(db, ownerId, provider.id, reservation, 0);
      const error = new Error("Model provider explicitly rejected the request with HTTP " + response.status);
      error.explicitRejection = true;
      throw error;
    }
    throw new Error("Model provider returned HTTP " + response.status + "; usage reservation retained and fallback blocked");
  }
  const data = await response.json().catch(() => null);
  const output = data?.choices?.[0]?.message?.content;
  const inputTokens = Number(data?.usage?.prompt_tokens);
  const outputTokens = Number(data?.usage?.completion_tokens);
  if (typeof output !== "string" || !output.trim() || data?.model !== provider.model_id
      || !Number.isSafeInteger(inputTokens) || inputTokens < 0
      || !Number.isSafeInteger(outputTokens) || outputTokens < 0) {
    throw new Error("Model provider returned an unverified completion; usage reservation retained");
  }
  await settleUsage(db, ownerId, provider.id, reservation, inputTokens + outputTokens);
  return {
    output: output.trim(),
    provider: String(provider.provider || "openai-compatible"),
    model: provider.model_id,
    latencyMs: Date.now() - startedAt,
    usage: { inputTokens, outputTokens }
  };
}

export async function completeRegisteredModel(env, db, request, taskType = "general") {
  const ownerId = String(env.TELEGRAM_OWNER_ID || "");
  if (!ownerId || !db?.prepare) return null;
  const route = await db.prepare("SELECT model_provider_id,fallback_provider_id FROM task_model_routes WHERE owner_id=? AND task_type=?")
    .bind(ownerId, String(taskType)).first();
  if (!route?.model_provider_id) return null;
  const primary = await loadProvider(db, ownerId, route.model_provider_id);
  if (!primary) throw new Error("Selected task model is disabled or unavailable; inference blocked");
  try {
    return await callProvider(env, db, ownerId, primary, request);
  } catch (error) {
    if (!error?.explicitRejection || !route.fallback_provider_id) throw error;
    const fallback = await loadProvider(db, ownerId, route.fallback_provider_id);
    if (!fallback || fallback.id === primary.id) throw new Error("Configured fallback model is unavailable; inference blocked");
    return callProvider(env, db, ownerId, fallback, request);
  }
}

export const MODEL_REGISTRY_LIMITS = Object.freeze({
  maxInputBytes: MAX_INPUT_BYTES,
  maxOutputTokens: MAX_OUTPUT_TOKENS,
  maxDailyRequests: MAX_DAILY_REQUESTS,
  maxDailyTokens: MAX_DAILY_TOKENS
});
