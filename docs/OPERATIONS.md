# Operations and recovery runbook

## Current status
This is the target runbook. Provider health persistence and agent execution-reliability metrics are implemented in code. Encrypted PostgreSQL backup/restore scripts and an Nginx ingress template are committed, but backups are not scheduled, no real restore drill has run, and ingress is not deployed. A dedicated Linux worker installer and hardened systemd unit files are committed, but the registered remote machine is offline and no Linux host has been provisioned. Persistent production workers and alert delivery remain unverified; do not treat these procedures as evidence of deployed operations.

## Dedicated Linux worker installation
Follow [the dedicated Linux worker runbook](../infra/worker/README.md). The installer is committed but has not been run because the registered remote machine is offline. It requires a committed dependency lockfile and secure host configuration before it can apply migrations or start services.

## Services and start order

Run the migration service first, then the control plane, then the worker, then the scheduler. The Telegram and WhatsApp transports start at any point after the migration and are independent of each other; a channel outage never blocks another channel or the control plane.

| Service | Script | Required environment |
|---|---|---|
| Migrations | `npm run db:migrate` | `DATABASE_URL` |
| Control plane (API + dashboard) | `npm run dev:api` / `npm run start:api` | `DATABASE_URL`, `CONTROL_PLANE_API_TOKEN`, `CONTROL_PLANE_APPROVAL_TOKEN`, `TRANSACTRA_OWNER_ID` |
| Worker (agents, tools, evolution, deployments, notifications) | `npm run start:worker` | `DATABASE_URL`, `TRANSACTRA_OWNER_ID`, provider and GitHub credentials, plus `TRANSACTRA_SANDBOX_IMAGE` (a digest-pinned image), optional `TRANSACTRA_WORKER_ID`, `TRANSACTRA_DOCKER_BINARY` and `TRANSACTRA_EVOLUTION_REPOSITORY` |
| Scheduler (durable jobs + organisation cycle) | `npm run start:scheduler` | `DATABASE_URL`, `TRANSACTRA_OWNER_ID`, `TRANSACTRA_CYCLE_INTERVAL_MS` |
| Production Telegram ingress | Cloudflare Worker `transactra-edge` webhook and `transactra-events` Queue | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_OWNER_ID` in Cloudflare production only; legacy long polling is disabled |
| WhatsApp transport | `npm run start:whatsapp` | `DATABASE_URL`, `TRANSACTRA_OWNER_ID`, `CONTROL_PLANE_URL`, `CONTROL_PLANE_API_TOKEN`, `CONTROL_PLANE_APPROVAL_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_GRAPH_API_VERSION`, `WHATSAPP_ALLOWED_USERS`, optional `WHATSAPP_PORT` and `WHATSAPP_WEBHOOK_PATH` |

Each start script rebuilds first (`npm run build`), and `HOST`/`PORT` control the bind address for the control plane (loopback by default). Verify required variable names against the service entry points in `apps/` before deploying; the processes fail closed at startup when a required credential is missing.

Cadence ownership is split deliberately. `DurableScheduler` owns the fixed-period jobs (`daily-intelligence` every 24h and `innovation-48h` every 48h). `OrganizationCycleRunner` owns the condition-driven work — operations findings, safe agent lifecycle transitions, the security posture audit, incident analysis, weekly evolution and workforce coverage. `TRANSACTRA_CYCLE_INTERVAL_MS` must be an integer between 60000 and 3600000 (default 900000); any other value fails the process at startup instead of silently changing the cadence. A cycle that fails is logged and retried on the next tick; it never crashes the scheduler and never records a partially executed cycle as complete. Every enqueue uses a deterministic idempotency key, so a restart cannot duplicate a run.

## Channel surfaces and notification delivery

`ControlSurface` is the single command surface shared by every transport, so Telegram, WhatsApp and the dashboard expose the same commands: `/status`, `/org`, `/tasks`, `/approvals`, `/approve <id> <reason>`, `/reject <id> <reason>`, `/incidents`, `/deployments`, `/projects`, `/reports`, `/notifications`. Transports only move bytes.

Each surface claims its own channel plus the shared `owner` channel (`telegram`, `whatsapp`, `local`), so an alert addressed to `owner` is delivered exactly once through whichever surface is running, using row locks with `FOR UPDATE SKIP LOCKED`. Failed deliveries retry with an exponential backoff capped at five minutes, and the fifth attempt marks the notification `failed` so it is visible rather than lost. The `local` channel is pull-based: its notifications stay `queued` until the authenticated owner acknowledges them through `POST /v1/notifications/ack`, which only ever affects `local` rows in the `queued` state. Every approval created by the tool gateway enqueues a durable `approval_required` notification; a failed alert never invalidates the approval itself.

## Web dashboard

The control centre is served from the control plane at `http://127.0.0.1:8787/` (loopback default; `PORT` overrides) at `/` and `/dashboard`. It is an embedded single page: no build step, no static files, no third-party runtime. Responses set a strict Content-Security-Policy with a per-request nonce, `no-store`, `nosniff` and `no-referrer`. The API token is held in session storage for the tab only and sent as a bearer token; the approval credential is entered separately and is transmitted only for a decision. There are no mock or sample values: every number shown comes from a `/v1` read.

## Self-evolution operations

1. The weekly cycle enqueues an `evolution` audit task; the agent calls `evolution.audit`, which reads real 30-day evidence (task success and failure, stale leases, open incidents, pending approvals, quarantined agents, undelivered notifications, failed proposals, deployment and memory volume), applies its own incident/lease/backlog penalties and persists a scored audit.
2. Improvement proposals must pass `validateEvolutionChanges`: a single `version: 1` change set, unique repository-relative paths, no dependency manifests or lockfiles, no CI permission or credential files, no key material, no parent-directory traversal, and only application, package, documentation, test or migration paths.
3. Validation and verification run in the isolated sandbox; the worker fails closed if the sandbox validation infrastructure is unavailable.
4. Apply and rollback are approval-gated. Applying writes to `main` through the GitHub adapter and records the applied commits; rollback requires a fresh approval and re-dispatches the previous successful commit.

## Service checks
- Liveness: `GET /health/live` confirms only that the process responds.
- Control-plane readiness: `/health/ready` verifies PostgreSQL connectivity and the core schema only. It does not establish worker, provider, scheduler, Telegram or WhatsApp readiness; an aggregate full-platform readiness check remains unimplemented.
- Provider check: inspect persisted `provider_health` observations and in-memory provider circuit state through the operations agent. Use a low-cost/no-cost authenticated health request only after spend authorization; never send paid test traffic.
- Agent reliability: inspect the operations report's 30-day finalized-step success rate, successful latency, approval waits, open attempts and sample confidence. These metrics do not measure semantic output quality.

## Worker recovery
1. Detect expired task leases.
2. Confirm no external side effect is still in progress.
3. Reconcile idempotency keys and external operation IDs.
4. Requeue only retryable tasks within retry/deadline budgets.
5. Move exhausted tasks to a dead-letter state and alert the owner.
6. Preserve the complete event and audit trail.

## Incident severity
- SEV-1: credential exposure, unauthorized write/deploy, confirmed spend-policy bypass, loss of durable data.
- SEV-2: orchestrator/worker outage, repeated webhook compromise signals, failed backups, corrupted task state.
- SEV-3: provider degradation, delayed scheduled research, noncritical channel failures.

## Backup and restore
Backups must be encrypted, access-restricted, retained under a documented policy, and tested by restoring into an isolated environment. The committed scripts are `bash infra/scripts/backup-postgres.sh` and `bash infra/scripts/restore-postgres.sh`; see [infra/scripts/README.md](../infra/scripts/README.md) for required `age` keys, retention settings and the destructive restore acknowledgement. A backup is not accepted until a real restore verification succeeds. Never place backup keys in the repository.

## Rollback
Deployments require a known-good artifact, migration compatibility assessment, owner approval for production rollback, and post-rollback health verification. Database rollback must use forward repair when destructive reverse migration would lose data.

## Public ingress
Keep the control plane on `127.0.0.1:8787` and the WhatsApp webhook on `127.0.0.1:3001`. Use the Nginx template in `infra/nginx/transactra.conf.example` for TLS termination, rate limits and restricted health routes. Firewall direct access to 8787/3001; expose only 80/443. Configure a real domain and certificate before enabling public traffic.

## Cost incident
Immediately disable provider dispatch, preserve request and ledger evidence, verify account usage out-of-band, and do not re-enable until the zero-spend control is independently tested.
