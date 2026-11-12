# Transactra

**Payments, understood.** Transactra is a Telegram-first AI payment assistant backed by PayPal Checkout. Send a payment request in chat, review the extracted details, approve the draft, complete PayPal buyer approval, and ask the bot to capture the order.

Built for the PayPal AI Hackathon using the free PayPal Sandbox.

## Telegram-first demo flow

1. Message your private Transactra bot: “Pay $24.50 to Alex for dinner”.
2. The assistant extracts amount, currency, recipient label and purpose. The built-in parser works without an AI-provider key; an optional OpenAI-compatible model endpoint can be configured.
3. Review the payment summary and tap **Approve & continue** or **Discard**.
4. Tap **Open PayPal checkout** and sign in with a PayPal Sandbox personal test account.
5. Return to Telegram and tap **I've completed PayPal approval**. The server captures through PayPal Orders API v2.
6. Ask for `/history` or `/summary` to inspect transactions.

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
6. Run `npm run dev:api`.
7. In another terminal run `npm run start:telegram`.
8. Open your bot in Telegram and send `/start`.

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

Set `AI_BASE_URL`, `AI_API_KEY` and `AI_MODEL` to use an OpenAI-compatible `/chat/completions` endpoint. If omitted or unavailable, Transactra falls back to its local parser. No external AI key is needed for the core demo.

## Security

- The bot accepts private messages only from `TELEGRAM_OWNER_ID`.
- Never commit `.env`, the Telegram bot token, PayPal secret or model API key.
- PayPal secrets stay on the API server; the bot never requests PayPal login credentials.
- Use Sandbox credentials only. Do not enable live payments without a separate security and product review.
- A Telegram bot token grants control of the bot. Keep it in a local environment file or production secret manager.

## Scripts

- `npm run dev:api` — API
- `npm run start:telegram` — Telegram bot
- `npm run dev` — optional frontend dashboard
- `npm run typecheck` — TypeScript validation
- `npm run build` — production build
- `npm test` — tests
