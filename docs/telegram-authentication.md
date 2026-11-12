# Telegram authentication for Transactra

Transactra web sign-in uses the official Telegram Login Widget. No separate email/password provider or client-supplied user ID is trusted.

## Configure Telegram

1. Create or select the Transactra bot with @BotFather.
2. Run `/setdomain` for that bot and register the exact production web-app domain (without a path).
3. Set `TELEGRAM_BOT_USERNAME` to the bot's public username (without @).
4. Set `TELEGRAM_BOT_TOKEN` to the bot token on the API server only. Never expose it to the browser.
5. Apply migrations through `0007_telegram_web_auth.sql`.

## Sign-in and session flow

1. Telegram Login Widget returns a signed user payload to the browser.
2. The API verifies the Telegram HMAC using the bot token, enforces a five-minute auth-date window, and rejects malformed signatures.
3. A signed payload hash is consumed once to prevent login-payload replay.
4. The API creates a random, seven-day server-side session. Only its SHA-256 hash is stored in PostgreSQL.
5. The browser receives an HttpOnly, SameSite=Lax cookie (Secure and __Host- prefixed in production).
6. Logout revokes the server-side session. Expired/revoked sessions are rejected.
7. PayPal OAuth state stores the Telegram user ID and session hash. The callback must arrive with the same live Telegram session; another Telegram user or browser session cannot consume it.

Telegram user IDs are the stable Transactra user IDs. The bot's existing `TELEGRAM_OWNER_ID` setting continues to restrict privileged bot commands; it is not used as web authentication.

## Deployment requirements

- Use HTTPS in production.
- Keep the API behind the same origin as the frontend so the session cookie is sent on the PayPal callback.
- Register the domain with @BotFather using `/setdomain`.
- Configure `TELEGRAM_BOT_USERNAME`, `TELEGRAM_BOT_TOKEN`, `DATABASE_URL`, `TOKEN_ENCRYPTION_SECRET`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_REDIRECT_URI`, `API_BASE_URL`, and `FRONTEND_URL`.
