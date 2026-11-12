# Transactra Cloudflare edge runtime

**Current status (2026-11-12): expanded agent runtime and integrations are source-only; production cutover is not complete.** A live Cloudflare account check returned HTTP 404 for the intended `transactra-edge` Worker. The deployed `transactra-telegram` Worker exists, but its `DB` binding points to the `cloudpilot-staging` D1 database (`e7292f55-c90e-4d34-8b77-c97c3e5ec15a`) and its inspected bindings do not include the `transactra-events` Queue. It has Telegram token/webhook secrets and the owner identity. Do not treat this Worker as a production-ready Transactra execution runtime: it is connected to the staging database.

The intended production D1 database `transactra` (`faf1f8b5-e029-4598-9fb0-c3cb1106d311`) and queues `transactra-events` / `transactra-events-dlq` exist. The repository's `wrangler.toml` targets a new `transactra-edge` Worker with those production resources, but that Worker has not been deployed. The staging and production release workflows remain separate and gated. No Telegram webhook was changed by this source work.

## Current source capabilities (not yet live)

- Owner Telegram intake accepts `/task` and `/goal`, plus imperative natural-language objectives, and persists them in the D1-native planner.
- All ten exact Node workforce catalogue IDs are recognized by the planner/runtime, with five edge-specialist roles added. Role-specific tool grants are enforced at plan validation and execution. This mirrors the Node catalogue; it does not prove a separate long-running Node service is deployed.
- Read-only tools include Tavily/Wikimedia research, owner-scoped Mem0/D1 memory search, GitHub issue/PR/Actions inspection, repository reads, Cloudflare Worker/Queue/D1 observation, bounded data analysis and isolated code verification. Approved memory writes persist to D1 and enqueue Mem0 synchronization.
- Owner-approved side effects include GitHub issue creation, restricted source writes, owner notifications and payment preparation through the existing Financial Policy API. Payments still require a separate policy challenge, PayPal buyer authorization and explicit capture command.
- Approved task/step decisions enqueue durable `orchestrator.dispatch` messages. Cron remains the recovery backstop. D1 leases, immutable approval hashes, per-agent ledgers and evaluator evidence guard execution.
- Successful tasks persist an evidence-backed report in `task_events`, enqueue it through a lease-protected Telegram outbox, and support `/report <task-id>`.
- Dynamic Worker code verification uses a Worker Loader binding, `globalOutbound: null`, no injected secrets/bindings, a 10 ms CPU cap, zero subrequests and a five-second wall limit.

No bot token, GitHub credentials, source records, or secret values belong in this directory or Git history.

## Cloudflare resources verified on 2026-11-12

- Worker `transactra-edge`: absent (direct API lookup returned 404).
- Worker `transactra-telegram`: present; D1 binding points to `cloudpilot-staging`; no Queue binding was present in the inspected settings; Telegram secret names were visible but values were not read.
- D1 databases: `transactra`, `cloudpilot-staging`, `cloudpilot`, a restore-rehearsal database, and the newly provisioned dedicated `transactra-staging` database (`312d97f4-47b4-4084-84d5-21c5fe9c5538`).
- Queues: production `transactra-events` / `transactra-events-dlq`, newly provisioned staging `transactra-events-staging` / `transactra-events-dlq-staging`, plus separate CloudPilot queues.
- Cloudflare account billing/plan state and Dynamic Worker Loader eligibility have not been verified. Do not add a billing method or accept a paid upgrade to satisfy a runtime prerequisite.

The Worker Loader binding is declared in both Wrangler configurations. Runtime sandbox availability still requires a successful isolated staging deployment and health/acceptance test. Optional tool credentials are deliberately fail-closed and must be configured separately.


## Local verification and deployment

From the repository root:

```sh
npx wrangler --version
npx wrangler d1 migrations apply transactra --local
npx wrangler dev --config infra/cloudflare/wrangler.toml
```

For an intentionally authorized future deployment after code review and runtime verification:

```sh
npx wrangler d1 migrations apply transactra --remote --config infra/cloudflare/wrangler.toml
npx wrangler deploy --config infra/cloudflare/wrangler.toml
```

Never put secret values in command-line arguments, shell history, CI logs, or committed files. Use Wrangler's interactive secret prompt or the Cloudflare dashboard.

## Important limitations

- The deployed `transactra-telegram` Worker is bound to the `cloudpilot-staging` D1 database and has no inspected `transactra-events` Queue binding. The intended `transactra-edge` Worker is absent. This workstream did not change either Worker, the Telegram webhook, queues, Cron or D1. The production `transactra` D1 database and queues exist, but the new migration sequence has not been applied there. `/ready` has not been externally smoke-tested against the intended edge Worker.
- The source Cron handler records a scheduler heartbeat, expires stale memory, reconciles approved D1-native jobs and retries pending Telegram outbox rows. Approved task/step decisions also enqueue `orchestrator.dispatch` for immediate processing. Neither path is live until the intended Worker is deployed with the correct production bindings and secrets.
- The D1-native edge runtime does not replace the separate PostgreSQL-backed Node API/worker host. The bounded Dynamic Worker sandbox is source-configured, but requires a Loader binding and successful staging validation; it is not a Docker or general build environment.
- D1 is not PostgreSQL. A full migration requires a separately reviewed schema/data adapter and verified export of all seven AppDeploy tables.
- AppDeploy remains authoritative and online. Do not switch Telegram webhook ownership or cut over until data parity, auth, retries, restore, and rollback checks pass.
- The new D1-native agent planner, tool adapters, report outbox, and queue dispatch are source-only. The Cloudflare account has a separate `transactra-telegram` script bound to staging D1, while `transactra-edge` is absent. No production Telegram acceptance test has been run against this code. The owner approval, exact-action hash, verified zero-cost inference, and step-evaluator gates remain mandatory.


## Inference provider selection (2026-11-12)

- The current D1-native agent path uses the pinned NVIDIA NIM model through the CloudPilot edge inference gateway. The CloudPilot endpoint is fixed to `https://cloudpilot-edge.himaneeshreddyk.workers.dev/chat/completions`; redirects and alternate hosts are rejected.
- `NVIDIA_NIM_API_KEY` and `CLOUDPILOT_INFERENCE_SECRET` are runtime secrets only. The NIM free-tier entitlement must be independently verified and current; a key alone does not enable inference.
- Model planning and agent execution have separate explicit flags. Owner runtime OFF, missing NIM attestation, missing provider secrets or a non-zero cost estimate blocks inference before external execution.
- The old Workers AI `AI` binding and GLM-4.7-Flash selection are historical configuration, not proof of the active planner provider. Do not enable a paid provider, billing fallback, or paid account upgrade.


## Telegram task-planner bridge — prepared, not deployed

The repository now contains a source-level bridge from owner Telegram `/task` messages to the existing authenticated Node control plane:

- The Worker stores the Telegram task, D1 event and D1 execution-ledger rows first, then hands the request to `POST /v1/telegram/tasks` using the Telegram update ID as an idempotency key.
- The Node API persists the corresponding existing PostgreSQL task in `waiting_approval` and creates the owner approval in the same database transaction. The normal task worker cannot claim it while it is waiting.
- Telegram `/approve <approval-id> <reason>` and `/reject <approval-id> <reason>` call the existing approval decision API with the separate approval credential. Approval resumes the existing task; rejection stops it.
- The D1 migration `0006_pipeline_bridge.sql` is additive and adds only pipeline linkage metadata. It does not drop, rewrite, export, or delete existing D1 events/tasks/runs. Migration `0007_task_lifecycle_states.sql` rebuilds task/run/event tables to widen lifecycle checks while copying existing IDs and events; its migration test must pass before it is applied anywhere.
- `wrangler.staging.toml` names a separate staging Worker, D1 database and queues. It deliberately has no AI binding and contains no production D1 ID or production queue names.

**This is committed source code, not a verified live integration.** The existing Node control plane has no verified reachable HTTPS URL or live PostgreSQL-backed worker endpoint in the connected environment. The Cloudflare account's Free plan/no-card status is also not verified. Do not set the new Worker secrets, apply a remote migration, deploy staging, register a webhook, or deploy production until those prerequisites and the staging runbook gates pass. The currently deployed production Worker version is unchanged by these source commits.

See [STAGING.md](STAGING.md) for the isolated staging procedure and acceptance gates.

## Durable orchestrator and memory foundation (source committed; not deployed)

- Telegram owner commands: `/remember <key> <value>`, `/memory`, `/forget <key>`, and `/orchestrator`.
- Memory is owner-scoped in D1. New tasks snapshot up to 20 current memory entries into `task_memory`; that bounded context is passed to the existing control plane as part of the task objective. Historical snapshots remain attached to their original tasks even if a live memory key is later deleted.
- Each accepted task creates one idempotent `orchestrator_jobs` row and append-only orchestration events. A scheduler lease prevents two recoverers from claiming the same due job at once.
- Failed planner handoffs retry with bounded exponential backoff; exhausted jobs enter `dead_letter`. Expired leases can be reclaimed after Worker interruption.
- The recovery scheduler only creates/links tasks in the existing planner. It does not execute tasks, approve work, call an AI provider, or bypass the separate approval credential.
- D1 migration `0008_orchestrator_memory_recovery.sql` is additive. Apply and verify it in isolated staging before any production migration or deployment. Existing production Worker and D1 were not changed by this source commit.

## CloudPilot-backed agent orchestration (2026-11-12)

- `cloudpilot.mjs` is the shared, fail-closed inference client for Telegram replies, task planning, specialist-agent reasoning and result evaluation. It uses only `https://cloudpilot-edge.himaneeshreddyk.workers.dev/chat/completions`; redirects and alternate hosts are rejected.
- Configure `CLOUDPILOT_INFERENCE_SECRET` as a Cloudflare Worker secret. It must match the secret accepted by `cloudpilot-edge` (`TRANSACTRA_INFERENCE_SECRET`). Never put either secret in Wrangler TOML, source code, logs or task memory.
- Requests require an exact INR 0 estimate, have an 8 KB combined prompt ceiling and a 512-token output ceiling. CloudPilot responses are accepted only when the returned model and token-usage fields are valid.
- Planning and execution retain the NVIDIA Developer Program attestation, owner runtime switch and INR 0 controls. Agent execution also requires the CloudPilot secret. Missing or invalid CloudPilot configuration blocks execution; there is no silent provider fallback.
- Existing tool authorization remains independent of the model: tool inputs are validated, repository writes and other side effects require single-use owner approval bound to the exact action hash, ambiguous outcomes are never replayed, and task completion requires accepted evaluator evidence.
- **Capability boundary:** the active D1-native edge runtime currently exposes bounded research, evidence analysis, repository read/write, owner Telegram notification and staging verification/deployment adapters. The repository's separate Node workforce has a broader dynamic agent registry and additional GitHub, research, sandbox, operations, security and evolution capabilities, but the production Telegram D1-native path is not yet connected to that Node control plane. Do not describe email, general browser automation, calendar or arbitrary third-party actions as live until their adapters and runtime connection are implemented and verified.


## Production D1 encrypted backup (GitHub Actions)

The manual workflow `Transactra Production D1 Backup` exports the fixed production D1 database read-only, encrypts the SQL dump with AES-256-GCM (key derived using scrypt), records plaintext and ciphertext SHA-256 hashes, and uploads only the encrypted dump plus manifest as a private GitHub Actions artifact. Artifact retention is 30 days; this is a short-retention recovery copy, not permanent archival storage.

### One-time GitHub setup

In repository Settings → Environments → `transactra-production`, configure:

- `CLOUDFLARE_API_TOKEN`: a Cloudflare API token restricted to the production D1 database and D1 read/export permissions required by Wrangler. Do not use a Global API Key or broad account token.
- `D1_BACKUP_ENCRYPTION_PASSPHRASE`: a randomly generated secret of at least 32 characters. Store it only as an environment secret. Keep an independently secured recovery copy outside GitHub; losing it makes encrypted artifacts unrecoverable.

Keep required reviewers and the `main`-only deployment branch rule on this environment. The workflow does not create resources, run migrations, deploy a Worker, modify queues, or change Telegram webhooks. It runs only from `main` after the operator types `BACKUP` and passes the protected environment approval.

### Run and verify

1. Open Actions → **Transactra Production D1 Backup** → Run workflow on `main`; type `BACKUP`.
2. Approve the protected `transactra-production` environment when prompted.
3. Confirm the run uploaded `transactra-production-d1-backup-<run-id>` and inspect the manifest hashes.
4. Download the artifact only to a trusted machine. Verify the encrypted SHA-256, decrypt with the protected passphrase using `node scripts/d1-backup-crypto.mjs decrypt production.sql.enc production.sql <plaintext-sha256-from-manifest>`, then verify the SQL file and record its schema/table/row-count inventory.
5. **Do not import into production or the existing `transactra-staging` database.** The isolated restore rehearsal requires a separately provisioned, empty disposable D1 database with a dedicated restore-only token and an independently protected restore passphrase. Confirm that the target database is within the Cloudflare Free quota before creating it. Restore into that empty target, compare schema and row counts with the dump manifest, then delete the disposable target after recording the result.

### Limitations and status

- GitHub Actions artifacts expire after 30 days and are subject to repository artifact storage limits. They are not a permanent backup tier and do not replace a durable off-site backup.
- Artifact access is limited to repository users with Actions access, but encryption remains mandatory because artifacts contain production data.
- The backup workflow is implemented; a live encrypted backup, checksum verification, and isolated restore have **not** yet been executed. Do not mark the backup/restore production gate complete until the restore rehearsal succeeds.
- If GitHub artifact retention/storage is insufficient, do not enable Cloudflare R2 by adding a payment card. Pause and choose another explicitly approved no-cost storage destination.


## Mem0-backed memory lifecycle (source committed; migration/deployment pending)

- D1 remains the canonical source for owner memory, immutable task snapshots, execution/task/orchestrator events, compacted snapshots and retry state.
- Mem0 Platform is an optional semantic retrieval index. It is fail-closed: both MEM0_ENABLED=true and the MEM0_API_KEY Worker secret are required before any Mem0 API request. Both Wrangler configs default MEM0_ENABLED=false. The Worker calls the documented V3 add/search API using Authorization: Token ...; its API key is supplied only as the MEM0_API_KEY Worker secret.
- Default local quota guards: 10,000 monthly additions, 1,000 monthly retrievals, and compaction at 70% of either allowance. These are configurable conservative defaults, not a guarantee of the current Mem0 plan; verify the account dashboard before enabling the secret.
- /remember writes to D1 first, records a durable sync-outbox item, and dispatches memory.sync through Cloudflare Queues. Mem0 add responses are asynchronous: the outbox stores the provider event ID and is marked done only after the event endpoint reports SUCCEEDED. A 15-minute Cron polls pending events and retries failed/pending outbox rows with bounded backoff and a dead-letter state.
- D1-native task planning searches only the active Mem0 generation and merges those results with owner-scoped D1 memory. If Mem0 is not configured, unavailable, or reaches its threshold, planning falls back to D1.
- At threshold, the Worker creates an immutable summary archive from durable D1 facts and execution records, updates the active summary, advances the Mem0 generation, and pauses further Mem0 requests for the month. D1 remains available throughout.
- Compaction never deletes D1 task history, event history, or prior archives. Old Mem0 generations are no longer queried; automatic deletion is intentionally omitted because Mem0 deletion is asynchronous.
- The compaction digest is deterministic and grounded in persisted records. It does not call an LLM, Workers AI or a paid inference provider.
- Migration 0013 adds quota accounting, compaction state, immutable archives and the retryable sync outbox. It is not yet applied to staging or production by this source commit. Do not deploy this Worker version until staging has applied migrations 0001–0013 and all acceptance tests pass.

### One-time Mem0 setup

1. Create/verify a Mem0 Platform free account and check the exact current monthly add/retrieval allowance.
2. Add the API key as a Worker secret named MEM0_API_KEY in the staging environment first (for example, run pnpm exec wrangler secret put MEM0_API_KEY --config infra/cloudflare/wrangler.staging.toml and paste it only into Wrangler's hidden prompt); never add it to wrangler.toml, GitHub source, logs or Telegram.
3. Keep MEM0_ENABLED=false until the Mem0 account dashboard confirms the actual free monthly limits and paid usage/automatic upgrades are disabled. Only then change MEM0_ENABLED=true in the staging config and set the two quota limits at or below the confirmed free allowances.
4. Verify MEM0_MONTHLY_ADDITION_LIMIT, MEM0_MONTHLY_RETRIEVAL_LIMIT and MEM0_COMPACTION_THRESHOLD_PERCENT against the account's actual plan. The committed defaults are 10000, 1000 and 70 respectively.
5. Confirm usage-based billing and paid upgrades are disabled in the Mem0 account. The Worker itself never enables billing or upgrades.
6. Run /memory-status, /remember, /memory, and the staging compaction acceptance test. Production remains untouched until staging passes.