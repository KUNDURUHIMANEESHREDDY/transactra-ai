> **Current review status:** This file contains the historical review and superseded PostgreSQL/Linux hosting proposal. The accepted Cloudflare-native hosting decision is ADR-0006, and the current Stage 1 verification result, live inventory and remaining activation gates are recorded in [STAGE-1-ARCHITECTURE-BASELINE.md](STAGE-1-ARCHITECTURE-BASELINE.md). Where this historical review or its conclusion conflicts with ADR-0006 or the Stage 1 baseline, those newer documents take precedence. Stage 1 design is verified; production/runtime activation is not approved.

> **SUPERSEDED HOSTING BASELINE — READ BEFORE USING THIS REVIEW**
>
> The original hosting and persistence recommendations in Sections 3, 4, 8 and 9 below are historical and are **not the approved target architecture**. The owner subsequently selected Cloudflare-native hosting. **ADR-0006 (\`docs/ADR-0006-CLOUDFLARE-NATIVE-HOSTING.md\`) is authoritative** for hosting, runtime and persistence decisions and takes precedence wherever this review conflicts with it.
>
> In particular:
> - Do not provision a dedicated Linux/Windows host or register a self-hosted GitHub runner as a Transactra runtime requirement.
> - Do not treat PostgreSQL as the canonical store for the selected Cloudflare-native deployment. D1 is the canonical operational database, subject to verified quotas and tested migration behavior.
> - Do not treat D1 as merely an edge inbox or require a D1-to-PostgreSQL handoff.
> - Do not enable generated/untrusted code execution inside the control-plane Worker. Engineering execution needs a separately approved, isolated Cloudflare-compatible execution design.
> - Keep production Worker, production D1, production queues, Telegram webhook and production secrets untouched until staging verification and explicit owner approval.
> - The Cloudflare account's Free plan is not yet verified; API billing access is unavailable. No inference or production activation is authorized until the plan and all relevant free quotas are verified.
>
> The product invariants and security requirements below remain applicable unless ADR-0006 explicitly refines their implementation.
>
# Transactra architecture review — Stage 1

**Review date:** 2026-11-09  
**Repository:** `KUNDURUHIMANEESHREDDY/transactra`  
**Target branch:** `main`  
**Decision:** Architecture baseline accepted for implementation planning; production activation remains blocked by the gates below.

This review records the architecture against the complete 11-stage delivery target. It does not claim that documented components are deployed or runtime-verified.

## 1. Product invariants

1. Complete product scope; stages are sequencing, not feature tiers.
2. Continuous autonomous operation is the target, but no component may claim autonomy until its real executor and recovery behavior are verified.
3. Hard monthly authorized spend ceiling: INR 0. Paid requests must be rejected before dispatch. No automatic paid fallback or upgrade.
4. Private-by-default repositories, least-privilege credentials, deny-by-default tool authorization and immutable audit history.
5. Human approval for production deployment, destructive changes, permission/identity changes, repository visibility changes, financial actions and policy exceptions.
6. Telegram, WhatsApp, local API and secure public API must operate without the dashboard.
7. Dashboard is Stage 11 and is a client of stable APIs, never a dependency for orchestration.
8. Transactra repository changes are committed directly to `main`; no additional branches.
9. No simulated agent, fake provider call, placeholder integration or demo data may be represented as a live capability.

## 2. Approved logical service boundaries

| Boundary | Responsibility | Authority |
|---|---|---|
| Channel adapters | Telegram, WhatsApp, local API and authenticated public API intake | Authenticate and normalize; cannot bypass policy |
| Edge ingress | Cloudflare Worker, webhook verification, rate limiting, durable edge intake and queue transport | Transport boundary only; not the canonical task planner |
| Control plane | Owner identity, API, sessions, command intake and status | Authenticated application interface |
| Policy and approval engine | Capability grants, risk classification, INR 0 authorization and approval lifecycle | Mandatory authorization point for every side effect |
| Durable orchestrator | Task DAGs, leases, retries, cancellation, idempotency and state transitions | Canonical execution coordinator |
| Agent runtime | Specialist registry, scoped context, delegation, concurrency and evaluation | Executes only granted capabilities |
| Provider gateway | NVIDIA NIM adapter, explicitly verified no-cost fallback, quotas, health and circuit breakers | Rejects unverified or billable inference before network dispatch |
| Engineering runtime | GitHub App adapter, isolated workspace, tests, review and guarded deployment | No production write/deploy without approval |
| Intelligence and innovation | Research provenance, evidence scoring, daily recommendations and 48-hour project candidates | Candidate generation; 90/100 threshold before project creation |
| Evolution engine | Health audits, proposed changes, sandbox validation, approval, rollout and rollback | Cannot approve or apply its own sensitive changes |
| Operations | Monitoring, alerting, backups, restore, incident response and recovery | Operational evidence and controlled recovery |
| Dashboard | Final control-center UI | Stage 11 read/write client only |

## 3. Source-of-truth and persistence decisions

- **PostgreSQL is the proposed canonical system of record** for owners, identities, tasks, dependencies, task runs, events, approvals, agent state, provider health, spend ledger, memory metadata, evidence, projects, incidents and audit records.
- PostgreSQL schema changes are versioned, append-only migrations. Task and audit events are persisted transactionally with the state transition they describe.
- Idempotency keys, lease ownership/expiry, bounded retries and transactional outbox patterns protect against duplicate delivery and worker crashes.
- Memory content is owner/project scoped and provenance-aware. Embeddings are disposable indexes; canonical content and metadata remain recoverable without them.
- **Cloudflare D1 is edge-inbox/transport persistence only** for the current Worker slice. It is not a replacement for PostgreSQL and must not become a second canonical task store.
- Cloudflare Queues carry asynchronous events. Delivery is treated as at-least-once; consumers must be idempotent. Dead-letter replay is an explicit, audited operation.
- A D1-to-PostgreSQL handoff is complete only after the control plane acknowledges durable task creation. D1 event and run-ledger records remain available for reconciliation.
- AppDeploy remains a separate source of truth until a separately approved migration proves data parity, authentication, retries, restore and rollback. No implicit cutover is allowed.

## 4. Runtime and deployment topology

### Core runtime

The intended core runtime is a dedicated, always-on Linux host running separate hardened systemd services for the API/control plane, task worker and scheduler, with PostgreSQL on persistent storage. The host must be provisioned and verified before Transactra can be called continuously operational.

The current connected desktop is Windows 11. The implementation ledger reports WSL without the required Linux Node/pnpm/PostgreSQL client setup and a stopped Docker Desktop daemon. This is not an approved production runtime.

### Cloudflare edge

The existing `transactra-edge` Worker, production D1 database and production queues remain in place. Staging has a separate D1 database and separate queues. The live account inventory currently shows one Worker (`transactra-edge`), two D1 databases (`transactra`, `transactra-staging`) and four queues (production and staging primary/DLQ pairs).

No staging Worker is currently present in the account inventory. Do not infer that staging is deployed from the existence of its D1 database and queues.

The edge Worker may accept and persist owner-authorized task intake, authenticate webhooks, enqueue events and deliver replies. It must not execute autonomous engineering work or mark a task complete while the canonical planner/worker has not acknowledged and executed it.

### Public and local access

- Local control-plane and channel listeners bind to loopback by default.
- Public access is exposed only through a configured TLS reverse proxy with authentication, request limits, origin/CSRF controls, security headers and firewall restrictions.
- PostgreSQL and internal service ports are never exposed directly to the public Internet.
- Telegram and WhatsApp use provider-verified webhooks, owner allowlists, replay protection and rate limits. Sensitive actions require the separate approval flow.
- The dashboard is not required for any of these operations.

### Isolated code execution

The Docker runner is a separate execution primitive, not yet an end-to-end GitHub engineering runtime. It may run only on a dedicated Linux host with rootless Docker, a pre-pulled digest-pinned image, no network, read-only root filesystem, dropped capabilities, resource/time/output limits and ephemeral workspaces. A real container test must verify UID/GID mapping, host workspace permissions and artifact collection before untrusted code is enabled. Containers share the host kernel and are not a VM boundary.

## 5. Provider and zero-cost architecture

- NVIDIA NIM is the preferred provider integration behind a provider-neutral adapter.
- No model ID, endpoint, API compatibility, quota or free entitlement is assumed until verified against the user's account and current terms.
- The provider gateway performs cost authorization before dispatch. INR 0 is a hard ceiling, not a warning.
- Failover is permitted only to providers whose no-cost entitlement, model, quotas and caps have been independently verified and explicitly configured.
- If all eligible providers are unavailable, over quota or unverifiable, work pauses and an owner alert is generated. It does not fall back to paid inference.
- Cloudflare Workers AI remains disabled until the Cloudflare Free plan and applicable daily quotas are verified. The account connection does not currently have Billing Read permission; the account plan is therefore unknown.
- Research providers and messaging providers are subject to the same no-cost verification. Any provider with possible pay-as-you-go billing stays disabled until the zero-cost condition is proven.

## 6. Security and approval architecture

The existing threat model is retained as the baseline. The following controls are mandatory across every department:

- External webpages, issues, repositories, messages and model outputs are untrusted data; they cannot modify policy or grant tools.
- Every tool call has an authenticated principal, declared capability, resource scope, policy decision and audit record.
- Secrets are runtime-injected, least-privilege, rotated and redacted; they never enter source control, logs, prompts or memory.
- Approval records bind to an exact action hash, expire, are single-use and are revalidated at execution time.
- Agent credentials are scoped and expiring. Agents cannot grant themselves capabilities.
- Production deployments, destructive actions, permission changes, repository visibility changes and cost-bearing actions are denied without explicit approval.
- Self-evolution changes are sandboxed, screened, regression-tested and require a fresh owner approval for apply and rollback.
- Backups are encrypted; restore is tested before launch. Recovery procedures are documented and audited.

## 7. Failure, recovery and observability

- Persist the task, plan and event before dispatch.
- Use leases and heartbeats; expired leases can be reclaimed without duplicating non-idempotent side effects.
- Retry only bounded, classified transient failures with backoff. Permanent failures are terminal or moved to a dead-letter state.
- Provider adapters use timeouts, quotas, circuit breakers and health observations.
- Reconcile D1 inbox records against PostgreSQL task IDs and idempotency keys.
- Backups must be scheduled on durable storage, encrypted, monitored for freshness and restore-tested in an isolated target.
- Monitor API/worker/scheduler liveness, queue age, task latency, provider availability, budget denials, schedule drift, backup freshness, webhook failures and incident state.
- Health endpoints report real dependency readiness; no synthetic healthy response may hide a missing database, worker or provider.

## 8. Stage 1 exit gates

| Gate | Evidence currently present | Remaining work |
|---|---|---|
| Logical architecture and service boundaries | `docs/ARCHITECTURE.md` and this review | Keep contracts aligned as code evolves |
| Threat model | `docs/THREAT_MODEL.md` | Complete security review and required tests |
| Durable data model | `docs/DATA_MODEL.md` | Validate migrations against a provisioned PostgreSQL instance |
| Architecture decisions | `docs/DECISIONS.md` | Resolve proposed ADRs and record accepted hosting decision |
| Deployment and operations runbooks | `infra/worker/README.md`, Nginx and backup runbooks | Provision a qualified host and execute the runbooks |
| Recovery design | Worker leases, idempotency, backup and restore procedures documented | Execute crash-recovery and isolated restore drills |
| Zero-cost infrastructure | INR 0 policy is implemented in code/design | Verify Cloudflare plan, provider entitlements, messaging costs and durable hosting costs |
| Runtime boundary | Cloudflare production edge and separate staging data resources exist | Provision PostgreSQL/core Linux runtime; staging Worker and end-to-end bridge remain unverified |

## 9. Blocking decisions and activation gates

1. **Always-on hosting:** identify a dedicated Linux host with persistent storage and confirm its total operating cost is INR 0. A free plan or account label alone is insufficient evidence.
2. **PostgreSQL:** select and provision a persistent PostgreSQL target only after its free eligibility, sleep/availability behavior, backups, connection limits and data retention are verified. No production migration before export/restore rehearsal.
3. **Cloudflare plan:** verify Free-plan status and no paid subscription/billing requirement in the dashboard. The connected API identity cannot read billing state.
4. **NVIDIA NIM:** verify the actual account/model free entitlement and finite monthly request/token caps. Do not send inference before this gate.
5. **Messaging:** verify Telegram and WhatsApp operating costs and account eligibility; keep WhatsApp disabled if any charge is possible under the intended use.
6. **Sandbox:** provision a dedicated Linux rootless Docker host and verify the actual container boundary before enabling generated/untrusted code.
7. **Public access:** domain, DNS, TLS, firewall and authentication must be configured and tested before public exposure.
8. **Repository governance:** enforce the required CI check on `main`; the implementation ledger reports that branch protection is not yet enabled.

## 10. Explicit non-goals for this stage

- No production Worker deployment, webhook ownership change, D1 migration, queue cutover or secret rotation.
- No inference activation or paid-resource provisioning.
- No PostgreSQL production migration or data deletion.
- No public port exposure.
- No dashboard implementation.
- No claim that any unverified department is operational.

## Review conclusion

The repository has a coherent architecture baseline and substantial implementation foundations. The architecture is suitable to guide Stages 2–10, subject to the blocking decisions above. Stage 1 is **design-reviewed but not certified complete** until the hosting, PostgreSQL, zero-cost entitlement, recovery and security review gates are resolved and recorded. Runtime activation remains a separate acceptance decision.
