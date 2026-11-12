import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cloudflareDir = resolve(here, "..");
const migrationsDir = resolve(cloudflareDir, "migrations");
const staging = readFileSync(resolve(cloudflareDir, "wrangler.staging.toml"), "utf8");
const production = readFileSync(resolve(cloudflareDir, "wrangler.toml"), "utf8");
const deployWorkflow = readFileSync(resolve(cloudflareDir, "../../.github/workflows/deploy-staging.yml"), "utf8");

function scalar(config, key) {
  const match = config.match(new RegExp("^" + key + "\\s*=\\s*\"([^\"]+)\"\\s*$", "m"));
  assert.ok(match, "missing TOML scalar: " + key);
  return match[1];
}

test("staging Worker is isolated from production D1 and queues", () => {
  assert.equal(scalar(staging, "name"), "transactra-edge-staging");
  assert.equal(scalar(staging, "main"), "src/index.mjs");
  assert.equal(scalar(staging, "database_name"), "transactra-staging");
  assert.equal(scalar(staging, "database_id"), "e7292f55-c90e-4d34-8b77-c97c3e5ec15a");
  assert.equal(scalar(staging, "migrations_dir"), "migrations");
  assert.equal(scalar(staging, "MEM0_ENABLED"), "false");
  assert.equal(scalar(staging, "TRANSACTRA_ENV"), "staging");
  assert.equal(scalar(staging, "TRANSACTRA_PLANNER_MODE"), "d1-native");
  assert.equal(scalar(staging, "TRANSACTRA_D1_DATABASE_ID"), "e7292f55-c90e-4d34-8b77-c97c3e5ec15a");
  assert.equal(scalar(staging, "TRANSACTRA_STAGING_BASE_URL"), "https://transactra-edge-staging.himaneeshreddyk.workers.dev");
  assert.equal(scalar(staging, "TRANSACTRA_MODEL_ORCHESTRATOR_ENABLED"), "false");
  assert.equal(scalar(staging, "NVIDIA_NIM_PLANNING_ENABLED"), "false");
  assert.equal(scalar(staging, "TRANSACTRA_AGENT_EXECUTION_ENABLED"), "false");
  assert.equal(scalar(staging, "NVIDIA_NIM_EXECUTION_ENABLED"), "false");
  assert.doesNotMatch(staging, /NVIDIA_NIM_FREE_TIER_VERIFIED_AT/);

  const queueNames = [
    ...staging.matchAll(/^queue = "([^"]+)"$/gm),
  ].map((match) => match[1]).filter((name) => name !== "transactra-events-staging");
  const configuredQueues = [
    ...staging.matchAll(/^queue = "([^"]+)"$/gm),
  ].map((match) => match[1]);
  assert.deepEqual(configuredQueues, ["transactra-events-staging", "transactra-events-staging"]);
  assert.match(staging, /dead_letter_queue = "transactra-events-dlq-staging"/);
  assert.ok(!queueNames.includes("transactra-events-dlq-staging"));
  assert.ok(!staging.includes("35047d34-b8f4-4a2a-9321-fb5b5e48e409"), "staging must not bind the production D1 database");
  assert.ok(!staging.includes('queue = "transactra-events"'), "staging must not publish to the production queue");
  assert.ok(!staging.includes('queue = "transactra-events-dlq"'), "staging must not use the production dead-letter queue");
  assert.doesNotMatch(staging, /^\s*\[ai\]\s*$/m, "staging must not configure an inference binding");
  assert.doesNotMatch(deployWorkflow, /^  push:/m, "staging deploy must never run automatically on every main push");
  assert.doesNotMatch(deployWorkflow, /35047d34-b8f4-4a2a-9321-fb5b5e48e409/, "staging deployment must never query or write production D1");
  assert.match(deployWorkflow, /e7292f55-c90e-4d34-8b77-c97c3e5ec15a/);
  assert.match(deployWorkflow, /evaluation_json=\?/);
  assert.match(deployWorkflow, /decision = "accepted"/);
  assert.match(deployWorkflow, /acceptance = "passed"/);
  assert.doesNotMatch(staging, /MEM0_API_KEY|TELEGRAM_BOT_TOKEN|TELEGRAM_WEBHOOK_SECRET|TRANSACTRA_GITHUB_TOKEN|TRANSACTRA_PIPELINE_(?:API_TOKEN|APPROVAL_TOKEN)\s*=/, "staging secrets must be supplied out of band");
  assert.match(staging, /Cloudflare Free.*owner-attested|owner-attested.*Cloudflare Free/i);
  assert.match(staging, /billing.*not.*API-verified|API-verified.*billing/i);
});

test("production Worker remains bound only to its production D1 and queues", () => {
  assert.equal(scalar(production, "name"), "transactra-edge");
  assert.equal(scalar(production, "MEM0_ENABLED"), "true", "production Mem0 synchronization is intentionally enabled after the live outbox-to-provider acceptance test");
  assert.equal(scalar(production, "database_name"), "transactra");
  assert.equal(scalar(production, "database_id"), "35047d34-b8f4-4a2a-9321-fb5b5e48e409");
  assert.equal(scalar(production, "TRANSACTRA_AGENT_EXECUTION_ENABLED"), "true", "production agent execution is enabled behind separate owner approvals and evidence gates");
  assert.equal(scalar(production, "NVIDIA_NIM_EXECUTION_ENABLED"), "true", "production NIM inference is enabled with the zero-cost guard and no fallbacks");
  const configuredQueues = [...production.matchAll(/^queue = "([^"]+)"$/gm)].map((match) => match[1]);
  assert.deepEqual(configuredQueues, ["transactra-events", "transactra-events"]);
  assert.match(production, /dead_letter_queue = "transactra-events-dlq"/);
  assert.doesNotMatch(production, /transactra-staging|e7292f55-c90e-4d34-8b77-c97c3e5ec15a/);
});

test("staging migration directory contains the complete reviewed sequence", () => {
  const files = readdirSync(migrationsDir).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  assert.deepEqual(files, [
    "0001_initial.sql",
    "0002_telegram_reply_outbox.sql",
    "0003_task_inbox.sql",
    "0004_task_run_ledger.sql",
    "0005_execution_plans_and_inference_quota.sql",
    "0006_pipeline_bridge.sql",
    "0007_task_lifecycle_states.sql",
    "0008_orchestrator_memory_recovery.sql",
    "0009_d1_native_approvals.sql",
    "0010_orchestrator_step_runs.sql",
    "0011_orchestrator_step_approvals.sql",
    "0012_telegram_business_message_outbox.sql",
    "0013_memory_lifecycle.sql",
    "0014_nvidia_runtime_control.sql",
    "0015_orchestrator_step_evidence.sql",
  ]);
  const runtimeControl = readFileSync(resolve(migrationsDir, "0014_nvidia_runtime_control.sql"), "utf8");
  assert.match(runtimeControl, /CREATE TABLE IF NOT EXISTS nvidia_runtime_control/);
  assert.match(runtimeControl, /enabled INTEGER NOT NULL DEFAULT 0 CHECK \(enabled IN \(0, 1\)\)/);
  const stepEvidence = readFileSync(resolve(migrationsDir, "0015_orchestrator_step_evidence.sql"), "utf8");
  assert.match(stepEvidence, /ALTER TABLE orchestrator_step_runs/);
  assert.match(stepEvidence, /evaluation_json TEXT\s+CHECK \(evaluation_json IS NULL OR json_valid\(evaluation_json\)\)/);
});

test("staging and production Workers persist logs and traces for failure investigation", () => {
  for (const [name, config] of [["staging", staging], ["production", production]]) {
    assert.match(config, /^\[observability\]\s*\nenabled = true\s*\nhead_sampling_rate = 1\.0/m, name + " Worker observability must be enabled and fully sampled");
    assert.match(config, /^\[observability\.logs\]\s*\nenabled = true\s*\nhead_sampling_rate = 1\.0\s*\npersist = true\s*\ninvocation_logs = true/m, name + " Worker logs must be persisted");
    assert.match(config, /^\[observability\.traces\]\s*\nenabled = true\s*\nhead_sampling_rate = 1\.0\s*\npersist = true/m, name + " Worker traces must be persisted");
  }
});
