# Transactra durable data model — Cloudflare-native target

**Canonical operational store:** Cloudflare D1 (SQLite).  
**Decision:** ADR-0006.  
**Scope:** Logical target model for the complete product; not a claim that every table is deployed.

The existing PostgreSQL-oriented schema is a domain reference and transitional planner implementation. It is not the canonical database for the Cloudflare-native target. D1 migrations must use supported SQLite semantics and be validated against a separate staging database before production use.

## Storage conventions

- Use TEXT UUIDs/opaque IDs and UTC ISO-8601 timestamps.
- Use explicit CHECK constraints for statuses and non-negative counters.
- Store JSON as validated TEXT; validate shape at application boundaries.
- Store currency as integer minor units; authorized spend remains INR 0.
- Index owner/project scope with common lookup and ordering fields.
- Enforce owner/project scope in every query; D1 does not provide PostgreSQL row-level security.
- Keep task and audit events append-only at the application policy layer.
- Use unique idempotency keys for inbound events, tasks, queue dispatches and external side effects.
- Use D1 transactions/batches only where atomicity is documented and tested. Do not assume PostgreSQL row locks, advisory locks, JSONB, extensions or pgvector.
- Use Durable Objects only where single-actor serialization is required; D1 remains the durable source of truth.
- Large artifacts may use R2 or controlled external storage only after account-specific quota and billing verification. Keep ownership, hashes and retention metadata in D1.

## Domain entities

| Domain | Logical tables and key fields |
|---|---|
| Identity | owners (owner_id, status, created_at); identities (provider, subject, owner_id, verified_at, status; unique provider/subject) |
| Workforce | agents (agent_key, department, lifecycle_status, definition_version, concurrency_cap); agent_capabilities (agent_id, capability, resource_scope, expires_at) |
| Work | tasks (owner_id, objective, status, risk, priority, idempotency_key, deadline); task_dependencies (task_id, depends_on_task_id); task_runs (task_id, attempt, worker_id, lease_token, lease_until, state); task_events (task_id, event_id, event_type, payload_json, actor_id, created_at) |
| Governance | approvals (action_hash, requested_by, status, expires_at, decided_by, decided_at, reason, consumed_at); tool_invocations (actor, capability, resource, input_hash, policy_decision, outcome, correlation_id) |
| Providers/budgets | provider_accounts (provider, model, enabled, verified_at, quota metadata, secret reference); provider_health (provider/model, status, latency, observed_at, fixed failure code); spend_ledger (provider, task_id, estimated/actual INR minor units, period key) |
| Memory | memory_items (owner_id, project_id, content_ref/hash, source, sensitivity, retention_until); memory_embeddings (item_id, embedding format/version, dimensions, payload); memory_entities and memory_entity_links (scoped graph facts/relationships) |
| Intelligence | research_sources (canonical_url, publisher, fetched_at, content_hash); evidence_items (source_id, excerpt_ref, claim, provenance); opportunities (evidence set, score breakdown, confidence, decision, discovered_at) |
| Innovation/engineering | projects (opportunity_id, specification, lifecycle_status, cycle_id, repository_id); repositories (provider, owner, name, visibility, installation reference); deployments (environment, commit_sha, status, approval_id, timestamps) |
| Operations | incidents (severity, state, source, summary, opened_at, resolved_at); audit_events (actor, action, resource, decision, correlation_id, created_at); scheduled_jobs (job_key, cadence, next_run_at, lease/claim metadata) |

These are target logical entities. Add them through ordered additive migrations as departments are implemented; do not create unused tables merely to satisfy a checklist.

## Execution and consistency invariants

- Persist task, idempotency key and event before queue dispatch.
- Queue delivery is at least once; consumers use durable deduplication keys.
- Claim task steps through a bounded lease protocol. Durable Objects may serialize claims; D1 stores lease and checkpoint.
- Persist state transitions and audit events in one tested transaction/batch wherever possible.
- Do not mark work dispatched until downstream planner/worker acknowledgement is validated and persisted.
- In the transitional Telegram bridge, D1 owns ingress/execution-ledger records; the legacy PostgreSQL planner owns its task and approval state until D1-native parity passes. Link external IDs only after validated acknowledgement.
- Approval tokens bind to an exact action hash, expire, are single-use and are rechecked immediately before execution.
- Unknown provider usage or uncertain external-call outcomes consume reservations conservatively; never automatically retry a potentially billable side effect.
- Never store secret values. Store only references and non-sensitive metadata.
- Embeddings are indexes, not canonical memory; original content and provenance remain recoverable without them.

## Current deployed schema boundary (read-only audit)

On 2026-11-09:
- Production D1 contains execution_plans, inbound_events, inference_quota_daily, runtime_heartbeats, task_events, task_run_events, task_runs, tasks and telegram_reply_outbox, plus Cloudflare internal tables.
- Production tasks lacks pipeline_task_id, approval_id, pipeline_status and pipeline_synced_at; the current Worker readiness check expects them.
- Staging D1 contains only Cloudflare's internal _cf_KV table; application migrations have not been applied.
- The audit used SELECT/PRAGMA only; no rows or schema were changed.

See STAGE-1-ARCHITECTURE-BASELINE.md for the resource inventory and staging boundary.


## Implemented Cloudflare memory lifecycle (migration 0013)

Transactra's active edge memory uses D1 as the canonical store and Mem0 Platform as an optional semantic index:

- agent_memory holds owner-scoped durable facts; task_memory captures immutable per-task context snapshots.
- memory_usage_monthly records successful Mem0 add/search calls by owner and calendar month. Defaults are 10,000 additions and 1,000 retrievals; limits are configurable and must be checked against the account's current Mem0 plan.
- memory_compaction_state stores the active generation, last compaction and the month in which Mem0 calls are paused.
- memory_archives stores immutable compacted summaries and source counts. Compaction writes the archive before updating the active transactra.compacted_summary key.
- memory_sync_outbox stores retryable D1-to-Mem0 writes, provider event IDs and asynchronous processing state. Cloudflare Queues dispatch sync work; the 15-minute Cron polls Mem0 events, retries durable pending work and triggers quota checks.
- At 70% of either configured monthly Mem0 allowance, Transactra creates a structured operational digest from owner memories, tasks, task events, orchestrator events, step results and recovery state. It then switches the active Mem0 agent scope to a new generation and pauses further Mem0 calls for the rest of the month. D1 retrieval remains available.
- Historical D1 records and archives are never deleted by compaction. Older Mem0 generations are no longer queried; they are not automatically deleted because Mem0 deletion is asynchronous and must not risk losing the replacement summary.
- The summary is a deterministic, evidence-backed digest, not an LLM-generated narrative. This avoids consuming a separate model quota or accidentally invoking paid inference.
- MEM0_API_KEY is a Cloudflare Worker secret only. Never commit it, print it, or include it in memory. Without the secret, D1-only mode remains fully functional.

Migration 0013 is additive. Apply it to staging first, verify /ready, memory commands, Mem0 sync and compaction, then consider production only after explicit approval.