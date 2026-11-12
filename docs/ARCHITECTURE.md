# Transactra system architecture

**Approved hosting direction:** Cloudflare-native, event-driven runtime.  
**Authority:** ADR-0006 — Cloudflare-native hosting and execution.  
**Stage 1 evidence:** STAGE-1-ARCHITECTURE-BASELINE.md.

## Product invariants

Transactra is the complete always-on autonomous AI engineering organization. The 11 stages are an engineering sequence, not feature tiers.

- Continuous research, planning, execution, delegation, operations and improvement.
- Three evidence-backed recommendations daily.
- One new project candidate every 48 hours; create/build only at a reproducible evidence-backed score of 90/100 or higher.
- Hard monthly authorized spend ceiling: INR 0. No paid fallback, automatic upgrade or unapproved billable action.
- Private-by-default repositories, least-privilege credentials, deny-by-default authorization and auditable side effects.
- Sensitive operations require explicit owner approval.
- Telegram, WhatsApp, local access and authenticated encrypted public access work independently of the dashboard.
- Dashboard is Stage 11 and is a client of stable APIs, never an orchestration dependency.

## Runtime model

Cloudflare Workers are event-driven and bounded, not resident Linux daemons. Transactra progresses through durable, resumable workflows.

| Component | Responsibility | Constraint |
|---|---|---|
| Workers | API, webhook ingress, policy checks, bounded orchestration and adapters | Short invocations; request/CPU limits |
| D1 | Canonical operational database for the Cloudflare-native target | SQLite semantics; tested migrations, quotas and concurrency |
| Queues | Asynchronous dispatch, fan-out, retries and dead-letter routing | At-least-once delivery; idempotent consumers |
| Durable Objects | Optional per-task/project coordination, locks, leases and sessions | Coordination only; D1 remains durable source of truth |
| Cron Triggers | Wake daily recommendations and 48-hour project cycles | Enqueue bounded work; never run a 48-hour invocation |
| R2 | Optional artifacts and encrypted backups | Disabled until account-specific free eligibility and quotas are verified |
| Workers AI / external inference | Provider adapters | Disabled until no-cost entitlement and hard caps are verified |
| Static Assets / Pages | Final dashboard hosting | Stage 11 only |

“24/7” means durable event-driven progress when platform schedules, quotas, providers and channels are available. It does not promise uninterrupted execution during outages or exhausted free quotas.

## Service boundaries

1. Channel adapters authenticate and normalize Telegram, WhatsApp, local and secure public API requests. They cannot authorize sensitive actions.
2. Edge ingress verifies webhooks, applies limits, persists intake and enqueues work. It is not the canonical planner.
3. Control plane owns identity, sessions, command intake and status.
4. Policy/approval engine enforces identity, capabilities, risk, INR 0 authorization and single-use approvals.
5. Durable orchestrator owns task DAGs, leases, checkpoints, retries, cancellation, idempotency and state transitions.
6. Agent runtime owns specialist definitions, scoped tools/context, delegation, concurrency, evaluation and lifecycle.
7. Provider gateway owns NIM and explicitly verified no-cost adapters, quotas, timeouts and circuit breakers.
8. Engineering runtime owns GitHub App operations, private repositories, isolated code execution, tests, review and guarded deployment.
9. Intelligence/innovation owns source provenance, trend analysis, opportunity scoring, daily recommendations and 48-hour candidate generation.
10. Evolution engine audits, proposes, sandbox-validates, requests approval, rolls out and rolls back; it cannot approve its own sensitive changes.
11. Operations owns telemetry, alerting, backup, restore, incident response and quota monitoring.
12. Dashboard is the final-stage client of stable APIs.

## Persistence and transitional planner boundary

D1 is the canonical operational database for the Cloudflare-native target. The SQLite-compatible logical model is in DATA_MODEL.md. It covers owners/identities, agents/capabilities, tasks/dependencies/runs/events, approvals, tool calls, provider health/budgets, memory, evidence, opportunities, projects, deployments, incidents and audit records.

The existing Telegram bridge is transitional:
- D1 persists ingress events and execution-ledger records.
- The existing PostgreSQL-backed planner remains authoritative for its task and approval state until a D1-native planner passes parity, idempotency, retry, crash-recovery and audit tests.
- D1 stores external planner task/approval IDs only after validated acknowledgement.
- If the planner or staging-only credentials are unavailable, the task remains held and non-executable.
- Staging never uses production planner credentials or the production Telegram bot.
- No split-brain or silent fallback is permitted. Cutover is a separate approval-gated migration.

PostgreSQL is a legacy/transitional planner dependency, not the canonical database for the approved Cloudflare-native target. A Linux host or PostgreSQL runtime must not be provisioned as a Transactra requirement unless a new ADR changes the owner's Cloudflare decision.

## Execution protocol

1. Authenticate caller and normalize command.
2. Persist request, idempotency key and event before dispatch.
3. Classify risk, cost and required capabilities.
4. Authorize every side effect; deny by default.
5. Enqueue bounded work.
6. Consumer claims a lease, reloads current state and executes one bounded step.
7. Persist result, provenance, usage and audit event.
8. Schedule the next step from durable state; never rely on in-memory continuation.
9. Require approval for gated actions and revalidate exact action hash at execution.
10. Reconcile external side effects before marking work complete.

Queue delivery is at least once. Retries are bounded and idempotent. Expired leases are recoverable. DLQ replay is explicit and audited. Ambiguous outcomes for non-idempotent external calls are handled conservatively.

## Zero-cost provider policy

NVIDIA NIM is the preferred inference integration. Provider/model availability, API compatibility, account eligibility, quotas and current no-cost terms must be verified independently. A timestamp or attestation alone is not proof of billing status.

Positive or unknown cost is rejected before dispatch. Failover is permitted only to separately verified, explicitly configured no-cost providers with finite request/token caps. If none is eligible, work pauses; there is no paid fallback. Workers AI remains disabled until Free-plan status and quota headroom are confirmed. Research, messaging, storage, execution and deployment providers follow the same rule.

## Security and resilience

- External pages, messages, issues, repository files, code and model outputs are untrusted data.
- Every tool call has authenticated principal, capability, resource scope, policy decision and audit record.
- Secrets are runtime-injected, least-privilege, rotated and redacted; never stored in source, logs, prompts or memory.
- Webhooks require provider verification, owner allowlists, replay protection and rate limits.
- Approvals bind to exact action hashes, expire, are single-use and are revalidated at execution.
- Agents receive scoped credentials and cannot grant themselves capabilities.
- Public access requires TLS, strong authentication, origin/CSRF controls, rate limits and firewall restrictions.
- Production deployment, destructive actions, permission/identity changes, visibility changes, financial actions and policy exceptions require owner approval.
- Self-evolution requires isolated validation, regression tests, fresh approval and rollback.

Cloudflare Workers do not provide a general-purpose Docker host. Untrusted generated code must execute in a separately verified isolated environment, never inside the control-plane Worker. The existing Docker runner is a separate primitive, not an operational engineering executor.

Monitor Worker health, queue age/depth, task latency, retry/DLQ counts, schedule drift, D1 read/write headroom, provider health, budget denials, webhook failures, approval backlog, backup freshness and incidents. Backups require verified free-eligible durable storage, encryption and an isolated restore drill.

## Deployment acceptance

Production and staging Worker, D1, queues and secrets remain separate. Staging schema and Worker must be verified before production changes. Verify the account Free plan and per-product quotas; current API access cannot read billing state. Stage 1 design does not certify runtime activation. See STAGE-1-ARCHITECTURE-BASELINE.md.

## Dashboard-last rule

Telegram, WhatsApp, local access and authenticated encrypted public access must be independently operational before Stage 11. The dashboard is a presentation/control client only; it contains no core orchestration logic and is never required for autonomous operation.
