# Telegram control channel

Production Telegram delivery is owned exclusively by the Cloudflare Worker
`transactra-edge`. Telegram sends updates to the Worker webhook, the Worker validates
Telegram's secret-token header, queues each update, persists it in production D1, and sends
the owner reply through the Telegram Bot API.

## Production ownership

- Webhook endpoint: `https://transactra-edge.himaneeshreddyk.workers.dev/telegram/webhook`.
- Production secrets are held by the Cloudflare Worker: `TELEGRAM_BOT_TOKEN` and
  `TELEGRAM_WEBHOOK_SECRET`.
- The Worker is the only production webhook registrar and receiver.
- Do not configure AppDeploy, a VM, or another service to call `setWebhook` or
  `deleteWebhook` for the production bot.
- Do not run the legacy `npm run start:telegram` long-polling transport. It is disabled
  and exits without calling Telegram.
- On an already-provisioned VM, stop and permanently disable the installed unit:

  ```bash
  sudo systemctl disable --now transactra-telegram.service
  sudo systemctl mask transactra-telegram.service
  sudo systemctl daemon-reload
  ```
- The staging deployment workflow may configure only its separate staging bot. It must
  never receive the production bot token.

## Delivery path

1. Telegram posts an update to `POST /telegram/webhook`.
2. The Worker validates `X-Telegram-Bot-Api-Secret-Token` before accepting the body.
3. The Worker enqueues the update on `transactra-events` and acknowledges the webhook.
4. The production Queue consumer writes the idempotent inbound event to D1.
5. The consumer writes the owner reply to `telegram_reply_outbox`, calls
   `sendMessage`, and marks the outbox row sent.

## Security and operations

- Only private-chat messages from the configured owner ID are accepted by command handling.
- Never expose the bot token or webhook secret in logs, source files, diagnostics, or chat.
- Verify the live webhook with Telegram `getWebhookInfo` using the Cloudflare-held token.
- A production acceptance test requires a fresh real Telegram command, its matching D1
  inbound event, a sent reply-outbox row, and confirmation that the reply arrived in Telegram.
- Mem0 synchronization is a separate acceptance check; a healthy Telegram round trip does
  not prove that a memory was synchronized to Mem0.
