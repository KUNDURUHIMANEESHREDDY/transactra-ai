# NVIDIA NIM provider configuration

## API integration

Transactra uses NVIDIA's OpenAI-compatible hosted API:

- Base URL: `https://integrate.api.nvidia.com`
- Model catalog: `GET /v1/models`
- Chat inference: `POST /v1/chat/completions`
- Authentication: bearer API key
- Primary model: `z-ai/glm-5-3-flash`; fallback: `nvidia/nemotron-3.5-super-vl-120b-a12b`

Official references:
- [NVIDIA NIM LLM API reference](https://docs.api.nvidia.com/nim/reference/llm-apis)
- [NVIDIA NIM product FAQ and Developer Program access](https://docs.api.nvidia.com/nim/docs/product)

## Provider policy: private NVIDIA NIM development

Transactra is currently unpublished and used only by its owner for personal development and testing. It is not serving public customers. NVIDIA Developer Program hosted endpoints are therefore used only within their prototyping, research, development and testing terms; this configuration must not be reused to serve real end users or commercial production traffic. A future public release must use each individual's own provider credentials (BYOK) and must independently satisfy the provider's terms.

The Cloudflare Worker uses NVIDIA NIM only. The configured free-endpoint pool is:
- Primary: `z-ai/glm-5-3-flash`
- Fallback: `nvidia/nemotron-3.5-super-vl-120b-a12b`

Both are currently labelled **Free Endpoint** in NVIDIA's official model catalog. Catalog labels and availability can change; refresh the allowlist and account review before changing models. No other provider, paid model, or cross-provider fallback is configured.

Retry/fallback safety:
- Retry one time on HTTP 429 only; this is an explicit rate-limit rejection.
- Move to the next allowlisted NIM model only after HTTP 404, 410, or a second HTTP 429.
- Do not retry or fail over on network errors, timeouts, HTTP 5xx, malformed responses, or missing usage. NVIDIA may have accepted such a request; its D1 reservation is retained to avoid duplicate inference.
- Each model has its own D1 quota ledger key. Positive estimated cost is rejected before dispatch.

## Private development access and zero-spend guard

- `NVIDIA_NIM_API_KEY`: Cloudflare Worker secret; never commit or log.
- `NVIDIA_NIM_MODEL`: primary allowlisted free model.
- `NVIDIA_NIM_FALLBACK_MODELS`: comma-separated allowlisted free NIM models.
- `NVIDIA_NIM_FREE_TIER_VERIFIED_AT`: UTC ISO timestamp of the owner's NVIDIA Developer Program access review; expires after 30 days.
- `NVIDIA_NIM_ZERO_COST_LIMIT_INR`: must be exactly `0` for Transactra's local dispatch policy.
- `NVIDIA_NIM_TIMEOUT_MS`: request timeout from 1,000 to 30,000 ms.

NVIDIA documents Developer Program access to hosted NIM API endpoints as free for prototyping, with account-level limits and applicable terms. This is not unlimited usage or a guarantee that every endpoint/account remains free. Transactra's local INR 0 policy is a dispatch guard, not a provider invoice or billing guarantee. Check NVIDIA's current account limits and model labels regularly. The adapter records reservations and observed token usage in D1; it does not claim to reconcile provider monetary billing.

Official references:
- [NVIDIA Developer Program and NIM access FAQ](https://docs.api.nvidia.com/nim/docs/product)
- [NVIDIA model catalog — Free Endpoint filter](https://build.nvidia.com/models?label=Chat)
- [Z.ai GLM 5.3 Flash free endpoint](https://build.nvidia.com/z-ai/glm-5-3-flash)
- [NVIDIA Nemotron 3.5 Super VL free endpoint](https://build.nvidia.com/nvidia/nemotron-3.5-super-vl-120b-a12b)

## Telegram integration

The Cloudflare Worker receives Telegram updates through the secret-token-protected webhook, queues them, persists inbound events in D1, and sends replies through the Telegram Bot API. The owner-only `/nvidia_status` command reports whether the NIM secret, model pool, and Developer Program review are present without exposing the API key or sending an inference request.

Ordinary Telegram chat is sent to NIM only when `NVIDIA_NIM_EXECUTION_ENABLED=true` and the current Developer Program access review and free-model allowlist pass validation. Otherwise the bot replies that inference is paused and sends no model request. Task creation, approval, and rejection remain separate from chat inference; approving a task does not bypass agent-execution or provider gates.

## Acceptance coverage

Run `node --test tests/provider-failover-acceptance.test.js` and `node --test infra/cloudflare/tests/nvidia-nim.test.mjs`.

The NVIDIA-only acceptance suite covers:
- A successful authenticated NIM completion and quota settlement.
- Missing Developer Program review blocking before network access.
- Daily quota exhaustion blocking before network access.
- HTTP 429 receiving one safe retry; explicit 404/410 or repeated 429 switching only to the configured NIM fallback; ambiguous network/5xx failures never replayed.
- Positive-cost requests rejected before quota reservation or network access.
- Fixed request, token, input, output, and timeout bounds.

These deterministic tests do not prove the account's live Developer Program access, the real API key's validity, Telegram webhook registration, live model output, D1 production connectivity, or provider billing. They must pass in the protected production release workflow before deployment. The private NIM runtime switch remains OFF until the owner enables it.
