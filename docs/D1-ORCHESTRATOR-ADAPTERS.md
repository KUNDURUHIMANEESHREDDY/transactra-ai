# D1 orchestrator tool adapters

## Execution contract

The Cloudflare D1 dispatcher runs only when both explicit execution flags are enabled and NVIDIA NIM configuration plus the owner-attested zero-cost entitlement timestamp validate. The staging Worker is deliberately configured with planning and execution disabled until the NVIDIA free-tier eligibility and model entitlement are independently verified.

Read-only adapters:

- `web_research`: fixed-host Wikimedia public search. This is a bounded encyclopedia search adapter, not a general web search engine.
- `repository_read`: reads a regular file from the private `KUNDURUHIMANEESHREDDY/transactra` repository on `main`; paths are restricted to source, tests, docs and scripts.
- `data_analysis`: deterministic analysis of prior step evidence only.
- `cloudflare_staging` with `operation: "verify"`: checks the staging Worker `/health` and `/ready` endpoints.

Owner-approved side effects:

- `repository_write`: writes a bounded source-file payload directly to `main`, but only when the owner-approved `expected_sha` still matches the file observed during review (or is `null` for a new file).
- `cloudflare_staging` with `operation: "deploy"`: dispatches the staging deployment workflow on the self-hosted Windows runner.
- `telegram_notify`: sends only to the configured owner chat.

## Step approval lifecycle

1. The task plan is owner-approved.
2. Before a high-risk or side-effect step runs, the dispatcher stores the exact action JSON, SHA-256 hash, owner ID and 24-hour expiry in `orchestrator_step_approvals`.
3. Telegram notifies the owner. Use `/step-approvals` and `/step-approval <approval-id>` to inspect the full action.
4. Approve or reject using the exact hash prefix:
   - `/approve-step <approval-id> <hash-prefix> <reason>`
   - `/reject-step <approval-id> <hash-prefix> <reason>`
5. Approval is consumed once before the adapter runs. Timeouts, provider ambiguity, lease expiry or post-action evaluation failure never trigger automatic replay.
6. A staging deployment dispatch is separately verified by the workflow against the consumed approval row in the staging D1 database. The workflow records acceptance or holds the step for owner review.

## Required staging GitHub environment secrets

Configure these in the GitHub environment named `transactra-staging`:

- `CLOUDFLARE_API_TOKEN`: only the Cloudflare permissions needed for the isolated staging Worker and staging D1 migration/deploy/query.
- `TRANSACTRA_GITHUB_TOKEN`: a fine-grained token restricted to this repository with **Contents: read/write** and **Actions: write**. No organization, administration, or production access.
- `TELEGRAM_BOT_TOKEN`: dedicated staging bot token, not the production bot token.
- `TELEGRAM_WEBHOOK_SECRET`: dedicated staging webhook secret.

Also configure the GitHub environment variable `TELEGRAM_STAGING_BOT_ID` with the dedicated staging bot's numeric ID.

The staging deploy workflow installs the three Worker secrets from those GitHub environment values. The Worker token is never written to the repository or Wrangler TOML.

## Staging deployment modes

- `bootstrap`: an owner manually dispatches the workflow to apply the reviewed migrations, deploy the isolated staging Worker, install secrets, verify readiness, register the staging Telegram webhook and run live acceptance tests.
- `approved_action`: Transactra dispatches the workflow only after a single-use owner approval. The workflow verifies the consumed approval, exact action hash and staging D1 database ID before changing staging.

Both modes run on `[self-hosted, Windows, X64, transactra]`. The workflow has no push trigger. Production Worker configuration, production D1 and production queues are not used.

## Zero-cost inference gate

Do not set `NVIDIA_NIM_FREE_TIER_VERIFIED_AT` or turn on the inference flags merely because an API key exists. First verify the account's actual free-tier eligibility, the exact model ID, quota/rate limits and billing behavior. Until then, leave all planning and execution flags false. The current staging configuration intentionally does so.
