# Transactra

**Payments, understood.** Transactra is a Telegram-first AI payment assistant backed by PayPal Checkout. Send a payment request in chat, review the extracted details, approve the draft, complete PayPal buyer approval, and ask the bot to capture the order.

Built for the PayPal AI Hackathon using the free PayPal Sandbox.

## Telegram-first demo flow

1. Message your private Transactra bot: “Pay $24.50 to Alex for dinner”, or send a multi-step instruction separated by semicolons/new lines/“then”.
2. The assistant extracts amount, currency, recipient label and purpose. The built-in parser works without an AI-provider key; an optional OpenAI-compatible model endpoint can be configured.
3. For a workflow, review all 2–8 ordered steps and currency totals, then tap **Approve entire plan** or **Reject plan**. For a single payment, approve or discard its draft.
4. Tap **Open PayPal checkout** and sign in with a PayPal Sandbox personal test account.
5. Return to Telegram and tap **I've completed PayPal approval**. The server captures through PayPal Orders API v2.
6. For a multi-step plan, Transactra creates one PayPal order at a time. After each PayPal-confirmed capture, it advances to the next approved step; `/history` and `/summary` show recorded results.

See [Agentic payment workflows](docs/AGENTIC-PAYMENT-WORKFLOWS.md) for the approval state machine and supported instruction syntax.

The web app is an optional dashboard, not a requirement for day-to-day control.

## Important payment semantics

This first-party merchant checkout charges the merchant account associated with the configured PayPal app. The recipient entered in the prompt is stored as a transaction label; it does not itself route money to that person. Third-party payee routing requires an eligible PayPal multiparty/platform integration and seller onboarding. No fake payment-success states are used.

## Stack

React + TypeScript + Tailwind CSS v4 (Vite), Node.js TypeScript API, Telegram Bot API (long polling), PayPal JavaScript SDK + Orders API v2, PostgreSQL ledger, optional OpenAI-compatible model endpoint.

## Requirements

Node.js 22+, Docker Desktop or PostgreSQL 16+, a Telegram bot token and owner Telegram user ID, and a PayPal Developer account with a Sandbox REST app and Sandbox personal test account.

## Local setup

1. Run `npm install`.
2. Start PostgreSQL: `docker compose up -d postgres`.
3. Copy `.env.example` to `.env`.
4. Create a bot with [@BotFather](https://t.me/BotFather), then set `TELEGRAM_BOT_TOKEN`. Find your numeric user ID with [@userinfobot](https://t.me/userinfobot) and set `TELEGRAM_OWNER_ID`.
5. Add PayPal Sandbox client ID and secret from https://developer.paypal.com/dashboard/applications/sandbox.
6. Set `TOKEN_ENCRYPTION_SECRET` to at least 32 random bytes and set a separate strong `BACKEND_SHARED_SECRET` (shared by the API and Telegram bot; also the Cloudflare Worker when used).
7. Set `API_BASE_URL` and `PAYPAL_REDIRECT_URI` to your API's HTTPS origin in production; use the local defaults only for local development.
8. Run `npm run dev:api`.
9. In another terminal run `npm run start:telegram`.
10. Open your bot in Telegram, send `/start`, then send `connect paypal` to link your PayPal account.

See [Telegram setup and operations](docs/TELEGRAM.md) for details. The optional web dashboard runs with `npm run dev` at http://localhost:5173.

## PayPal integration

- Sandbox REST host: https://api-m.sandbox.paypal.com
- OAuth: `POST /v1/oauth2/token` using server-held credentials.
- Create: `POST /v2/checkout/orders` with intent CAPTURE.
- Buyer approval: PayPal-hosted approval link opened from Telegram.
- Capture: `POST /v2/checkout/orders/{id}/capture` after buyer approval.
- `PayPal-Request-Id` is sent on order creation.
- Completion status comes from PayPal's capture response.

## Optional AI model

Configure `CLOUDPILOT_INFERENCE_URL`, `CLOUDPILOT_INFERENCE_SECRET` and `AI_MODEL` to route payment-intent extraction through the CloudPilot Edge inference endpoint. The URL must point to CloudPilot's authenticated OpenAI-compatible `/chat/completions` route; the secret must match the Cloudflare Worker secret and must never be committed. If CloudPilot is not configured, the optional legacy `AI_BASE_URL` + `AI_API_KEY` endpoint remains available. If the model endpoint is unavailable, Transactra falls back to its deterministic local parser. Payment approval and execution remain entirely in Transactra.

## Security

- The bot accepts private messages only from `TELEGRAM_OWNER_ID`.
- Never commit `.env`, the Telegram bot token, PayPal secret or model API key.
- PayPal secrets stay on the API server; the bot never requests PayPal login credentials.
- OAuth access/refresh tokens are encrypted with AES-256-GCM using the required `TOKEN_ENCRYPTION_SECRET`; there is no default-key fallback.
- Use Sandbox credentials only. Do not enable live payments without a separate security and product review.
- A Telegram bot token grants control of the bot. Keep it in a local environment file or production secret manager.

## Scripts

- `npm run dev:api` — API
- `npm run start:telegram` — Telegram bot
- `npm run dev` — optional frontend dashboard
- `npm run typecheck` — TypeScript validation
- `npm run build` — production build
- `npm test` — tests
