# PayPal OAuth authentication gateway contract

The API does not implement end-user login. The existing control-plane bearer token is a shared operator credential, not a per-user browser session. PayPal OAuth routes therefore accept identity only from a trusted edge authentication gateway.

## Required gateway behavior

1. Authenticate the browser using the application's real identity provider and its server-side session.
2. Strip all incoming `x-transactra-auth-*` headers before forwarding the request.
3. On every request to `/api/auth/paypal/*`, inject:
   - `x-transactra-auth-user`: stable authenticated subject (1–128 allowed identifier characters).
   - `x-transactra-auth-session`: stable, unpredictable session ID (32–256 base64url characters); retain the same ID across the PayPal redirect/callback.
   - `x-transactra-auth-timestamp`: current Unix epoch in milliseconds.
   - `x-transactra-auth-signature`: lowercase/uppercase hex HMAC-SHA256 of `userId + "\n" + sessionId + "\n" + timestamp`.
4. Sign with `AUTH_GATEWAY_SHARED_SECRET`, a randomly generated secret of at least 32 characters, configured identically in the gateway and API.
5. Keep the API private behind the gateway. Do not expose the API listener directly to the public internet.

The API rejects missing, malformed, stale, or incorrectly signed assertions. A browser-supplied user ID or session ID is never trusted directly.

## Redirect policy

The OAuth callback always returns to the single configured `FRONTEND_URL`. The `redirect_url` query parameter is rejected unless it exactly matches that configured URL. The API callback URI must be explicitly configured with `PAYPAL_REDIRECT_URI` and must use HTTPS outside local development. Request Host headers are not used to construct OAuth redirect URIs.

## Deployment gates

Set `AUTH_GATEWAY_SHARED_SECRET`, `TOKEN_ENCRYPTION_SECRET`, `API_BASE_URL`, `PAYPAL_REDIRECT_URI`, and `FRONTEND_URL` before enabling OAuth. The repository currently contains no identity provider or gateway implementation; this contract must be wired to the deployed authentication gateway before real users can connect accounts.
