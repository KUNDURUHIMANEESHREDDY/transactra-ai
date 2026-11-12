# Agentic payment workflows

Transactra can turn one owner instruction into a durable, ordered payment workflow of 2–8 steps.

## Example

`Pay $45 to Alex for design; then pay $80 to Morgan for hosting; then pay ₹850 to Riya for travel`

The Telegram bot sends the instruction to the API. Each clause is parsed independently and stored as a workflow draft. The bot shows every amount, currency, recipient label, purpose and currency total before presenting the **Approve entire plan** action.

## Authorization and execution

1. The owner reviews and approves the complete plan in the private, owner-allowlisted Telegram chat.
2. Only after plan approval does Transactra create the first PayPal Sandbox order.
3. The owner completes PayPal buyer approval for that order.
4. The owner returns to Telegram and explicitly asks Transactra to capture it.
5. The API records the PayPal capture response. Only a `COMPLETED` response advances the next approved step.
6. The bot creates the next PayPal order and repeats the buyer-approval/capture sequence until all steps are complete.

A rejected plan creates no PayPal orders. A workflow is stored in PostgreSQL, not in the bot's in-memory draft map. Workflow routes require the configured `TELEGRAM_OWNER_ID` in the `x-transactra-owner-id` header.

## Syntax

Use 2–8 individual payment instructions separated by semicolons, line breaks, or the word `then`. Each instruction must include a positive amount and recipient, for example:

- `Pay $45 to Alex for design`
- `Pay ₹850 to Riya for travel`

## Payment semantics

The current PayPal integration is first-party merchant checkout. A recipient is a transaction label, not a third-party payee destination. PayPal checkout charges the merchant account connected to the configured PayPal app. Actual third-party disbursement requires an eligible PayPal multiparty/platform integration and seller onboarding.

Every workflow step still requires PayPal buyer approval. The agent does not silently capture future steps, invent successful payments, or skip a failed step.
