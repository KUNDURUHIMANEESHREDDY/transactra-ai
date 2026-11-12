# Transactra

**Payments, understood.** Transactra turns natural-language requests into reviewable PayPal Checkout orders. Users review the extracted details, approve in PayPal, and the server captures the order through PayPal Orders API v2.

Built for the PayPal AI Hackathon using the free PayPal Sandbox.

## Demo flow
1. Enter a request such as “Pay $24.50 to Alex for dinner”.
2. Transactra extracts amount, currency, recipient label and purpose. A built-in deterministic parser works without an AI-provider key; an optional OpenAI-compatible model endpoint can be configured.
3. Review the structured payment details.
4. Continue to PayPal Checkout and sign in with a Sandbox personal test account.
5. Approve checkout. The server calls PayPal Orders v2 capture and stores the result in PostgreSQL.
6. View the transaction in Activity.

## Important payment semantics
This first-party merchant checkout charges the merchant account associated with the configured PayPal app. The recipient entered in the prompt is stored as a transaction label; it does not itself route money to that person. Third-party payee routing requires an eligible PayPal multiparty/platform integration and seller onboarding. The UI discloses this before checkout. No fake payment-success states are used.

## Stack
React + TypeScript + Tailwind CSS v4 (Vite), Node.js TypeScript API, PayPal JavaScript SDK + Orders API v2, PostgreSQL ledger, optional OpenAI-compatible model endpoint.

## Requirements
Node.js 22+, Docker Desktop or PostgreSQL 16+, and a PayPal Developer account with a Sandbox REST app and Sandbox personal test account.

## Local setup
1. Run npm install.
2. Start PostgreSQL: docker compose up -d postgres.
3. Copy .env.example to .env and add PayPal Sandbox client ID and secret from https://developer.paypal.com/dashboard/applications/sandbox.
4. Run npm run dev:api.
5. In another terminal run npm run dev.
6. Open http://localhost:5173.

The API creates the transaction table on first request. The public client ID is served to the browser; the secret stays on the API server.

## PayPal integration
- Sandbox REST host: https://api-m.sandbox.paypal.com
- OAuth: POST /v1/oauth2/token using server-held credentials.
- Create: POST /v2/checkout/orders with intent CAPTURE.
- Buyer approval: PayPal JavaScript SDK Checkout Buttons.
- Capture: POST /v2/checkout/orders/{id}/capture after buyer approval.
- PayPal-Request-Id is sent on order creation.
- Status comes from PayPal's capture response.

## Optional AI model
Set AI_BASE_URL, AI_API_KEY and AI_MODEL to use an OpenAI-compatible /chat/completions endpoint. If omitted or unavailable, Transactra falls back to its local parser. No external AI key is needed for the core demo.

## Security
Never commit .env, PayPal secrets or model API keys. Use Sandbox credentials only. Do not enable live payments without a separate security and product review.

## Scripts
npm run dev — frontend; npm run dev:api — API; npm run typecheck — TypeScript validation; npm run build — production build; npm test — parser tests.