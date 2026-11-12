# Production release gates

Transactra production releases are deliberately manual and approval-gated. A green build alone is not production authorization.

## Automated gates

The pull-request CI workflow runs:
- TypeScript build and unit/regression tests, including workforce planner, coordinator, approval and persisted-plan recovery coverage.
- Cloudflare migration, Worker, D1-native planner and NVIDIA inference fail-closed tests.
- pnpm dependency audit (high and critical findings fail).
- Tracked-file secret-pattern scan (secret values are never printed).
- Operational shell-script syntax checks.

The production workflow repeats build, tests, dependency audit and secret scan on `main`, then requires both staging `/health` and `/ready` endpoints to report healthy before production approval can be requested.

## Planner architecture

- Staging and the current production Worker configuration use `TRANSACTRA_PLANNER_MODE=d1-native`. D1 stores tasks, draft plans, owner-scoped expiring approvals, task/run events, memory snapshots and orchestrator jobs.
- D1-native `/ready` validates the local D1 schema and Telegram bindings; it does not depend on a Node/PostgreSQL control-plane endpoint or pipeline credentials.
- `/task`, `/approvals`, `/approve` and `/reject` use the D1-native path. Approval decisions are guarded and persisted in a D1 batch.
- An approved task remains blocked until the separate inference and agent-execution gates are enabled. Planning is configured for NVIDIA NIM only when its current zero-cost entitlement marker, key and model are valid; deterministic fallback remains a non-executing draft.
- Production D1-native parity is not yet accepted end to end. Do not infer live Telegram ingress or live NVIDIA inference from configuration or staging acceptance.

## Approved-task-to-agent-step lifecycle gate

Migration `0015_orchestrator_step_evidence.sql` adds a durable evaluator record to each agent-step ledger row. A step is eligible for task completion only when:
- its ledger state is `succeeded`;
- its result text is non-empty; and
- its persisted evaluator JSON has `decision=accepted`, `accepted=true`, and a non-empty rationale.

A successful model response or an accepted GitHub Actions dispatch is not completion evidence. The staging deployment adapter reports `dispatched`; the staging workflow records `succeeded` plus accepted evidence only after deployment, migration, health/readiness and acceptance checks pass. The scheduled dispatcher then finalizes the task from the durable ledger. Ambiguous side-effect outcomes remain in owner review and are not automatically replayed.

Required validation before execution can be enabled:
- Exercise task approval, plan approval, dependency ordering, per-step hash approval, rejection, expiry and owner-only access.
- Verify lease claims are conditional and duplicate scheduler invocations cannot claim the same job/step.
- Force expired step leases and transport/provider ambiguity; prove side effects are not replayed without fresh owner authorization.
- Prove model output without evaluator acceptance cannot complete a step or task.
- Run controlled inference tests against isolated staging D1 only after the owner verifies the provider's zero-cost entitlement and supplies staging-only secrets.
- Keep production agent execution and inference protected by multi-layer runtime gates: D1 dynamic runtime switch (`nvidia_runtime_control`), owner task approval, immutable per-step hash approvals, and persistent evaluator evidence (`0015`). While `wrangler.toml` declares execution flags enabled for production readiness, autonomous side-effects remain strictly blocked until explicitly authorized by the owner. Staging keeps execution flags permanently disabled.


## Required GitHub configuration

### `transactra-staging`
- Secret: `CLOUDFLARE_API_TOKEN`, scoped to staging Worker, D1 and queue resources only.
- Staging URL: `https://transactra-edge-staging.himaneeshreddyk.workers.dev`.
- Environment secrets: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` for a dedicated staging bot. The staging workflow installs these as Cloudflare Worker secrets after deploying the Worker; `TELEGRAM_OWNER_ID` is already a non-secret staging var.

### `transactra-production`
- Secret: `CLOUDFLARE_API_TOKEN`, production-scoped for D1 migrations.
- Secret: `CLOUDFLARE_WORKERS_DEPLOY_TOKEN`, separately scoped to the Transactra production account with the exact Cloudflare API token permission **Workers Scripts Write**. Wrangler's `whoami` success proves token identity only; it does not prove that the versions-upload permission is granted.
- Production URL: `https://transactra-edge.himaneeshreddyk.workers.dev`.
- Configure required reviewers / deployment protection rules and restrict deployment branches to `main`.

The workflow cannot create GitHub Environment protection rules or secrets. Production remains blocked until the environment is configured.

## Release procedure

1. Merge workforce hardening and release-gate changes only after CI passes.
2. Deploy staging manually and verify migrations, Telegram task intake, task creation, approval/rejection, duplicate webhook idempotency, approval expiry, queue retry, persisted recovery and live readiness.
3. Verify production environment reviewers and production-scoped secrets.
4. Verify Cloudflare Free plan and quota headroom in the dashboard.
5. Run **Transactra Production Deploy** from `main`; type `DEPLOY`.
6. The workflow reruns CI/security gates and checks staging health/readiness.
7. GitHub pauses at the protected `transactra-production` environment for human approval.
8. Only after approval do production D1 migrations and Worker deployment run; health/readiness are checked again.

Any failed gate stops the workflow. No production deployment is run by push, PR merge or staging deployment.

## Safety invariants

- Cloudflare Free / ₹0 spend ceiling remains mandatory; no paid service is provisioned by these workflows.
- Production NVIDIA planning is configured with an owner-provided free-tier verification timestamp and a secret API key. Production execution flags (`TRANSACTRA_AGENT_EXECUTION_ENABLED=true` and `NVIDIA_NIM_EXECUTION_ENABLED=true`) are activated for production release, but live tool execution and inference remain gated at runtime by owner approval, immutable per-step action hashes, persistent evaluator evidence (`0015`), and the D1 `nvidia_runtime_control` switch. Staging execution flags remain `false`. No paid fallback is configured.

- Production Worker, D1 database and queues are not touched by CI or staging deployment.
- Production deploy requires typed dispatch confirmation and GitHub Environment approval.
- A post-deploy readiness failure is a release incident; use the reviewed rollback procedure and investigate before retrying.

## Verified deployment history — 2026-11-09

### Existing staging deployment

The first credentialed staging deployment completed its build, workforce, security and regression gates, applied migrations `0001` through `0008`, and deployed the isolated staging Worker. Evidence: [GitHub Actions run #42638806867](https://github.com/KUNDURUHIMANEESHREDDY/transactra/actions/runs/42638806867), attempt 2.

- Staging D1: `transactra-staging` (`e7292f55-c90e-4d34-8b77-c97c3e5ec15a`).
- Staging Worker: `transactra-edge-staging`, version `19112bf2-8b25-4655-a5b8-83421abbeb17`.
- `/health` passed; `/ready` returned HTTP 503 because the prior transitional bridge required external pipeline dependencies.
- No production resource was changed.

### D1-native planner implementation

PR #13 merged the D1-native task planner and approval workflow. Its PR CI and post-merge `main` CI passed, including build/regression, Cloudflare tests, dependency audit, secret scan and operational shell checks. Evidence: [PR #13](https://github.com/KUNDURUHIMANEESHREDDY/transactra/pull/13), [PR CI run #42641853299](https://github.com/KUNDURUHIMANEESHREDDY/transactra/actions/runs/42641853299), [main CI run #42642050505](https://github.com/KUNDURUHIMANEESHREDDY/transactra/actions/runs/42642050505).

The D1-native code and migration `0009_d1_native_approvals.sql` are deployed to staging. The staging deployment and live Telegram acceptance passed on 9 November 2026; the exact evidence is recorded below.

### Staging acceptance completed

The manual **Transactra Staging Deploy** workflow [#42662283098](https://github.com/KUNDURUHIMANEESHREDDY/transactra/actions/runs/42662283098), attempt 2, completed all 14 deployment and acceptance steps successfully on source head `db322b1fa97abdf7f1a61892eacbc5cb20937671`. That source is 60 commits ahead of (and descends from) the D1-native planner merge commit `e97b80103b2c7d97d04a090763de281a8044ab69` for PR #13.

Observed evidence:
- Staging D1 migration history contains `0001_initial.sql` through `0010_orchestrator_step_runs.sql`; migrations 0009 and 0010 are present.
- The staging Worker deployment reached 100% on version `c1a4925a-cbdf-4cad-b717-41e958892af3` (deployment `41989f27-6c13-4bb7-accb-918f0c958a7e`, 2026-11-09 17:28:27 UTC).
- Deployed bindings identify `TRANSACTRA_ENV=staging`, `TRANSACTRA_PLANNER_MODE=d1-native`, staging D1 `e7292f55-c90e-4d34-8b77-c97c3e5ec15a`, and queue `transactra-events-staging`. Dedicated Telegram secret bindings are present; their values were not read.
- The workflow reported `/health` HTTP 200 and `/ready` HTTP 200 with `ready=true`, `planner=d1-native`, and `inference=disabled`.
- The dedicated staging Telegram webhook was registered and verified.
- The live acceptance step reported `STAGING_ACCEPTANCE_OK`: task creation, owner approval, rejection, duplicate-delivery recovery, D1 persistence and the execution lock were verified. Synthetic acceptance messages were delivered to the staging Telegram chat; no inference or production resource was used.
- The workflow's D1 migration step reported `No migrations to apply`; a separate read-only D1 migration-history query confirmed 0009 and 0010 are applied. That query returned `changed_db=false` and `rows_written=0`.

The initial preflight failure was corrected by configuring the dedicated staging bot ID. It is superseded by the successful second attempt above. Staging acceptance is complete for the tested source/version; repeat it after any relevant Worker or migration change.

The old external Node/PostgreSQL planner endpoint and staging pipeline API/approval credentials are no longer prerequisites for the D1-native staging mode.

Do not use the previously exposed production Telegram bot token. Rotate it through BotFather before production Telegram traffic is re-enabled.

## Remaining production blockers

- Production remains on the legacy planner bridge; staging D1-native acceptance does not authorize a production cutover. Require a separate parity review, explicit owner approval, and a tested rollback path.
- The previously exposed production Telegram credential must be revoked/rotated through BotFather and the replacement stored only in the protected production secret store.
- The `transactra-production` environment still needs required reviewers/deployment protection, main-only deployment restriction, and its own least-privilege Cloudflare token.
- Cloudflare Free/no-card eligibility and current quota headroom must be verified in the dashboard; the API connection cannot independently attest billing state.
- Durable off-database backup and isolated restore remain incomplete. The current encrypted Actions artifact is retained for 30 days and is not permanent archival storage; R2 is not enabled on the account.
- The production D1 backup workflow's current push-triggered run had zero jobs; no production export or restore is claimed. A manual protected-environment dispatch with the required secrets is still required.

Production remains blocked until every staging and production requirement above is satisfied. NVIDIA inference remains disabled until its zero-cost entitlement is independently verified.



## Production checkpoint — 10 November 2026

Read-only Cloudflare inspection confirmed that the production Worker `transactra-edge` has deployed versions and production bindings for D1, Queue, Telegram secrets and NVIDIA NIM. Its current configuration reports `TRANSACTRA_PLANNER_MODE=d1-native`, `NVIDIA_NIM_PLANNING_ENABLED=true`, and both agent/NVIDIA execution flags false. The production D1 schema includes the orchestrator and approval tables. These facts do not prove the Telegram webhook is currently delivering new updates or that NVIDIA inference succeeds.

GitHub production deploy run [#42766418570](https://github.com/KUNDURUHIMANEESHREDDY/transactra/actions/runs/42766418570) passed CI, resource identity checks and D1 migrations (no pending migrations at that revision), then failed at Wrangler's POST to `/workers/scripts/transactra-edge/versions` with `No access to the specified resource`. The API specification identifies **Workers Scripts Write** as the permission accepted by that upload endpoint. The deployment token authenticated and identified the expected account, but that does not establish that it has this write permission.

The Telegram archive contains historical bot replies, but the current production D1 event ledger does not contain matching recent update IDs from those archived messages. Therefore current Telegram ingress is not accepted as live. A harmless live command and matching new D1 event/outbox record are still required. NVIDIA quota records currently show no settled inference usage; no live inference success is claimed.

Migration `0012_telegram_business_message_outbox.sql` and Worker support for Telegram `business_message` updates were added on main, including persistence of the `business_connection_id` for idempotent replies. The migration and new Worker code have not yet been deployed to production.


## Memory and database release gate — migration 0013

Before production rollout of the Mem0/D1 memory lifecycle:

- Apply migration 0013 to the isolated staging D1 and deploy only the staging Worker.
- Verify D1 readiness, owner-scoped memory writes/search, immutable task snapshots, archive creation, compaction idempotency, outbox retry/lease recovery and D1 fallback.
- If Mem0 Platform is enabled, verify the actual account free allowance and confirm usage-based billing/paid upgrades are disabled. Store MEM0_API_KEY only as a Worker secret.
- Keep MEM0_ENABLED=false by default. Require both owner verification of the free-tier allowance and the MEM0_API_KEY secret before changing it to true; otherwise production must remain D1-only.
- Trigger a controlled 70% threshold test in staging. The archive must be committed before the active summary changes; prior D1 events and archives must remain readable.
- Confirm Mem0 is paused after threshold/429/402 and D1 continues serving memory. Verify no paid model or fallback is called.
- Run an isolated D1 backup/restore rehearsal that includes memory_usage_monthly, memory_compaction_state, memory_archives and memory_sync_outbox.
- Production remains untouched until all checks pass and the owner explicitly approves the production migration/deployment.

## Autonomous-execution validation checkpoint — 10 November 2026

Local verification on main (5c76f6e) passed: pnpm test 126/126, pnpm test:cloudflare-nim 93/93, and the tracked-file secret scan (192 files). Coverage includes task/plan approval, exact action-hash approval, approved-step resume, rejected-step terminality under duplicate scheduler calls, expired leases, ambiguous side-effect non-replay, duplicate finalization, and evidence-gated completion.

Live staging acceptance is still blocked, not signed off. Read-only checks show staging /health and /ready are healthy, but the staging D1 remains at migration 0010; current source includes migrations through 0015. The latest staging workflow run #42872833081 failed at Telegram getMe with HTTP 401 before any migration or Worker deployment. The staging GitHub environment also lacks TRANSACTRA_GITHUB_TOKEN; preserve the no-PAT policy and use GitHub App installation-token authorization for runtime GitHub actions.

Do not enable NVIDIA inference or agent execution, and do not request production-readiness sign-off, until staging credentials are repaired, the current migrations and Worker are deployed to the isolated staging resources, and the full live acceptance evidence is recorded. Production D1, Worker, queues and credentials remain out of scope for this validation.
## Post-checkpoint production observation — 11 November 2026

A separate manually dispatched workflow [#42948352694](https://github.com/KUNDURUHIMANEESHREDDY/transactra/actions/runs/42948352694) completed successfully at 2026-11-11 02:50 UTC on `5c76f6e`. It applied production migrations through `0015_orchestrator_step_evidence.sql` and deployed production Worker version `0028ac64-ee0b-4843-9759-b9639c43f896` at 100% traffic. This was not initiated by the staging-validation work.

Read-only inspection after that deployment found `TRANSACTRA_AGENT_EXECUTION_ENABLED=true`, `NVIDIA_NIM_EXECUTION_ENABLED=true`, the D1 NVIDIA runtime-control row enabled, and `/ready` reporting NVIDIA runtime ready. Mem0 also reported authenticated. These are live configuration/readiness facts, not proof of successful live inference or completed agent execution.

At inspection time production D1 had one task in `awaiting_provider` and zero task approvals, execution plans, orchestrator jobs, step approvals or step runs; no eligible approved dispatch candidate was present. Production was not used for this acceptance test. This supersedes earlier checkpoint text that expected production execution flags to remain disabled. Staging acceptance remains blocked; obtain the owner's explicit decision before changing the production runtime kill switch.

## Staging GitHub App authentication update — 11 November 2026

Transactra's staging Worker no longer uses a static GitHub PAT. It creates an RS256 JWT from the GitHub App private key and exchanges it for a short-lived installation token restricted to `KUNDURUHIMANEESHREDDY/transactra`, requiring Contents:write and Actions:write. The staging workflow uses the GitHub App token action for its own workflow dispatch permission. The Worker stores only the App ID, installation ID and private key as Cloudflare secrets; installation tokens are minted on demand.

Local verification passed: 126/126 application tests, 94/94 Cloudflare/D1 tests, dependency audit, 192-file secret scan and diff whitespace checks. This does not constitute a live App credential exchange or staging acceptance.

**Outstanding staging gates:**
- Configure the GitHub Actions `transactra-staging` environment with `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, and `GITHUB_APP_PRIVATE_KEY`; the App must be installed only on this repository with Contents read/write and Actions write.
- Replace the invalid dedicated staging `TELEGRAM_BOT_TOKEN` (last `getMe` result HTTP 401) with a freshly issued token for bot ID `9244087401`. Store it only in the GitHub environment secret; do not use the production bot token.
- Rerun the staging bootstrap. It must apply migrations 0011–0015 to staging D1 only, deploy the matching Worker, install secrets, verify health/readiness, register the staging webhook and pass the complete live acceptance suite.
- Capture workflow, migration-history, readiness, Telegram task/approval, scheduler recovery and persisted evidence outputs. Review them before any production-readiness decision.

No staging or production resource was mutated by this implementation checkpoint. Production execution configuration was already observed enabled in the separate 11 November production observation; this work did not toggle it. Keep production out of the staging acceptance path.
