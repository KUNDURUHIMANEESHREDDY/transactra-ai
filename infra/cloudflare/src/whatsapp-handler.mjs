/**
 * WhatsApp Business Cloud API webhook handler.
 * Implements GET verification (hub.mode, hub.verify_token, hub.challenge)
 * and POST payload ingestion with D1 event logging.
 */

export function handleWhatsAppVerification(url, env) {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  const expectedToken = env.WHATSAPP_VERIFY_TOKEN || env.TELEGRAM_WEBHOOK_SECRET;

  if (mode === "subscribe" && token && expectedToken && token === expectedToken) {
    return new Response(challenge, {
      status: 200,
      headers: { "content-type": "text/plain" }
    });
  }

  return new Response("Forbidden", { status: 403 });
}

export async function handleWhatsAppWebhook(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }

  const entries = body?.entry || [];
  const now = new Date().toISOString();
  let ingested = 0;

  for (const entry of entries) {
    const changes = entry?.changes || [];
    for (const change of changes) {
      if (change?.field === "messages") {
        const messages = change?.value?.messages || [];
        for (const msg of messages) {
          const messageId = String(msg.id || crypto.randomUUID());
          const sender = msg.from;
          const text = msg.text?.body || "";

          // Record in inbound_events
          if (env.DB) {
            await env.DB.prepare(`
              INSERT OR IGNORE INTO inbound_events (source, source_event_id, event_type, payload_json, received_at)
              VALUES ('whatsapp', ?, 'whatsapp.message', ?, ?)
            `).bind(
              messageId,
              JSON.stringify({ from: sender, text, raw: msg }),
              now
            ).run();
            ingested++;
          }
        }
      }
    }
  }

  return new Response(JSON.stringify({ ok: true, ingested }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
