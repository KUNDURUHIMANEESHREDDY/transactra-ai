# Telegram-first control

Telegram is the primary operating interface for Transactra. The React web app remains an optional activity dashboard; payment requests, approvals, transaction history and summaries are available in the bot.

## First-time setup

1. In Telegram, open [@BotFather](https://t.me/BotFather), run `/newbot`, and copy the bot token.
2. Open [@userinfobot](https://t.me/userinfobot) and copy your numeric Telegram user ID.
3. Copy `.env.example` to `.env`.
4. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_ID`. Keep the bot token private.
5. Configure PayPal Sandbox credentials and PostgreSQL as described in the main README.
6. Start the API with `npm run dev:api`.
7. In a second terminal, start the bot with `npm run start:telegram`.
8. Open your bot in Telegram and send `/start`.

The bot uses Telegram long polling. It accepts commands only from the configured owner ID in a private chat. No public webhook or Telegram hosting service is required for local development.

If a webhook is already registered for this bot, the poller will stop rather than silently replace it. To deliberately switch this bot from webhook delivery to polling, set `TELEGRAM_CLEAR_WEBHOOK=true` for one startup, start the bot, then return it to `false`. Do not do this if another production service is intended to own the webhook.

## What you can do in Telegram

- Send natural-language payment requests, such as `Pay $25 to Alex for dinner`.
- Review amount, currency, recipient label and purpose.
- Approve or discard a payment draft using inline buttons.
- Open the PayPal Sandbox approval page from the chat.
- Return to Telegram and ask Transactra to capture the approved order.
- Use `/history` for recent transactions.
- Use `/summary` for confirmed captured totals.
- Use `/cancel` to clear unsubmitted drafts.
- Use `/help` to see commands.

The capture callback carries the PayPal order ID and reads the transaction from PostgreSQL, so the user can return to the chat after a bot restart.

## Payment approval boundary

Telegram is the control plane, but PayPal buyer approval still happens on PayPal's secure checkout page (opened from a Telegram inline URL button). The bot never asks for PayPal passwords, card numbers, client secrets or one-time codes. After buyer approval, the bot calls the server-side PayPal Orders API capture endpoint. A payment is reported as completed only when PayPal returns a completed capture.

The recipient in a natural-language request is a transaction label in this first-party merchant checkout. It does not route funds to an arbitrary third party. Marketplace payouts require a separately approved PayPal multiparty/platform integration.

## Runtime

- API: `npm run dev:api`
- Telegram bot: `npm run start:telegram`
- Optional dashboard: `npm run dev`
- API base URL for the bot: `API_BASE_URL` (defaults to `http://127.0.0.1:8787`)

For production, run the API and bot as supervised services on a trusted host, keep both bound to private/internal networking, use a managed PostgreSQL database, and store all secrets in the host's secret manager. Do not commit `.env`.

## Production webhook via Cloudflare Worker

The API exposes `POST /telegram/webhook` for the deployed Cloudflare gateway. The gateway authenticates Telegram's `X-Telegram-Bot-Api-Secret-Token`, then forwards the update with `X-Transactra-Edge-Secret`. The API validates that shared secret before passing the update to the same owner-allowlisted bot handlers used by polling.

1. Deploy the Node API to a public HTTPS host and configure PostgreSQL, PayPal credentials, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_ID`, and a strong random `BACKEND_SHARED_SECRET`. Set `API_BASE_URL` to the API's own reachable base URL (for example, `http://127.0.0.1:8787` when the bot handler runs inside that API process).
2. In Cloudflare Worker `transactra-telegram`, add these as encrypted secrets/variables:
   - `API_ORIGIN`: public HTTPS base URL of the deployed Node API (no trailing slash).
   - `BACKEND_SHARED_SECRET`: exactly the same random value configured on the API.
   - `TELEGRAM_WEBHOOK_SECRET`: a separate random value (1–256 characters, using Telegram's allowed characters).
3. Confirm `GET https://transactra-telegram.himaneeshreddyk.workers.dev/health` reports `backendConfigured: true`.
4. Register the Telegram webhook URL `https://transactra-telegram.himaneeshreddyk.workers.dev/telegram/webhook` with Bot API `setWebhook`, supplying the separate `TELEGRAM_WEBHOOK_SECRET` as `secret_token` and allowed updates `message` and `callback_query`. Keep the bot token and secret out of source control and chat logs.
5. Verify by sending `/start` to the bot, then check the Worker and API logs.

Do not run `npm run start:telegram` while the webhook is registered: Telegram will not deliver updates through long polling at the same time. To return to polling, deliberately delete the webhook first (the poller has a one-time `TELEGRAM_CLEAR_WEBHOOK=true` switch).

The API webhook endpoint is not publicly usable without the Worker-to-API shared secret. The Worker must be configured before registering Telegram's webhook. The Cloudflare Worker is only a gateway; it does not host the Node API or PostgreSQL database.
