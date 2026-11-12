# ADR-0006: Cloudflare-native hosting and execution

- **Status:** Accepted as the hosting direction; production activation remains gated by Free-plan and quota verification.
- **Date:** 2026-11-09
- **Supersedes:** The dedicated Linux host as a required runtime in `docs/ARCHITECTURE_REVIEW.md` and the proposed PostgreSQL canonical-store decision in ADR-0004.
- **Owner requirement:** Transactra must run on Cloudflare, retain the INR 0/month ceiling, and must not require the user's Windows PC or a separately operated Linux host.

## Context

The current repository and Cloudflare account already contain a deployed `transactra-edge` Worker, production and staging D1 databases, and production/staging primary and dead-letter queues. The account currently has no separately verified dedicated Linux runtime. The user selected Cloudflare as the hosting platform.

Cloudflare Workers are event-driven/serverless, not a continuously running Linux process. Transactra must therefore be designed as a durable, event-driven autonomous system rather than relying on a resident daemon.

## Decision

Cloudflare is the primary and required hosting platform for Transactra's application runtime.

| Product | Transactra responsibility | Cost and safety rule |
|---|---|---|
| Workers | Authenticated API, webhook adapters, policy enforcement, bounded orchestration steps and service interfaces | Workers Free limits are hard ceilings; never upgrade automatically |
| D1 | Canonical application database for owners, identities, tasks, task events, approvals, agent definitions, provider health, spend ledger, memory metadata, research evidence, projects and audit state | Use existing D1 resources; stay within Free quota; fail closed on quota exhaustion |
| Queues | Durable asynchronous dispatch, fan-out, retries and dead-letter routing | Treat delivery as at-least-once; consumers must be idempotent; Free retention is 24 hours and operations are capped |
| Durable Objects (SQLite-backed) | Per-task/per-project coordination, locks, leases, rate coordination and live session state where useful | Use only Free-eligible SQLite-backed objects; enforce request/storage quotas |
| Cron Triggers | Wake daily recommendation jobs and the 48-hour project-generation scheduler | Cron starts bounded jobs; it is not a long-running process; split work into durable queue messages |
| R2 | Optional artifacts, generated source bundles, reports and encrypted backup objects | Enable only after account-specific Free eligibility and quota are verified; never assume unlimited storage |
| Workers Static Assets / Pages | Stage 11 dashboard hosting | Dashboard remains last and cannot be a runtime dependency |
| Workers AI / NVIDIA NIM | Model inference adapters, only where current account/model terms are proven no-cost | Do not activate based on product availability alone; reject unverified or billable requests before dispatch |

## Canonical data and migration

D1 becomes the canonical operational database for the Cloudflare-native deployment. This supersedes the proposed PostgreSQL system-of-record decision for the selected hosting model.

The existing PostgreSQL-oriented schema remains useful as a logical domain model, but it must be adapted to SQLite/D1 semantics: migration ordering, transaction boundaries, supported SQL, indexes, uniqueness, JSON representation, pagination and concurrency behavior must be tested.

Do not delete, rename, repurpose or migrate either existing D1 database in place as part of this decision. Production and staging remain separate. The currently deployed `transactra-edge` Worker and production data are preserved. Any schema change first targets staging, with explicit migration/rollback evidence. Existing task/event records must remain traceable across any future migration.

The staging bridge must continue to persist Telegram's D1 event and execution ledger and hand off to the existing task-planning pipeline through its authenticated interface. A message is not considered dispatched until the canonical task creation is acknowledged. Approval-gated execution remains mandatory.

## Transitional planner boundary

The Cloudflare-native target and the existing Telegram-to-planner bridge are separate migration steps; do not collapse them into an unsafe cutover.

- **Current bridge behavior:** Telegram ingress first persists the D1 inbound event, task, task event, task-run and run-event records. It then calls the authenticated existing planner API. The planner's PostgreSQL transaction creates the executable task and approval record. Until a D1-native planner has passed parity and acceptance tests, PostgreSQL remains authoritative for the legacy planner's task execution state and approval decision; D1 remains authoritative for the Cloudflare ingress/event and execution-ledger records.
- **Target behavior:** D1 becomes the canonical operational store for the Cloudflare-native orchestrator, including task state, approval state, task runs and audit history. The legacy PostgreSQL planner is retired only after a tested D1-native planner supports equivalent task planning, approvals, retries, idempotency, recovery and audit semantics.
- **No split-brain:** While the bridge is active, every D1 task must carry the external planner task ID and approval ID; the D1 record must not claim that the planner task was created or approved until the API response is validated and persisted. Reconciliation must detect missing, delayed and conflicting links. Duplicate Telegram updates must resolve to the same planner task through the update ID idempotency key.
- **No silent fallback:** If the planner endpoint, API credential, approval credential or PostgreSQL-backed planner is unavailable, leave the D1 task durably held in a non-executable state, record the failure and alert the owner. Never mark it queued/executable or bypass approval.
- **Staging gate:** A staging bridge deployment requires a dedicated staging planner endpoint and staging-only API/approval credentials. The production planner URL, credentials and Telegram bot must not be reused in staging. If a staging planner cannot be provisioned without violating the INR 0 rule, staging integration remains blocked; do not point staging at production.
- **Cutover gate:** Before retiring PostgreSQL, run a D1-native planner against staging fixtures and prove data parity, task/approval state transitions, duplicate delivery, retry/DLQ behavior, crash recovery and rollback. Preserve existing D1 and PostgreSQL records for reconciliation; no destructive migration is part of this ADR.

## Autonomous execution model

1. An authenticated channel/API request is validated and persisted in D1 with an idempotency key.
2. The policy engine classifies risk, checks owner/capability scope and creates an approval record where required.
3. A durable queue event schedules bounded execution work.
4. Queue consumers load current task state, claim a lease, execute one bounded step and persist its result/event.
5. Multi-step work is represented as a durable task graph; each step schedules the next step rather than depending on an in-memory process.
6. Durable Objects may coordinate locks, active sessions and concurrency; D1 remains the durable source of truth.
7. Cron Triggers enqueue daily and 48-hour jobs. The queue/workflow progresses them in resumable, bounded steps.
8. On retry, timeout, duplicate delivery or runtime restart, idempotency keys, leases and persisted checkpoints prevent duplicate side effects.
9. Provider outages or exhausted free quotas pause work and notify the owner. No paid failover is allowed.
10. Deployment, destructive operations, access-control changes, public repository changes and sensitive self-modification remain approval-gated.

## Free-tier enforcement

The Free plan is a strict operating boundary, not a promise of unlimited 24/7 compute.

As documented by Cloudflare at the decision date, Workers Free has request and CPU limits (including 100,000 requests/day and 10 ms CPU per invocation); Cron, Queue and alarm executions are bounded and must be split into resumable steps. D1 Free includes daily row-read/write limits and an account-wide storage cap. Queues Free includes 10,000 operations/day and 24-hour message retention. Durable Objects Free has finite request, duration and SQLite storage allocations. Exact limits must be rechecked against current official docs and the connected account before activation.

Required controls:
- Read and track product-specific usage and quota headroom.
- Maintain an internal safety reserve below every Cloudflare hard limit.
- Stop creating new work before the reserve is consumed.
- Never auto-upgrade, enable a paid product, add a billing method or create a chargeable resource.
- Treat quota exhaustion as a recoverable paused state, not success.
- Do not claim continuous execution during platform outages, quota exhaustion or provider unavailability.

## Explicit constraints and limitations

- Cloudflare Workers do not provide a resident Linux daemon or general-purpose Docker host. The existing Docker coding runner cannot be assumed to run inside Workers.
- Autonomous repository engineering must use bounded, sandboxed execution supported by an explicitly verified Cloudflare product or a separately approved no-cost execution environment. Do not execute untrusted repository code directly inside the control-plane Worker.
- A 48-hour scheduler means the system is durably scheduled to resume work every 48 hours; it does not mean one Worker invocation runs for 48 hours.
- WhatsApp Business API access, messaging fees and account eligibility must be verified independently. Cloudflare hosting does not make third-party messaging free.
- NVIDIA NIM and other inference providers require independent account/model entitlement verification. Cloudflare hosting does not make inference free.
- Free-tier quotas can be exhausted or services can be unavailable. The system must pause safely and alert through configured channels.

## Verification gates before staging or production changes

1. Confirm Cloudflare account plan and absence of a paid subscription or billing requirement in the dashboard; the connected API identity currently lacks billing-read access.
2. Inspect the current Worker bindings, D1 schemas/migrations, queue producers/consumers and deployed routes in read-only mode.
3. Confirm the current staging database and queue IDs match repository staging configuration.
4. Run unit, integration, migration and quota-guard tests locally/CI.
5. Deploy only the distinct staging Worker after its configuration and staging secrets are complete. Never register the production Telegram bot on staging.
6. Verify duplicate webhook delivery, approval, rejection, queue retry, DLQ replay, lease recovery, quota pause and D1/PostgreSQL legacy reconciliation as applicable.
7. Prove production Worker, production D1 records, production queues and production webhook are unchanged.
8. Require separate owner approval before production cutover.

## Consequences

- No dedicated Linux host or always-on personal computer is required for the core control plane.
- D1 is the canonical database for the Cloudflare-native runtime; existing PostgreSQL-oriented code/schema needs a deliberate compatibility adaptation.
- Work is event-driven and resumable, not a permanently running process.
- The complete product scope and 11-stage roadmap are unchanged. The engineering implementation and execution sandbox must be redesigned to fit Cloudflare's actual runtime and Free quotas.
- The dashboard remains Stage 11.
