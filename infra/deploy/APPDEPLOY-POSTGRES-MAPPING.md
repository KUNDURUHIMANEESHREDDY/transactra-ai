# AppDeploy-to-PostgreSQL mapping and import contract

**Status: schema analysis only. No AppDeploy records have been exported or imported.**

This document maps the seven AppDeploy key-value tables to the PostgreSQL schema created by `infra/migrations/0001_core.sql` through `0004_organization.sql`. The mapping is a target contract, not proof that source records contain all required fields. The source export and a field-level inventory are required before writing any importer.

## Source-to-target mapping

| AppDeploy source table | PostgreSQL target | Mapping rule | Important caveat |
|---|---|---|---|
| `cp_agents` | `agents` | Map stable agent key to `agents.id`; name/department/prompt/capabilities to matching columns; lifecycle and concurrency require validated defaults | Preserve unknown fields in `legacy_source.payload`; do not silently discard them |
| `cp_tasks` | `tasks` plus `task_events` | Map only tasks with a resolvable owner; status/risk/priority/assigned agent must satisfy target constraints | UUID task IDs and mandatory idempotency key, owner, objective, risk, requested_by require explicit mapping |
| `cp_events` | `task_events` or `audit_events` | Task lifecycle events map to `task_events`; non-task administrative events map to `audit_events` | Classify event type first; do not flatten all events into task_events |
| `cp_projects` | `projects` | Map project identity, repository, specification and status | Target requires owner, repository_full_name, repository_url, specification, opportunity_score |
| `cp_recommendations` | `opportunities` and/or `intelligence_reports` | Candidate/score records map to opportunities; narrative reports map to intelligence_reports only when source shape supports required fields | Determine source record variants before choosing a target |
| `cp_approvals` | `approvals` | Map action, hash, status, requester, expiry and decision fields | Target requires owner, action_hash, action, requested_by, expires_at; never auto-approve pending actions |
| `cp_state` | `system_state`, `channel_state`, or a legacy payload table | Route only recognized keys to typed state tables; retain all original key/value pairs in legacy storage | Do not import credential material into application state; secret vault is separate |

## Required owner mapping

PostgreSQL records are owner-scoped. The AppDeploy admin user ID is not automatically a PostgreSQL `owners.id` UUID. Before importing any owner-scoped row:

1. Create or identify exactly one destination owner record through the project's owner bootstrap procedure.
2. Record the source AppDeploy user identifier in `owners.external_subject` if that is the approved identity mapping.
3. Verify the external subject is unique and belongs to the intended owner.
4. Map every source record to that destination owner UUID.
5. Abort if an owner cannot be resolved. Never invent or reuse a hard-coded UUID from an old, unverified runbook.

## Preserve every source record

Add a dedicated table in a future migration, for example `legacy_source_records`, with:

- `source_system` constrained to `appdeploy`
- `source_table` constrained to the seven known source tables
- `source_record_id` text
- `source_payload` jsonb containing the exact original record (including unknown non-secret fields)
- `payload_sha256` text
- `destination_table` text nullable
- `destination_id` text nullable
- `mapping_status` constrained to `pending`, `mapped`, `needs_review`, `imported`, `rejected`
- `created_at` timestamptz
- Unique key on `(source_system, source_table, source_record_id)`

This ledger is required for lossless retention, idempotent retries, and auditability. Do not write the migration until source payload size, secret scan, and schema inventory are known.

## Import invariants

- Preserve every physical AppDeploy record ID as `source_record_id`; do not assume its format matches a PostgreSQL UUID.
- Preserve original source payloads byte-for-byte at the JSON data-model level after canonicalization; keep normalized target fields separately.
- No source record may be silently dropped. Unmapped variants remain `needs_review`.
- Never overwrite a destination record that already exists. A conflicting ID or idempotency key stops that batch for review.
- Never change pending approvals into approved/rejected states.
- Do not import secret vault values. Re-enter credentials through the destination secret manager.
- Import in bounded transactions; each batch must be independently retryable and accompanied by a receipt.
- Verify per-table source counts, unique IDs, canonical payload hashes, destination ledger counts, and all target foreign keys.
- Keep the AppDeploy source live until a restore drill and cutover acceptance are signed off.

## Known schema gaps to resolve after export

- Source record shape and optional/required fields for all seven tables.
- Source ID formats and references between agents, tasks, projects, events and approvals.
- AppDeploy user identity to PostgreSQL owner UUID mapping.
- Task status/risk normalization and idempotency-key generation rules (stable and collision-checked).
- Recommendation record variants and whether they represent opportunities or completed reports.
- State key taxonomy and any legacy settings that contain credentials or personal data.
- Record sizes, nested arrays, timestamp formats and timezone assumptions.

**No importer should be implemented until these are resolved from the actual verified export.**
