# Stage 1 — Architecture and infrastructure verification

**Audit date:** 2026-11-09 (IST)  
**Repository:** KUNDURUHIMANEESHREDDY/transactra  
**Audited branch:** main  
**Authority:** ADR-0006 — Cloudflare-native hosting and execution  
**Scope:** Architecture, hosting, persistence, execution, channels, security, operations, recovery and live Cloudflare/GitHub inventory.  
**Actions:** Read-only inspection plus documentation alignment on main. No runtime resources changed.

## 1. Outcome

**Design baseline verified; activation gates remain open.**

The approved architecture is Cloudflare-native and event-driven. It is not a resident Linux daemon and does not require the user's Windows PC or a separately operated Linux host. D1 is the canonical operational database for the Cloudflare-native target. Workers execute bounded steps; Queues provide asynchronous delivery; Cron wakes durable workflows; Durable Objects are optional coordination primitives; R2 is optional and disabled until account-specific free eligibility is verified.

The complete product scope remains unchanged: autonomous organization, specialist multi-agent workforce, daily evidence-backed recommendations, 48-hour project candidate cycle with a 90/100 gate, autonomous GitHub engineering, guarded self-evolution, monitoring/recovery and independent messaging/control channels. Dashboard remains Stage 11.

Stage 1 is complete as a design and read-only infrastructure baseline. This is not production-readiness certification. Runtime gates below block staging activation and production changes.

## 2. Target topology

Channel adapters (Telegram / WhatsApp / local / secure public API)
→ Cloudflare Worker ingress (authentication, validation, rate limits)
→ durable D1 intake and idempotency record
→ Cloudflare Queue
→ bounded Worker consumers
→ policy and approval gate
→ durable orchestrator / specialist agent steps
→ provider gateway and GitHub/research adapters
→ D1 checkpoints, evidence, audit and quota ledger
→ approval-gated project deployment.

Cron wakes daily recommendations and the 48-hour innovation workflow. Each cycle is checkpointed and resumed through bounded queue work. Durable Objects may serialize per-task/project coordination. The dashboard is a Stage 11 client only.

This is the target topology, not a claim that every component is deployed.

## 3. Boundaries and invariants

| Component | Responsibility | Must not |
|---|---|---|
| Channel ingress | Verify provider webhook, owner identity, replay/rate controls; normalize commands | Treat a message as authorization for a sensitive action |
| Edge Worker | Persist ingress, enqueue work, expose health/readiness, bounded adapters | Run untrusted generated code or long-lived in-memory workflows |
| D1 | Canonical target state, idempotency, tasks, runs, approvals, evidence, audit, quotas | Depend on PostgreSQL-only features or become unscoped |
| Queue consumers | Claim durable work, execute one bounded step, persist outcome and next step | Assume exactly-once delivery |
| Durable Objects | Serialize per-task/project coordination and sessions where needed | Become a second source of truth |
| Cron | Wake daily and 48-hour jobs | Execute an entire multi-hour cycle in one invocation |
| Provider gateway | Pre-authorize cost, enforce caps/timeouts/circuit breakers | Send paid/unknown-cost requests or silently fail over |
| Engineering executor | Work on private repos in separately verified isolation | Execute untrusted code in the ingress/control Worker |
| Intelligence/innovation | Collect provenance, score evidence, recommend and create candidates | Present unsupported claims/scores as verified facts |
| Evolution engine | Audit, propose, sandbox, test, request approval, rollback | Approve or apply its own sensitive changes |
| Dashboard | Final control surface | Contain core business logic or be required for operation |

## 4. Persistence and transitional planner

D1 is canonical for the Cloudflare-native target. The target logical model is in DATA_MODEL.md and uses SQLite-compatible conventions, additive migrations, owner scoping, durable idempotency and append-only event/audit semantics.

The legacy Telegram planner bridge remains transitional:
1. Worker verifies Telegram webhook and owner allowlist.
2. Inbound update, task intake and execution ledger are persisted in D1.
3. Worker calls only a dedicated staging planner endpoint with staging-only API and approval credentials.
4. Legacy planner creates its task/approval transactionally in PostgreSQL.
5. Worker validates and persists external task/approval IDs to D1.
6. On failure or ambiguous acknowledgement, task remains held and non-executable; reconcile before retry.
7. D1-native cutover requires parity tests for task lifecycle, approval, retries, duplicate delivery, DLQ, crash recovery and audit history.

Production planner credentials, production Telegram bot and production Worker must never be reused in staging.

## 5. Live Cloudflare inventory — read-only

| Resource | Live result | Interpretation |
|---|---|---|
| Workers | Only transactra-edge exists | transactra-edge-staging is not deployed |
| Production D1 | transactra; ID 35047d34-b8f4-4a2a-9321-fb5b5e48e409 | Existing production database; preserve |
| Staging D1 | transactra-staging; ID e7292f55-c90e-4d34-8b77-c97c3e5ec15a | Separate ID is correct; no app schema |
| Production queue | transactra-events | One producer and one consumer on transactra-edge |
| Production DLQ | transactra-events-dlq | Exists; no consumer attached |
| Staging queue | transactra-events-staging | Exists; zero producers/consumers |
| Staging DLQ | transactra-events-dlq-staging | Exists; zero producers/consumers |

Direct read-only D1 SQL/PRAGMA inspection confirmed:
- Production application tables include execution_plans, inbound_events, inference_quota_daily, runtime_heartbeats, task_events, task_run_events, task_runs, tasks and telegram_reply_outbox, plus Cloudflare internal tables.
- Production tasks lacks pipeline_task_id, approval_id, pipeline_status and pipeline_synced_at. The current Worker /ready endpoint expects these fields when the planner bridge is configured.
- Staging D1 currently contains only _cf_KV; none of the seven repository migrations have been applied.
- The D1 database-list num_tables field is deprecated; direct SQL/PRAGMA was used instead.
- All inspected SQL queries were read-only and returned changed_db=false and rows_written=0.

## 6. Repository and CI inventory

- Repository is private; default branch is main.
- Latest observed main commit during audit: 612efc0b3096f912592c323bd0b7153fe454da24.
- Latest observed CI run: #373 succeeded on that exact main commit.
- GitHub branch inventory returned main, feat/nvidia-nim-orchestration and fix/sandbox-require-rootless-docker-20261109. All three report protected=false.
- Two non-main branches and missing branch protection violate the documented main-only governance rule. No branch was deleted, merged or force-updated.
- The staging workflow requires a self-hosted runner labelled self-hosted, Windows, X64, transactra. Runner availability/labels and staging secret validity were not inferred from a green CI run.

## 7. Security and operations model

- External webpages, messages, repository files, issues and model outputs are untrusted data.
- Webhooks require provider verification, owner allowlists, replay protection and rate limits.
- Tool gateway uses capability scopes; agents cannot grant themselves permissions.
- Secrets are runtime-only, least-privilege and redacted.
- Approvals are single-use, expiring and bound to exact action hashes.
- Cost authorization is pre-dispatch and INR 0; unknown/positive cost fails closed.
- Repositories are private by default. Production deploys, destructive changes, permission/identity changes, visibility changes and policy exceptions require owner approval.
- Untrusted code requires a separately verified isolation boundary; the current Docker runner is not yet an operational engineering executor.
- Public access requires TLS, strong authentication, origin/CSRF protections, request limits and firewall controls.
- Backups require encryption and an isolated restore test.
- Cron schedules bounded work; queue consumers checkpoint each step. Queue delivery is at least once, retries are bounded, DLQ replay is audited, leases are recoverable.
- Monitor queue age/depth, task age/latency, stuck leases, schedule drift, D1 quota headroom, provider health, budget denials, webhook failures, approval backlog, backup freshness and incident state.

Cloudflare Workers do not provide a resident process. 24/7 operation is durable event-driven progress subject to platform availability, quotas and provider/channel availability.

## 8. Activation blockers

1. Owner verifies Cloudflare Free plan and absence of paid subscription/billing requirement in Dashboard → Billing → Subscriptions. Connected API access cannot read billing state.
2. Verify current official quotas and usage headroom for Workers, D1, Queues, Durable Objects, R2 if used, and inference.
3. Review migrations and apply them only to staging after the Free-plan gate.
4. Deploy staging Worker with staging-only secrets and queue bindings; do not register production Telegram bot.
5. Obtain a dedicated staging planner HTTPS endpoint and separate API/approval credentials, independently verified as INR 0. Otherwise keep bridge blocked.
6. Pass staging E2E: duplicate webhook, D1 event/task/run persistence, planner acknowledgement, approval/rejection, retries, DLQ and crash recovery.
7. Resolve the production schema bridge gap only through a separately reviewed, approval-gated change after staging evidence.
8. Owner/admin must enforce main branch protection and reconcile the two non-main branches without deleting or force-pushing unreviewed work.
9. Select and verify an isolated execution environment compatible with Cloudflare; Docker primitive is not yet wired into engineering.
10. Verify no-cost eligibility for inference, research, messaging, storage, execution and deployment before activation.

## 9. Explicit non-actions

No Worker deployment, remote migration, D1 write, queue-binding change, secret creation, Telegram call, webhook registration/change, inference activation, billing change, paid resource provisioning, production data change or branch/ruleset change occurred.

## 10. Stage 1 decision

**Architecture baseline: verified and documented.** Cloudflare-native topology, service boundaries, D1 canonical target, transitional PostgreSQL planner boundary, security, zero-cost policy, operations/recovery model and live resource inventory are aligned in the repository.

**Production readiness: not approved.** Staging deployment and runtime acceptance are separate gates. No autonomy or integration is considered operational merely because code or design exists.

Next engineering action: staging-only migration and Worker deployment after the account Free-plan gate and staging planner/secret prerequisites are verified. Keep production untouched.
