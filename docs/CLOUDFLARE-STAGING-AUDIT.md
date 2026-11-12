# Transactra Cloudflare-native staging audit

**Audit date:** 2026-11-09  
**Repository:** `KUNDURUHIMANEESHREDDY/transactra`  
**Branch:** `main`  
**Scope:** Read-only verification of Worker, D1, Queue and repository staging configuration. No Cloudflare resource was changed.

## Executive result

**Result: staging is not deployable yet.**

The repository contains a separate staging configuration, but the live Cloudflare account does not yet contain a deployed staging Worker or an initialized staging D1 schema. Staging queues exist but are not attached to a producer or consumer. The production Worker is the only registered Worker returned by the account API.

The Cloudflare account plan remains unverified because the connected API identity cannot read billing state. No inference, staging deployment, webhook registration or production change is authorized by this audit.

## Live account evidence

| Resource | Read-only result | Interpretation |
|---|---|---|
| Workers | Only `transactra-edge` returned | `transactra-edge-staging` is not deployed |
| Production D1 | `transactra`, 10 application tables plus Cloudflare internal tables | Existing production records/schema must be preserved |
| Staging D1 | `transactra-staging`, only `_cf_KV` present; API reports 0 application tables | Staging migrations have not been applied |
| Production queue | `transactra-events`, one producer and one consumer on `transactra-edge` | Existing production path remains active |
| Production DLQ | `transactra-events-dlq`, no consumer | DLQ exists; replay procedure remains an operational gate |
| Staging queue | `transactra-events-staging`, zero producers and zero consumers | Not connected to a staging Worker |
| Staging DLQ | `transactra-events-dlq-staging`, zero producers and zero consumers | Not connected to a staging Worker |

Repository staging bindings were checked against the live account:
- D1 ID matches `transactra-staging`: `e7292f55-c90e-4d34-8b77-c97c3e5ec15a`.
- Primary queue name matches `transactra-events-staging`.
- DLQ name matches `transactra-events-dlq-staging`.
- Staging config deliberately has no AI binding.

## Existing Telegram task path

The current Worker source persists an inbound Telegram event, task, task event, task-run and run-event in D1 before calling the existing planner API. The external planner creates its PostgreSQL task and approval record. The Worker then links the planner task and approval IDs back into D1. Approval and rejection commands call the planner's approval API.

This is a **transitional bridge**, not yet a D1-native planner. The Cloudflare architecture ADR now explicitly documents the boundary:
- D1 is authoritative for Cloudflare ingress, event and execution-ledger records.
- The legacy PostgreSQL planner remains authoritative for its task execution and approval state until a D1-native planner passes parity and recovery tests.
- If the planner endpoint or credentials are unavailable, the D1 task must remain held and non-executable.
- Staging must use a dedicated staging planner endpoint and credentials; production credentials and the production Telegram bot must not be reused.

The connected environment has not verified a reachable staging planner HTTPS endpoint or staging API/approval credentials. Therefore the end-to-end Telegram-to-planner staging acceptance test cannot run yet.

## Safety gates still open

1. Owner verifies Cloudflare Free plan and no paid subscription/billing requirement in Dashboard → Billing → Subscriptions. API billing-read access is unavailable.
2. Staging planner HTTPS endpoint and staging-only API/approval credentials are available and independently verified as INR 0.
3. Staging D1 migrations are reviewed and applied only after Gate 1.
4. A distinct staging Worker is deployed with staging-only bindings/secrets; never register the production Telegram bot on it.
5. Verify duplicate Telegram update idempotency, D1 event/run persistence, planner handoff, approval and rejection, queue retry/DLQ, and failure recovery.
6. Verify production Worker, D1, queues, webhook and secrets are unchanged.
7. Obtain separate owner approval before any production cutover.

## Next implementation sequence

1. Keep production untouched and complete source-level contract/tests for the D1-to-planner bridge.
2. Verify staging planner availability and no-cost eligibility; if unavailable, keep the staging bridge blocked rather than targeting production.
3. After the account Free-plan gate, apply reviewed migrations to staging D1 and deploy only the staging Worker.
4. Run staging acceptance tests and record evidence.
5. Continue the D1-native planner migration as a separate parity-gated change; do not silently switch canonical execution state.

## Non-actions

This audit did not deploy a Worker, apply a remote migration, write D1 data, change queue configuration, create secrets, call Telegram, register a webhook, activate AI, or touch production.
