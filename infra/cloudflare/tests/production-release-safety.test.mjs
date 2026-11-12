import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const config = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const release = readFileSync(new URL("../../../.github/workflows/deploy-production.yml", import.meta.url), "utf8");

test("production config enables inference and agent execution with NVIDIA planning", () => {
  assert.match(config, /TRANSACTRA_ENV\s*=\s*"production"/);
  assert.match(config, /TRANSACTRA_MODEL_ORCHESTRATOR_ENABLED\s*=\s*"true"/);
  assert.match(config, /NVIDIA_NIM_PLANNING_ENABLED\s*=\s*"true"/);
  assert.match(config, /TRANSACTRA_AGENT_EXECUTION_ENABLED\s*=\s*"true"/);
  assert.match(config, /NVIDIA_NIM_EXECUTION_ENABLED\s*=\s*"true"/);
  assert.match(config, /NVIDIA_NIM_FREE_TIER_VERIFIED_AT\s*=\s*"[^"]+"/);
  assert.match(config, /NVIDIA_NIM_MODEL\s*=\s*"stepfun-ai\/step-5-preview"/);
  assert.match(config, /NVIDIA_NIM_FALLBACK_MODELS\s*=\s*""/);
});

test("production release gate is independent of staging and requires enabled execution flags", () => {
  assert.doesNotMatch(release, /CLOUDFLARE_STAGING_BASE_URL|Require successful isolated staging acceptance|transactra-edge-staging/);
  assert.match(release, /Enforce production-only, NVIDIA planning and approval-gated execution release configuration/);
  assert.match(release, /NVIDIA_NIM_PLANNING_ENABLED/);
  assert.match(release, /TRANSACTRA_AGENT_EXECUTION_ENABLED/);
  assert.match(release, /NVIDIA_NIM_EXECUTION_ENABLED/);
});

test("production release isolates D1 migration and Worker deployment credentials", () => {
  assert.match(release, /CLOUDFLARE_API_TOKEN:\s*\$\{\{\s*secrets\.CLOUDFLARE_API_TOKEN\s*\}\}/);
  assert.match(release, /CLOUDFLARE_WORKERS_DEPLOY_TOKEN:\s*\$\{\{\s*secrets\.CLOUDFLARE_WORKERS_DEPLOY_TOKEN\s*\}\}/);
  assert.match(release, /Deploy the preflighted production Worker version[\s\S]*?CLOUDFLARE_API_TOKEN:\s*\$\{\{\s*secrets\.CLOUDFLARE_WORKERS_DEPLOY_TOKEN\s*\}\}/);
});

test("production Worker upload permission is verified before D1 migrations and the exact uploaded version is deployed", () => {
  const upload = release.indexOf("Upload production Worker version as a permission preflight");
  const migration = release.indexOf("Apply reviewed migrations to production D1");
  const deploy = release.indexOf("Deploy the preflighted production Worker version");
  assert.ok(upload >= 0 && migration > upload && deploy > migration, "upload preflight must run before migration and deployment");
  assert.match(release, /wrangler@4\.159\.0 versions upload/);
  assert.match(release, /Workers Scripts > Write/);
  assert.match(release, /\$ErrorActionPreference = "Continue"/);
  assert.match(release, /\$uploadExitCode = \$LASTEXITCODE/);
  assert.match(release, /wrangler@4\.159\.0 versions deploy "\$\(\$env:TRANSACTRA_VERSION_ID\)@100%"/);
});
