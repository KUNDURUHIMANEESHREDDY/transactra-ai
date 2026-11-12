# Transactra Control Center

The web console is the operational dashboard for the Transactra payment and agent platform. It is read-only: it never creates, approves, captures, cancels, or retries a payment and it never changes agent state.

## Telegram authentication

- The owner sends `/dashboard` to the allowlisted Transactra Telegram bot.
- The bot replies with a Telegram Mini App button pointing at `DASHBOARD_URL` (HTTPS only).
- The frontend reads Telegram Mini App `initData`; it never trusts client-supplied user IDs.
- `POST /api/auth/telegram/session` validates Telegram's HMAC signature, `auth_date` freshness (five-minute maximum), and Telegram user ID.
- On success, the API issues an eight-hour HMAC-signed `HttpOnly; SameSite=Lax` session cookie. In production it is also `Secure`.
- `GET /api/auth/session` checks the session; `POST /api/auth/telegram/logout` clears the browser cookie.
- Observability endpoints accept either the trusted signed gateway identity or the server-issued session cookie.
- The bot remains owner-allowlisted. The browser never receives the bot token, backend shared secret, or session signing key.

Required environment configuration:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_USERNAME` (used for the unauthenticated "Open in Telegram" link)
- `DASHBOARD_URL` (public HTTPS Mini App URL)
- `TRANSACTRA_AUTH_HEADER_SECRET` (dedicated random server-only secret, at least 32 characters)

Apply pending PostgreSQL migrations before starting the API: `node --env-file=.env --import tsx apps/control-plane/src/migrate.ts`. Migration `0008_financial_policy_hardening` is required by the payment API guard.

## Frontend

- Default web route: Control Center.
- Existing payment desk remains available at `/?view=payments`.
- Transaction, agent, log, trace, financial-policy, and integration views refresh every 15 seconds.
- No demo transactions or fabricated telemetry are rendered. Empty states remain empty until the API returns real records.
- Vite development server proxies `/api` to `http://127.0.0.1:8787`; production must route the same-origin `/api/*` path to the API service.

## Observability API

- `GET /api/auth/session`
- `POST /api/auth/telegram/session`
- `POST /api/auth/telegram/logout`
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
- Telegram initData is verified server-side with the bot token and rejected when older than five minutes.
- Session cookies are signed with a dedicated server-only secret; never add that secret to frontend variables.
- The session is time-limited to eight hours; logout clears the browser cookie.
- Confirm the production gateway routes same-origin `/api/*` to the API and sets HTTPS before enabling the Mini App.
- Confirm that each user's `owners.external_subject` and `payment_transactions.user_id` use the `telegram:<numeric-id>` identity convention.
