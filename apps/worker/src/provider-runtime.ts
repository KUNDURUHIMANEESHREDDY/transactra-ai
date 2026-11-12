import { NvidiaNimProvider } from "../../../packages/providers/src/nvidia-nim.js";
import { OpenAICompatibleProvider } from "../../../packages/providers/src/openai-compatible.js";
import { ProviderRouter, type ZeroCostProvider } from "../../../packages/providers/src/router.js";
import { PostgresProviderQuota } from "../../../packages/storage/src/provider-quota.js";
import { PostgresProviderHealthStore } from "../../../packages/storage/src/provider-health.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(name + " is required");
  return value.trim();
}
function positiveInteger(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(name + " must be a positive integer");
  return value;
}
const NIM_PROVIDER_FIELDS = [
  "NVIDIA_NIM_API_KEY",
  "NVIDIA_NIM_MODEL",
  "NVIDIA_NIM_FREE_TIER_VERIFIED_AT",
  "NVIDIA_NIM_MONTHLY_REQUEST_CAP",
  "NVIDIA_NIM_MONTHLY_TOKEN_CAP"
] as const;
export function hasAnyNimConfig(): boolean {
  return NIM_PROVIDER_FIELDS.some((name) => Boolean(process.env[name]?.trim()));
}
export function hasCompleteNimConfig(): boolean {
  return NIM_PROVIDER_FIELDS.every((name) => Boolean(process.env[name]?.trim()));
}
const SECONDARY_PROVIDER_FIELDS = [
  "SECONDARY_PROVIDER_ID",
  "SECONDARY_PROVIDER_BASE_URL",
  "SECONDARY_PROVIDER_API_KEY",
  "SECONDARY_PROVIDER_MODEL",
  "SECONDARY_PROVIDER_FREE_TIER_VERIFIED_AT",
  "SECONDARY_PROVIDER_MONTHLY_REQUEST_CAP",
  "SECONDARY_PROVIDER_MONTHLY_TOKEN_CAP"
] as const;
function hasAnySecondaryProviderConfig(): boolean {
  return SECONDARY_PROVIDER_FIELDS.some((name) => Boolean(process.env[name]?.trim()));
}

/**
 * Builds the zero-cost provider runtime.
 *
 * A deployment may deliberately run without any inference provider (for example a
 * control-plane-only or Telegram-only host). In that case this returns `undefined` and the
 * caller wires an empty provider router: every inference request then fails closed with the
 * router's own "no verified no-cost provider is configured" error instead of the worker
 * refusing to start. Partial NIM or secondary-provider configuration is an error, because it
 * usually means a credential failed to copy into the deployment environment.
 */
export function createProviderRuntime(): {
  router: ProviderRouter;
  close: () => Promise<void>;
} | undefined {
  const databaseUrl = required("DATABASE_URL");
  if (!hasAnyNimConfig() && !hasAnySecondaryProviderConfig()) return undefined;
  const quotas: PostgresProviderQuota[] = [];
  const health = new PostgresProviderHealthStore(databaseUrl);
  try {
    const providers: ZeroCostProvider[] = [];

    if (hasAnyNimConfig()) {
      if (!hasCompleteNimConfig()) {
        throw new Error("NVIDIA NIM configuration is partial; provide NVIDIA_NIM_API_KEY, NVIDIA_NIM_MODEL, NVIDIA_NIM_FREE_TIER_VERIFIED_AT, NVIDIA_NIM_MONTHLY_REQUEST_CAP and NVIDIA_NIM_MONTHLY_TOKEN_CAP, or leave all unset");
      }
      const nimQuota = new PostgresProviderQuota(databaseUrl,{
        requests:positiveInteger("NVIDIA_NIM_MONTHLY_REQUEST_CAP"),
        tokens:positiveInteger("NVIDIA_NIM_MONTHLY_TOKEN_CAP")
      });
      quotas.push(nimQuota);
      providers.push(new NvidiaNimProvider({
        apiKey:required("NVIDIA_NIM_API_KEY"),
        model:required("NVIDIA_NIM_MODEL"),
        freeTierVerifiedAt:required("NVIDIA_NIM_FREE_TIER_VERIFIED_AT"),
        ...(process.env.NVIDIA_NIM_BASE_URL?.trim() ? { baseUrl:process.env.NVIDIA_NIM_BASE_URL.trim() } : {})
      },nimQuota));
    }

    if (hasAnySecondaryProviderConfig()) {
      const providerId = required("SECONDARY_PROVIDER_ID");
      const quota = new PostgresProviderQuota(databaseUrl,{
        requests:positiveInteger("SECONDARY_PROVIDER_MONTHLY_REQUEST_CAP"),
        tokens:positiveInteger("SECONDARY_PROVIDER_MONTHLY_TOKEN_CAP")
      },providerId);
      quotas.push(quota);
      providers.push(new OpenAICompatibleProvider({
        id:providerId,
        baseUrl:required("SECONDARY_PROVIDER_BASE_URL"),
        apiKey:required("SECONDARY_PROVIDER_API_KEY"),
        model:required("SECONDARY_PROVIDER_MODEL"),
        freeTierVerifiedAt:required("SECONDARY_PROVIDER_FREE_TIER_VERIFIED_AT")
      },quota));
    }

    const router = new ProviderRouter(providers,{ onHealth:(event) => health.record(event) });
    return {
      router,
      close:async () => { await Promise.all([...quotas.map((quota) => quota.close()),health.close()]); }
    };
  } catch (error) {
    void Promise.all([...quotas.map((quota) => quota.close()),health.close()]).catch(() => undefined);
    throw error;
  }
}
