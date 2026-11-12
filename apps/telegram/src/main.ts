process.stdout.write(JSON.stringify({
  event: 'telegram_transport_disabled',
  delivery_owner: 'transactra-edge',
  reason: 'Production Telegram updates are delivered exclusively by the Cloudflare Worker.',
}) + '\n');
