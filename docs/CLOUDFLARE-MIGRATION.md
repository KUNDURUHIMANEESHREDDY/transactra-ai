# Transactra migration to a no-card, zero-monthly-cost architecture

**Status: design and safe preparation only. No production cutover has occurred.**

## Decision record

The user's hard constraints are:

- ₹0/month, with no credit card on any hosting provider.
- Preserve the existing AppDeploy control-center data and credentials.
- Keep the existing Transactra GitHub repository private.
- Operate independently of the user's laptop.
- Retain Telegram control, autonomous scheduling, multi-agent execution, and isolated engineering.

The old VM runbook is **not an acceptable target** for these constraints. Oracle Cloud and Google Cloud require payment-card or billing-account verification. Do not direct the user to create either account or describe either as a no-card option.

There is no verified provider in the current connected account that supplies an unlimited, always-on Linux VM with PostgreSQL and Docker at ₹0 and without a card. Therefore, do not promise that the complete current Node.js/PostgreSQL/Docker stack can be moved unchanged to a free edge platform.

## Target topology: event-driven edge, not a VM lift-and-shift

| Concern | Candidate service | Fit and limitation |
|---|---|---|
| Dashboard and authenticated HTTP ingress | Cloudflare Pages + Workers | Good edge fit; does not run a persistent Node process |
| Short request handlers | Workers | Must stay within plan CPU, memory, and request limits |
| Durable small records | D1 | SQLite-compatible, not PostgreSQL; requires a deliberate schema and query migration |
| Async task dispatch | Queues | Event-driven; consumers are bounded invocations, not always-on workers |
| Multi-step durable jobs | Workflows | Suitable for checkpointed, resumable steps; every step still has platform limits |
| Coordination/locks | Durable Objects | Suitable for strongly consistent coordination; not a replacement for the current PostgreSQL data model |
| Periodic triggers | Cron Triggers | Suitable for bounded scheduled discovery and maintenance |
| Untrusted code execution | No approved zero-cost/no-card provider verified | The current Docker sandbox cannot be moved into Workers; keep code execution disabled until a compliant isolated runner exists |
| Git operations and CI | GitHub App + GitHub Actions | Existing repository integration is available; Actions minutes and concurrency are finite, so add hard usage caps |

Cloudflare can host an event-driven control plane, but it is not a drop-in host for the current long-running Node worker, PostgreSQL server, or Docker sandbox. The target must be a staged refactor behind explicit adapters. A successful Pages deployment alone is not evidence that agents, queues, schedules, or code execution are operational.

## Data sources discovered

### AppDeploy application database

The deployed AppDeploy backend uses these seven logical tables:

- `cp_agents`
- `cp_tasks`
- `cp_events`
- `cp_projects`
- `cp_recommendations`
- `cp_approvals`
- `cp_state`

Records are stored through AppDeploy's key-value database SDK, not in the repository's PostgreSQL database. The SDK's `db.list` supports bounded pages and a `nextToken`; every page must be followed until no token remains. Preserve each physical record `id` and all record fields. Never infer that a first page is a complete export.

### AppDeploy secret vault

The current app has these configured secret *names*:

- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_APP_SLUG`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `TELEGRAM_WEBHOOK_SECRET`

Secret values must never be included in a database export, Git commit, log, or migration bundle. They must be re-entered through a secure secret-entry flow at the destination and rotated if exposure is suspected. The export endpoint must export application records only, never call the secrets API.

### GitHub repository PostgreSQL schema

The private `transactra` repository contains a separate PostgreSQL-backed runtime and migration history. Its database is not proven to contain the AppDeploy records. Do not treat the AppDeploy key-value tables and the PostgreSQL schema as interchangeable. A mapping document and import tests are required before loading any source record into the new schema.

## Safe migration sequence

1. **Freeze the source boundary, not the source app.** Keep AppDeploy online and read-only for export. Do not delete its app, database records, cron jobs, or secrets.
2. **Add a read-only export route to the AppDeploy backend.** Protect it with the existing `requireAuth()` and `requireAdminEmailAllowlist` guard. Allow only the seven table names above. Accept one table and an opaque `nextToken`; clamp page size to a small bounded maximum (for example 100). Return `table`, `items`, `nextToken`, and an export schema version. No writes, no secret reads, no arbitrary table names.
3. **Export all pages.** Use the authenticated app session; write a local JSONL/JSON bundle. Retain source IDs. Compute SHA-256 per file and a manifest with table counts, page counts, byte sizes, and hashes. Fail if any page is incomplete or a cursor repeats.
4. **Verify before import.** Re-read the source counts and compare with manifest totals. Check unique IDs, JSON validity, required fields, and record-size limits. Keep an encrypted offline copy.
5. **Write explicit mappings.** Map each AppDeploy table to destination records. Preserve source identifiers in a `legacy_source` namespace so retries are idempotent. Do not overwrite existing destination records. Conflicts must be reported, not silently resolved.
6. **Import to an isolated destination.** Use a dry-run first, then bounded idempotent batches. Verify destination counts and hashes after normalization. Do not use a destructive restore against a live database.
7. **Re-enter secrets separately.** Bind new secret entries to the destination. Verify GitHub and Telegram with non-destructive health checks.
8. **Shadow operation.** Run read-only status checks and compare outputs while AppDeploy remains authoritative. Do not run two Telegram pollers/webhook owners against the same bot token.
9. **Cut over only after acceptance.** Require data parity, auth checks, queue/scheduler tests, backup+restore drill, channel verification, and a rollback procedure. Keep the source app intact until the owner explicitly approves retirement.

## Export endpoint contract

Proposed route: `GET /api/migration/export?table=cp_tasks&limit=100&nextToken=<opaque>`

Response shape:

```json
{
  "schemaVersion": 1,
  "table": "cp_tasks",
  "items": [{ "id": "source-record-id", "title": "..." }],
  "nextToken": "opaque-or-null"
}
```

Security requirements:

- Existing admin authentication and email allowlist are mandatory.
- Allowlist is fixed in server code; caller cannot provide a table name outside the seven known names.
- Maximum page size is clamped server-side.
- Return no secret values, tokens, private keys, or secret metadata beyond what is already in the app's ordinary records.
- Do not accept destination URLs or perform server-side forwarding.
- Audit each export request without logging record bodies.
- The endpoint is read-only and can be removed after export verification.

## Current blockers and truthful status

- AppDeploy's deployment preflight reported the daily free-tier deployment credit balance is below its 16-credit minimum. It will not accept a new deployment until **2026-11-10 00:00 UTC**. The existing deployed app continues running. Do not retry deployment before reset.
- The AppDeploy export route is still specified but not implemented/deployed; no AppDeploy records have been exported or imported by this migration work.
- Cloudflare resources are now provisioned: Worker `transactra-edge` with 100% traffic on its current deployment, D1 database `transactra`, queue `transactra-events`, dead-letter queue `transactra-events-dlq`, workers.dev subdomain enabled, and a `*/15 * * * *` Cron Trigger. The Worker has the expected D1/queue and Telegram secret bindings. No Cloudflare Workflow has been provisioned or verified.
- D1 contains the runtime tables `inbound_events`, `telegram_reply_outbox`, and `runtime_heartbeats`; read-only aggregate checks observed 5 inbound Telegram events, 1 sent outbox reply, and a scheduler heartbeat at 2026-11-09T05:45:29Z. These are runtime events, not imported AppDeploy source records.
- No AppDeploy source records have been copied, no source/destination parity has been measured, and no cutover has occurred. AppDeploy remains authoritative.
- The Cloudflare account's billing/plan state has not been verified, so the ₹0/month and no-card constraint is not yet certified. The external Worker health endpoint was not independently exercised during this check.
- The user's zero-card constraint rules out the VM path described in the older runbook.
- The existing repository policy requires all work directly on `main`; do not create feature or staging branches.

## Acceptance gates

A phase is complete only with evidence:

- **Export:** all seven tables paginated to completion; stable manifest; no secrets in bundle.
- **Import:** deterministic source-to-target mapping; idempotent retry; source/destination counts and normalized hashes match.
- **Runtime:** authenticated health endpoint, durable queue processing, scheduled invocation, restart/retry tests, and no paid resource creation.
- **Channels:** Telegram webhook or polling ownership verified; sender allowlist tested; duplicate delivery/idempotency tested.
- **Security:** least-privilege credentials, secret rotation/re-entry, audit coverage, and no public unauthenticated export.
- **Cost:** documented free quotas and hard stops; no automatic paid upgrade or billing fallback.
- **Rollback:** source remains available and destination can be disabled without deleting source data.

Until all gates pass, AppDeploy remains the live source and no cutover is authorized.

## Platform limits and source references

As checked against Cloudflare's current documentation on 2026-11-09, the Workers Free plan lists 100,000 requests per day, 10 ms CPU per HTTP request, 10 ms CPU per Cron Trigger, and five Cron Triggers per account. These are hard architectural constraints for any free-tier design; CPU-heavy agent planning, large imports, and code compilation cannot be treated as ordinary Worker requests. Limits can change, so re-check them before deployment.

- [Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Queues platform limits](https://developers.cloudflare.com/queues/platform/limits/)
- [Workers Git integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)
- [Pages Git integration](https://developers.cloudflare.com/pages/configuration/git-integration/)

The Cloudflare GitHub App installation is only repository authorization. It does not prove that a Cloudflare account, project, Worker, Pages site, database, or deployment exists. A project must still be created and connected in Cloudflare's dashboard or through an authorized deployment workflow.
