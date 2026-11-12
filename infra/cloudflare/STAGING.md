# Transactra staging operations

## Safety boundary

- Staging Worker: `transactra-edge-staging`.
- Staging D1: `transactra-staging`, ID `e7292f55-c90e-4d34-8b77-c97c3e5ec15a`.
- Staging queue: `transactra-events-staging`; dead-letter queue: `transactra-events-dlq-staging`.
- Staging Telegram bot only. Never register the production bot token against the staging webhook.
- The staging workflow has no `push` trigger. It runs only when an owner manually dispatches `Transactra Staging Deploy` or when Transactra dispatches an exact owner-approved staging action.
- The workflow is pinned to the local Windows runner labels `[self-hosted, Windows, X64]`.
- Production Worker `transactra-edge`, production D1, production queues, production Telegram webhook and production deployment settings are not used by this workflow.

Cloudflare Free status remains owner-attested (2026-11-09); the connected API identity cannot independently read billing state. Do not enable paid products, upgrades or billing.

## Inference lock

The staging TOML intentionally sets all of these to `false`:

- `TRANSACTRA_MODEL_ORCHESTRATOR_ENABLED`
- `NVIDIA_NIM_PLANNING_ENABLED`
- `TRANSACTRA_AGENT_EXECUTION_ENABLED`
- `NVIDIA_NIM_EXECUTION_ENABLED`

There is no committed `NVIDIA_NIM_FREE_TIER_VERIFIED_AT` marker. An API key by itself is not proof of zero-cost eligibility. Do not add the verification timestamp or enable planning/execution until the NVIDIA account's free-tier entitlement, exact model ID, quota/rate limits and billing behavior have been independently confirmed.

With inference disabled, the live staging acceptance suite verifies D1 task creation, owner approval, rejection, duplicate delivery, recovery state and the execution lock. It deliberately does not dispatch agents. Live multi-agent execution remains gated on verified zero-cost inference.

## Required GitHub environment configuration

Create/use the GitHub Actions environment named `transactra-staging`.

**Secrets**

| Secret | Required scope / purpose |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Dedicated Cloudflare token with only the staging Worker and staging D1 permissions needed for deploy, migration and D1 query |
| `GITHUB_APP_ID` | Numeric ID of the Transactra GitHub App |
| `GITHUB_APP_INSTALLATION_ID` | Installation ID for the app installation restricted to `KUNDURUHIMANEESHREDDY/transactra` |
| `GITHUB_APP_PRIVATE_KEY` | RSA PEM private key for the GitHub App (PKCS#1 or PKCS#8); stored only as a GitHub environment secret |
| `TELEGRAM_BOT_TOKEN` | Dedicated staging bot token, not the production bot |
| `TELEGRAM_WEBHOOK_SECRET` | Dedicated staging webhook secret |

**Environment variable**

- `TELEGRAM_STAGING_BOT_ID`: numeric Telegram bot ID returned by `getMe`.

Do not use a Global GitHub token, organization-wide token, Cloudflare Global API Key or production Telegram credentials. The staging workflow mints a short-lived installation token with Contents read/write and Actions write permissions, restricted to the `transactra` repository. The Worker independently signs an RS256 App JWT and exchanges it for a fresh repository-scoped installation token per GitHub operation. The App ID, installation ID and private key are installed as Worker secrets; no static PAT or long-lived GitHub token is stored.

## Configure the staging Telegram bot securely

In GitHub, open **Settings → Environments → transactra-staging**.

- **Settings → Environments → transactra-staging → Variables**: add the staging bot ID.
- **Settings → Environments → transactra-staging → Secrets**: add the bot token and webhook secret.

- Under **Variables**, add `TELEGRAM_STAGING_BOT_ID` with the numeric ID returned by Telegram `getMe`. Do not set it to the production bot ID.
- Under **Secrets**, add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`. Keep the token in the GitHub secret store; never paste it into a workflow command, source file, TOML file or shell command argument.
- Also add `CLOUDFLARE_API_TOKEN`, `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID` and `GITHUB_APP_PRIVATE_KEY` as described above. The GitHub App installation must be restricted to this repository and grant Contents read/write plus Actions write.

If you must manually inspect a dedicated staging bot token in a local PowerShell session, use a hidden prompt and pass it through standard input, never a command-line argument:

```powershell
$secureToken = Read-Host "Dedicated staging bot token" -AsSecureString
$token = [System.Net.NetworkCredential]::new("", $secureToken).Password
try {
  $token | pnpm dlx wrangler@4 secret put TELEGRAM_BOT_TOKEN --config infra/cloudflare/wrangler.staging.toml
} finally {
  $token = $null
  $secureToken.Dispose()
}
```

The normal staging workflow provisions Worker secrets from GitHub environment secrets, so this manual command is not needed during routine deployments.

## Local CI runner

Keep the local Windows runner process active in its PowerShell window:

```powershell
cd C:\Users\himan\actions-runner-clean
.\run.cmd
```

The CI and staging workflows use the runner's default labels: `self-hosted`, `Windows`, `X64`. The runner must remain online while jobs are queued or running. The CI workflow executes build/regression tests, Cloudflare migration and inference fail-closed tests, dependency audit, tracked-file secret scan and operational script validation.

## Bootstrap staging

After all six GitHub environment secrets and `TELEGRAM_STAGING_BOT_ID` are configured:

1. Open the repository's **Actions** tab.
2. Select **Transactra Staging Deploy**.
3. Select **Run workflow**, branch `main`, mode `bootstrap`.
4. Approve the `transactra-staging` environment gate if GitHub requests it.
5. Keep the local runner online and wait for the workflow.

The bootstrap sequence validates credentials and staging-only configuration, installs locked dependencies, runs tests/security gates, applies all pending reviewed migrations (through 0015) to staging D1 only, deploys the staging Worker, installs Worker secrets, verifies `/health` and `/ready`, registers the staging Telegram webhook and runs `infra/cloudflare/scripts/staging-acceptance.mjs`.

If a required secret is missing or invalid, preflight stops before remote migrations or Worker deployment. Do not work around a failed preflight by using production credentials.

## Approved staging deployment actions

Transactra's `cloudflare_staging` deploy adapter is a side effect and always requires a separate owner step approval. The approval is bound to the exact action JSON and SHA-256 hash, is single-use, and is consumed before workflow dispatch.

The workflow's `approved_action` mode independently checks that:

- the approval is consumed and belongs to the configured owner;
- the action hash matches the exact stored action JSON;
- the action is a high-risk staging deployment;
- the approval is in the dedicated staging D1 database.

Production D1 IDs are rejected. If a dispatch or deployment outcome is ambiguous, the approval cannot be replayed automatically; the step is held for owner review.

## Live staging acceptance

The bootstrap workflow's acceptance script verifies:

- staging `/health` and D1-native `/ready`;
- signed synthetic Telegram webhook updates;
- task, approval, execution-plan, run and job persistence;
- duplicate Telegram update idempotency;
- task-level approve and reject transitions;
- per-step action inspection, hash mismatch rejection, approval/resume and rejection;
- expiry and recovery state;
- inference remains disabled and no agent step is dispatched.

These are staging D1/Telegram acceptance tests. They do not claim that multi-agent inference or external side effects are live while NVIDIA remains unverified.

## Useful local commands

From the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm test:cloudflare-nim
pnpm audit --audit-level high
node scripts/security-gate.mjs
```

Do not apply staging migrations to the production database. Do not deploy production until staging acceptance, provider verification, multi-agent execution tests and all production security gates pass.


## Memory lifecycle acceptance (migration 0013)

The memory lifecycle migration is additive and must be applied to staging before deploying the updated Worker.

- Apply migrations 0001–0013 to the dedicated staging D1 only; verify /ready reports ready.
- Mem0 is optional. Without MEM0_API_KEY, D1-only memory must still pass all acceptance checks.
- Mem0 remains disabled by default (`MEM0_ENABLED=false`). To test the hosted Mem0 path, first verify the current free-tier limits and disable usage-based billing/automatic upgrades in Mem0. Then set the staging Worker secret with Wrangler's hidden prompt: `pnpm exec wrangler secret put MEM0_API_KEY --config infra/cloudflare/wrangler.staging.toml`. Only after the account check, change `MEM0_ENABLED=true` and set the local addition/retrieval caps at or below the verified free allowances. Never paste the key into source, chat, workflow arguments or logs.
- Verify the account's current free-tier allowances and disable usage-based billing/paid upgrades in Mem0 before adding the secret.
- Use Telegram /remember and /memory-status. Confirm D1 writes succeed, the memory.sync queue event is handled, and the D1 outbox progresses through processing to done only after Mem0's asynchronous event reports SUCCEEDED (when Mem0 is enabled).
- In an isolated test database, seed usage to 70% of either configured monthly allowance and run the Cron handler. Confirm an immutable memory_archives snapshot is created, the active transactra.compacted_summary is replaced, the generation advances, and Mem0 pauses for the rest of the month.
- Confirm previous task/event rows and archives remain intact; expired outbox leases are reclaimed; repeated Telegram update IDs do not create duplicate Mem0 sync rows; and D1 fallback remains available while Mem0 is paused.
- Verify no model inference is used for compaction, no paid fallback is called, and no production database or Worker is changed.

Production rollout remains a separate owner-approved action after staging migration, deployment, Mem0 quota tests and restore checks pass.
