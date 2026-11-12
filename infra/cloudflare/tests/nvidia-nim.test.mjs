import test from "node:test";
import assert from "node:assert/strict";
import {
  completeNvidiaNim,
  getNvidiaNimModels,
  getNvidiaNimReadiness,
  isNvidiaNimDeveloperAccessConfirmed,
  isNvidiaNimZeroCostConfirmed,
  isNvidiaNimConfigured,
  NVIDIA_NIM_LIMITS
} from "../src/nvidia-nim.mjs";

const now = Date.parse("2026-11-10T12:00:00.000Z");
const validEnv = {
  NVIDIA_NIM_FREE_TIER_VERIFIED_AT: "2026-11-10T11:00:00.000Z",
  NVIDIA_NIM_ZERO_COST_LIMIT_INR: "0",
  NVIDIA_NIM_FALLBACK_MODELS: "",
  NVIDIA_NIM_API_KEY: "test",
  NVIDIA_NIM_MODEL: "stepfun-ai/step-5-preview",
  NVIDIA_NIM_EXECUTION_ENABLED: "true",
  TELEGRAM_OWNER_ID: "owner",
  DB: { prepare() { throw new Error("must not reach D1 in blocked tests"); } }
};

const request = { input: "hello", maxOutputTokens: 100, estimatedCostInr: 0 };

test("pins every inference to Step 5 Preview and rejects alternate models or fallbacks", () => {
  assert.deepEqual(getNvidiaNimModels(validEnv), ["stepfun-ai/step-5-preview"]);
  assert.throws(() => getNvidiaNimModels({ ...validEnv, NVIDIA_NIM_MODEL: "z-ai/glm-5-3-flash" }), /locked to NVIDIA NIM stepfun-ai\/step-5-preview/);
  assert.throws(() => getNvidiaNimModels({ ...validEnv, NVIDIA_NIM_FALLBACK_MODELS: "nvidia/nemotron-3.5-super-vl-120b-a12b" }), /alternate models and fallbacks are disabled/);
});

test("accepts a fresh Developer Program marker for private development access", () => {
  assert.equal(isNvidiaNimDeveloperAccessConfirmed(validEnv, now), true);
});

test("requires a fresh Developer Program access attestation", () => {
  assert.equal(isNvidiaNimDeveloperAccessConfirmed(validEnv, now), true);
  assert.equal(isNvidiaNimDeveloperAccessConfirmed({
    ...validEnv,
    NVIDIA_NIM_FREE_TIER_VERIFIED_AT: "2026-09-01T00:00:00.000Z"
  }, now), false);
});

test("requires independently verified zero-cost account terms and a zero INR ceiling", () => {
  assert.equal(isNvidiaNimZeroCostConfirmed(validEnv, now), true);
  assert.equal(isNvidiaNimZeroCostConfirmed({
    ...validEnv,
    NVIDIA_NIM_ZERO_COST_LIMIT_INR: "1"
  }, now), false);

});

test("readiness reports the exact blocking reason and never infers readiness from a secret alone", () => {
  const readiness = getNvidiaNimReadiness({
    NVIDIA_NIM_API_KEY: "present",
    NVIDIA_NIM_MODEL: "stepfun-ai/step-5-preview",
    NVIDIA_NIM_EXECUTION_ENABLED: "true"
  }, true, now);
  assert.equal(readiness.status, "disabled");
  assert.equal(readiness.reason, "developer_access_unverified");
  assert.equal(readiness.configured, false);
});

test("readiness remains disabled until the runtime switch is enabled", () => {
  const readiness = getNvidiaNimReadiness(validEnv, false, now);
  assert.equal(readiness.status, "disabled");
  assert.equal(readiness.reason, "runtime_disabled");
});

test("reports ready only when entitlement, zero-cost terms, configuration, flags and runtime are all verified", () => {
  const readiness = getNvidiaNimReadiness(validEnv, true, now);
  assert.equal(readiness.status, "ready");
  assert.equal(readiness.reason, null);
  assert.equal(readiness.developer_access_verified, true);
  assert.equal(readiness.zero_cost_verified, true);
});

test("does not impose daily request or token ceilings and retains per-request safety bounds", () => {
  assert.equal(NVIDIA_NIM_LIMITS.maxRequestsPerDay, Number.MAX_SAFE_INTEGER);
  assert.equal(NVIDIA_NIM_LIMITS.maxTokensPerDay, Number.MAX_SAFE_INTEGER);
  assert.equal(NVIDIA_NIM_LIMITS.maxInputBytes, 8000);
  assert.equal(NVIDIA_NIM_LIMITS.maxOutputTokens, 1000);
  assert.equal(NVIDIA_NIM_LIMITS.maxTimeoutMs, 120000);
});

test("accepts a two-minute streaming deadline and rejects values above the queue-safe maximum", () => {
  assert.equal(isNvidiaNimConfigured({ ...validEnv, NVIDIA_NIM_TIMEOUT_MS: "120000" }, now), true);
  assert.equal(isNvidiaNimConfigured({ ...validEnv, NVIDIA_NIM_TIMEOUT_MS: "120001" }, now), false);
});

test("owner runtime control OFF blocks inference before any provider request", async () => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalls++; throw new Error("must not be called"); };
  const db = {
    prepare() {
      const statement = {
        bind() { return statement; },
        async first() { return { enabled: 0 }; }
      };
      return statement;
    }
  };
  try {
    await assert.rejects(
      completeNvidiaNim({ ...validEnv, DB: db }, request),
      /NVIDIA NIM service is OFF/
    );
    assert.equal(fetchCalls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("blocks inference before network access when production entitlement is absent", async () => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalls++; throw new Error("must not be called"); };
  try {
    await assert.rejects(
      completeNvidiaNim({
        NVIDIA_NIM_API_KEY: "test",
        NVIDIA_NIM_MODEL: "stepfun-ai/step-5-preview",
        TELEGRAM_OWNER_ID: "owner",
        DB: {}
      }, request),
      /Developer Program access verification is required/
    );
    assert.equal(fetchCalls, 0);
  } finally { globalThis.fetch = originalFetch; }
});


