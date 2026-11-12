# Transactra Control Center

The web console is the operational dashboard for the Transactra payment and agent platform. It is read-only: it never creates, approves, captures, cancels, or retries a payment and it never changes agent state.

## Frontend

- Default web route: Control Center.
- Existing payment desk remains available at `/?view=payments`.
- Transaction, agent, log, trace, financial-policy, and integration views refresh every 15 seconds.
- No demo transactions or fabricated telemetry are rendered. Empty states remain empty until the API returns real records.

## Observability API

All routes are GET-only and require a valid signed workspace identity accepted by `getAuthenticatedUser`. The browser must not receive `TRANSACTRA_AUTH_HEADER_SECRET`; a trusted authentication gateway must inject the signed identity headers.

- `GET /api/observability/overview`
- `GET /api/observability/transactions?limit=100`
- `GET /api/observability/agents`
- `GET /api/observability/logs?limit=100`
- `GET /api/observability/traces?limit=100`
- `GET /api/observability/policies?limit=100`
- `GET /api/observability/integrations`

The API scopes payment rows to the authenticated `payment_transactions.user_id` and orchestrator records to the owner whose `owners.external_subject` matches the signed identity. Query limits are capped at 200. Arbitrary task payloads and audit details are not returned by default.

## Data sources

- Payments: `payment_transactions`
- Agent inventory and task metrics: `agents`, `tasks`
- Agent/system events: `task_events`, `tool_invocations`, `audit_events`
- Financial policy decisions: `financial_policy_audit`
- Provider health: `provider_health`

Execution traces currently represent recorded tool invocations, including correlation IDs, policy metadata, outcomes, and elapsed time. This is not yet full OpenTelemetry span ingestion; instrumenting every model, scheduler, queue, and provider boundary is a separate observability expansion.

## Security and rollout notes

- Observability endpoints are read-only.
- Requests without a valid signed identity receive HTTP 401.
- The dashboard must be served behind the trusted identity gateway; never add a client-side shared secret.
- Confirm that the production gateway signs the same identity value used by `owners.external_subject` and `payment_transactions.user_id` before enabling the dashboard for multiple users.
- Verify the API reverse proxy routes `/api/observability/*` to the Transactra API.
