# Transactra delivery roadmap

These stages are the implementation order for the **complete product**. They are not optional feature tiers. All work is committed directly to the single `main` branch; no other branches are to be created.

| Stage | Scope | Exit evidence |
|---|---|---|
| 1 | Complete architecture and infrastructure design | ADR-0006, Cloudflare-native service boundaries, D1 target model, threat model, operations/recovery model and read-only live inventory recorded in STAGE-1-ARCHITECTURE-BASELINE.md |
| 2 | GitHub repository and project scaffolding | Reproducible install/build/test, CI, security baseline, private repo and main-only workflow |
| 3 | Core orchestrator and persistent memory | Durable task state, scheduler, event log, memory retrieval, crash recovery and idempotency tests |
| 4 | NVIDIA NIM integration and provider failover | Real authenticated adapter, health/capability checks, zero-cost policy enforcement, timeout/retry/circuit-breaker tests |
| 5 | Multi-agent execution framework | Specialist registry, delegation, concurrency limits, tool permissions, evaluation, cancellation and audit |
| 6 | Autonomous GitHub engineering engine | Issues, repository analysis, coding workspace, tests, reviews, PRs, guarded merges and deployment workflows |
| 7 | Research and product intelligence | Source-backed trends, competitor evidence, opportunity scoring, provenance and daily recommendations |
| 8 | 48-hour project generation | Scheduled discovery/build pipeline, reproducible scoring, 90/100 threshold, private repo handling and approval gates |
| 9 | Self-evolution | Health audits, improvement proposals, sandboxed changes, regression validation, approval, rollout and rollback |
| 10 | Operations and non-dashboard control channels | Monitoring, recovery, security, backups, Telegram, WhatsApp, local and authenticated encrypted public access |
| 11 | Web dashboard | Complete dashboard/control center, built only after backend and messaging channels are independently operational |

## Global acceptance gates
Every stage includes implementation, tests, observability, security review, operational documentation, and a recorded pass/fail result. No placeholder adapters or simulated successful operations count as completion. A failed gate blocks production activation, not the overall product scope.

## Current status

The implementation is in progress. The following states are evidence-based; see [docs/IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for file-level detail and verification limits.

| Stage | Current state | Main remaining acceptance gate |
|---|---|---|
| 1. Architecture | Design baseline verified and reconciled to accepted Cloudflare ADR; live Worker/D1/Queue and GitHub inventory recorded | Runtime activation gates are tracked separately: Free-plan/quota verification, staging bridge prerequisites, security/restore drills and repository governance |
| 2. Repository scaffolding | TypeScript monorepo, migrations and manual CI workflow exist | Reproducible lockfile, full build/test run and CI result |
| 3. Orchestrator and memory | Durable tasks, worker leases, event log, full-text memory, local embeddings and a relational knowledge graph exist | Live PostgreSQL recovery tests, idempotency verification, measured retrieval quality |
| 4. Provider integration | NIM adapter, optional verified-compatible adapter, quotas, circuit breakers and health telemetry exist | Live zero-cost NIM configuration and a separately verified secondary provider |
| 5. Multi-agent framework | DAG planning, specialist and generic executors, approval gates, a shared tool gateway, execution-reliability scoring and a dynamic agent registry with lifecycle transitions exist | Live worker verification, dynamic agent execution and output-quality evaluation |
| 6. GitHub engineering | GitHub App tools and repository operations exist; isolated Docker runner exists as a separate primitive | Wire sandbox into repository engineering, validate real test execution, activate GitHub App and deployment gates |
| 7. Research intelligence | Research/evidence/scoring code exists and evidence is persisted | Live source credentials, provenance validation and daily recommendations |
| 8. 48-hour project generation | Scheduler and 90-point quality-gate code exist | Live schedule, validated project build, private repository creation and deployment |
| 9. Self-evolution | Durable health audit, guarded change-set validation, sandbox verification, approval-gated apply/rollback and CI status reading exist | A verified end-to-end proposal: sandboxed validation, approval, applied commit, passing CI and rollback |
| 10. Operations and channels | Channel code with one shared command surface and durable notification dispatch, loopback/Nginx ingress, provider telemetry, encrypted backup scripts, incident handling, operations monitoring and approval-gated deployment rollback exist | Live Telegram/WhatsApp/local delivery, deployed TLS ingress, scheduled backups, restore drill, alerts and recovery |
| 11. Web dashboard | Embedded dependency-free control centre with a per-request CSP nonce, served from the control plane, exists and parses/executes cleanly | A live authenticated data view against a provisioned database |

- [x] Target repository confirmed: `KUNDURUHIMANEESHREDDY/transactra` (private).
- [x] Single-branch policy recorded: `main` only.
- [x] Organisation layer implemented: dynamic workforce lifecycle, self-evolution, deployment gates, notification dispatch, incident handling and control-plane read/write surface.
- [x] Stage 1 design and read-only infrastructure baseline completed; runtime activation is deliberately not certified by a design review. See STAGE-1-ARCHITECTURE-BASELINE.md.
- [ ] No runtime stage is certified complete end to end: remaining gates depend on account entitlements, staging deployment, credentials or live acceptance tests.

A checked item means evidence exists in the repository; it must not be inferred from a plan alone.
