# Secure public ingress

This Nginx site template exposes only the authenticated Transactra API and the signed WhatsApp webhook. It does not expose the control plane's unauthenticated health endpoints or arbitrary paths. It uses the modern `http2 on;` directive and requires Nginx 1.25.1 or later.

## Required host configuration

1. Use a dedicated Linux host with a firewall. Do not expose ports 8787 or 3001 publicly.
2. Keep the Transactra control plane bound to `127.0.0.1:8787`.
3. Keep the WhatsApp webhook process bound to `127.0.0.1:3001` (the default).
4. Replace every `transactra.example.com` occurrence with a domain you control.
5. Provision a valid TLS certificate and confirm the certificate paths match the Nginx configuration.
6. Install the file under the Nginx `http {}` include directory and run `nginx -t` before reloading.
7. Confirm the firewall allows inbound 80/443 only and denies direct inbound access to 8787/3001.
8. Set `PUBLIC_BASE_URL=https://your-domain` and `WHATSAPP_WEBHOOK_PATH=/webhook` in the Transactra environment.
9. Configure the Meta webhook callback URL as `https://your-domain/webhook`; the application verifies Meta's HMAC signature and sender allowlist.

## Security notes

- API bearer authentication remains enforced by the control plane; TLS at Nginx does not replace application authentication.
- The WhatsApp webhook is not bearer-authenticated at the proxy because Meta signs each payload; signature validation remains mandatory in the application.
- Rate limits are conservative defaults and must be tuned against the verified provider retry behavior.
- Health endpoints are restricted to loopback. Do not add a public exception without a separate authenticated monitoring path.
- This template does not create a domain, issue certificates, configure DNS, open firewall ports, or deploy services.
