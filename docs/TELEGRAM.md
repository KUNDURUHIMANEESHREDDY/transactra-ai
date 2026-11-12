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
