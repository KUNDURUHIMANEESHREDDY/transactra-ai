# Transactra UX Contract

## Core workflow
Compose request → parse intent → review amount/currency/recipient/purpose → initiate PayPal Checkout → buyer approves in PayPal → server captures order → activity ledger.

## State rules
- Parsing: idle, pending, parsed, invalid/error.
- Order: not-created, creating, created, payer-approved, capture-pending, completed, failed, cancelled.
- Only PayPal's successful capture response may produce COMPLETED.
- A PayPal order or buyer approval is not a capture.
- Cancelled checkout must never be represented as completed.
- Payment details remain visible before checkout begins.

## Payment safety
- All order creation and capture calls are server-side.
- Browser receives only public PayPal client ID.
- Recipient is a label unless eligible PayPal multiparty payee routing is configured; never claim a third party received funds.
- Sandbox-only by default; live payments are out of scope.

## Recovery
Preserve the request on parse failure, show API errors inline, and read Activity from PostgreSQL.