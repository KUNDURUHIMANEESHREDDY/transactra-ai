# Transactra Cloudflare edge runtime

**Status: the existing production task-inbox Worker is deployed; the Telegram-to-existing-planner bridge remains source-only.** Read-only account verification on 2026-11-09 found that production D1 still lacks the pipeline-link columns, the dedicated staging D1 has no application migrations, and no staging Worker is deployed. This is not a completed migration or an AI-agent runtime.

## What this slice provides

- `GET /health`: non-sensitive liveness response.
- `GET /ready`: fail-closed readiness check for required bindings, all seven D1 runtime tables, bridge-link columns, and the HTTPS control-plane `/health/ready` schema contract; returns only ready/not-ready without exposing configuration details.
- Owner-only `/task <description>` and `/tasks` Telegram commands: persist task requests and list the latest ten. New tasks are marked `awaiting_provider`; this is durable intake only, not agent execution.
- `POST /telegram/webhook`: validates Telegram's webhook secret header and refuses ingestion when any owner-reply binding is missing, then queues a validated update.
- Queue consumer: idempotently stores Telegram updates in D1 and sends owner-verified replies through a D1 outbox. It also persists owner `/task` requests and returns their held status.
- Cron trigger: writes a scheduler heartbeat only; it does not claim to run autonomous agents.

No bot token, GitHub credentials, source records, or secret values belong in this directory or Git history.

## Provisioned Cloudflare resources

The Cloudflare API confirmed these resources on 2026-11-09: Worker `transactra-edge` (100% traffic on the current deployment; workers.dev enabled), D1 database `transactra`, queue `transactra-events`, dead-letter queue `transactra-events-dlq`, and a `*/15 * * * *` Cron Trigger. The primary queue has one Worker producer and one consumer. The Worker has D1/queue bindings, an owner-identity binding, Telegram token/webhook secret bindings, and a Workers AI binding named `AI`. Secret values were not read.

The account's billing/plan state has not been verified. Resource existence does not prove the ₹0/no-card requirement; do not claim that constraint is certified.

Current configuration and bindings:

- `wrangler.toml` contains the provisioned D1 database ID and the `transactra-events` producer/consumer configuration.
- The Worker has `TELEGRAM_WEBHOOK_SECRET` and `TELEGRAM_BOT_TOKEN` secret bindings plus the owner-identity binding. Only secret names were inspected; values were not read.
- `wrangler.toml` declares the non-secret `NVIDIA_NIM_MODEL` and `NVIDIA_NIM_TIMEOUT_MS` variables so `wrangler deploy` reconciles them. They previously existed only as dashboard variables, which a config-driven deploy would have silently dropped. `NVIDIA_NIM_API_KEY` stays a Worker secret and is never committed. `NVIDIA_NIM_FREE_TIER_VERIFIED_AT` is intentionally left unset, which keeps the NIM provider fail-closed until the free-tier terms are verified by hand.
- Migrations `0001`–`0004` define event, reply-outbox, heartbeat, task, task-event, task-run, and task-run-event tables. Migration `0008_orchestrator_memory_recovery.sql` adds owner-scoped memory, immutable task-memory snapshots, an orchestration job ledger with leases/retries/dead letters, and orchestration events. The expanded readiness contract requires all eleven tables.
- Do not add a billing method or accept a paid upgrade. Verify the account's free-plan eligibility and quotas before any further deployment or workload expansion.

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

- The deployed production Worker is still `transactra-edge`; this workstream did not deploy a new version or change its webhook, queues, cron or D1. Read-only D1 inspection found one existing task and one run, both `awaiting_provider`, and confirmed that the production `tasks` table has no pipeline-link columns. The dedicated staging D1 contains no application tables, and its queues have no Worker producer/consumer. `/ready` has not been externally smoke-tested.
- The cron handler records a scheduler heartbeat, prunes expired memory, and recovers due orchestrator handoffs using bounded retries and expiring D1 leases. It is not the 48-hour project cycle or a task-execution worker. At 2026-11-09 11:17 IST, D1 contained the expected event/outbox/heartbeat tables, 5 inbound Telegram events, 1 sent reply, and a recent scheduler heartbeat. This is aggregate evidence, not a complete external HTTP acceptance test.
- This Worker does not replace PostgreSQL, Docker, the long-running Node worker, or the code-execution sandbox.
- D1 is not PostgreSQL. A full migration requires a separately reviewed schema/data adapter and verified export of all seven AppDeploy tables.
- AppDeploy remains authoritative and online. Do not switch Telegram webhook ownership or cut over until data parity, auth, retries, restore, and rollback checks pass.
- The task inbox, durable task-run ledger, and Workers AI binding are deployed. Telegram `/task`, `/tasks`, and `/task-status` were externally smoke-tested successfully. The new `/provider` command is ready for a Telegram smoke test. The updated Node test suite has not been executed in this environment. Task runs remain `awaiting_provider`; AI inference is intentionally disabled and no execution consumer is enabled. Before enabling inference, confirm the account is on Workers Free and implement daily usage caps, approval checks, bounded orchestration, and dead-letter replay.


## Inference provider selection (2026-11-09)

- Selected primary provider: Cloudflare Workers AI; model: `@cf/zai-org/glm-4.7-flash`.
- `infra/cloudflare/wrangler.toml` declares the `AI` binding. The Worker exposes `/provider` to report binding availability and the fail-closed state.
- AI execution is deliberately disabled. The Cloudflare connection cannot read the account subscription/plan endpoint (Billing Read permission is unavailable), so Workers Free eligibility cannot be verified from this connection. No inference request has been sent. Do not enable inference or claim ₹0 usage until the account is confirmed on Workers Free in the dashboard.
- On Workers Free, Cloudflare documents 10,000 Neurons/day and says requests fail when the free allocation is exceeded. On Workers Paid, usage beyond that allocation is billable. Never use AI Gateway unified billing, third-party models, a paid plan, or paid fallback for Transactra.
- GLM-4.7-Flash is listed as Free-plan eligible and supports function calling, but the free allocation is capped and can be exhausted by other account workloads.


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