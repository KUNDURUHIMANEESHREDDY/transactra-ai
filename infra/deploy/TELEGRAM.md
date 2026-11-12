# Telegram delivery ownership

This file is retained as a historical incident record only. Its former VM long-polling
instructions are retired.

Production Telegram delivery is now owned exclusively by the Cloudflare Worker
`transactra-edge`. Do not start `transactra-telegram.service`, run
`npm run start:telegram`, or configure any AppDeploy/VM process to call
`setWebhook` or `deleteWebhook` for the production bot.

The production webhook endpoint is
`https://transactra-edge.himaneeshreddyk.workers.dev/telegram/webhook`.
The Worker validates the Telegram secret-token header, queues updates, persists them in
production D1, and sends owner replies through the Telegram Bot API.

The separate staging deployment workflow may configure only its dedicated staging bot.
Never use the production bot token in staging.

A successful production acceptance test requires a real owner command, its matching D1
inbound event, a sent Telegram reply-outbox record, and confirmation that the reply arrived
in Telegram. Mem0 synchronization must be verified separately.
