# Architecture decision records

## ADR-0001: One branch for Transactra
- **Status:** Accepted (owner instruction)
- **Decision:** Commit all Transactra repository work directly to `main`. Do not create additional branches.
- **Consequence:** Use small, reviewable commits and CI on main. No feature, release, staging, or hotfix branches.

## ADR-0002: Dashboard is Stage 11
- **Status:** Accepted (product requirement)
- **Decision:** The web dashboard is the final implementation stage and cannot be a dependency for autonomous operation.
- **Consequence:** Stable APIs and messaging/local channels precede dashboard work.

## ADR-0003: Hard zero-spend policy
- **Status:** Accepted (product requirement)
- **Decision:** Monthly authorized spend is INR 0. Paid provider requests are denied; fallback must not incur cost.
- **Consequence:** Provider unavailability pauses work rather than triggering paid usage.

## ADR-0004: PostgreSQL as durable system of record
- **Status:** Proposed
- **Decision:** Use PostgreSQL migrations for durable task, event, identity, approval, memory metadata and audit state; add pgvector for embeddings when supported.
- **Consequence:** Verify actual hosting/free-tier capability and backup/restore path before production infrastructure selection.

## ADR-0005: NVIDIA NIM provider boundary
- **Status:** Proposed pending credentials and entitlement verification
- **Decision:** Implement NVIDIA NIM behind a provider-neutral interface. Do not assume a specific model ID, API compatibility, quota, or no-cost availability until tested against current account terms.
- **Consequence:** Fail closed if configuration, authentication, model availability, or spend authorization cannot be verified.
