import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assertPaymentEnvironment, evaluatePaymentPolicy, getFinancialPolicyLimits, paymentPayloadHash, resolveUserFinancialLimits, verifyPayPalOrder, verifyPayPalCapturedOrder, verifyFinancialAuditChain } from "../dist/apps/api/src/financial-policy.js";

const candidate = { userId: "telegram:123", amount: "25.00", currency: "USD", recipient: "Alex", purpose: "Dinner" };
const limits = { maxTransactionAmount: 1000, maxDailyAmount: 2500, maxDailyTransactions: 10, highValueThreshold: 500 };
test("allows an in-policy payment but always requires explicit approval", () => {
  const result = evaluatePaymentPolicy(candidate, { dailySpent: 0, dailyCount: 0 }, limits);
  assert.equal(result.allowed, true);
  assert.equal(result.approvalRequired, true);
  assert.equal(result.normalized?.amount, "25.00");
});
test("rejects invalid amount, unsupported currency, missing recipient and control characters", () => {
  for (const patch of [{ amount: "0" }, { amount: "-1" }, { amount: "1e6" }, { amount: "1.999" }, { currency: "BTC" }, { recipient: "" }, { purpose: "bad\nvalue" }]) {
    assert.equal(evaluatePaymentPolicy({ ...candidate, ...patch }, { dailySpent: 0, dailyCount: 0 }, limits).allowed, false);
  }
});
test("rejects per-transaction and rolling daily spending limits", () => {
  assert.equal(evaluatePaymentPolicy({ ...candidate, amount: "1000.01" }, { dailySpent: 0, dailyCount: 0 }, limits).allowed, false);
  assert.equal(evaluatePaymentPolicy(candidate, { dailySpent: 2490, dailyCount: 2 }, limits).allowed, false);
});
test("rejects transaction-count limit and unverifiable exposure", () => {
  assert.equal(evaluatePaymentPolicy(candidate, { dailySpent: 0, dailyCount: 10 }, limits).allowed, false);
  assert.equal(evaluatePaymentPolicy(candidate, { dailySpent: Number.NaN, dailyCount: 0 }, limits).allowed, false);
});
test("elevates risk near configured limits", () => {
  assert.equal(evaluatePaymentPolicy({ ...candidate, amount: "850" }, { dailySpent: 0, dailyCount: 0 }, limits).risk, "medium");
});
test("JPY rejects fractional amounts", () => {
  assert.equal(evaluatePaymentPolicy({ ...candidate, amount: "10.50", currency: "JPY" }, { dailySpent: 0, dailyCount: 0 }, limits).allowed, false);
});
test("approval hash is stable and binds user, amount, currency, recipient and purpose", () => {
  const hash = paymentPayloadHash({ ...candidate, amount: "25.00" });
  assert.equal(hash, paymentPayloadHash({ ...candidate, amount: "25.00" }));
  assert.notEqual(hash, paymentPayloadHash({ ...candidate, amount: "26.00" }));
  assert.notEqual(hash, paymentPayloadHash({ ...candidate, userId: "telegram:456" }));
});

test("blocks PayPal live mode unless both explicit production gates are set", () => {
  const original = {
    env: process.env.PAYPAL_ENV,
    allow: process.env.FINANCIAL_ALLOW_LIVE_PAYMENTS,
    acknowledgement: process.env.FINANCIAL_LIVE_ACKNOWLEDGEMENT
  };
  try {
    process.env.PAYPAL_ENV = "live";
    delete process.env.FINANCIAL_ALLOW_LIVE_PAYMENTS;
    delete process.env.FINANCIAL_LIVE_ACKNOWLEDGEMENT;
    assert.throws(() => assertPaymentEnvironment(), /Live payments are disabled/);
    process.env.FINANCIAL_ALLOW_LIVE_PAYMENTS = "true";
    process.env.FINANCIAL_LIVE_ACKNOWLEDGEMENT = "I_ACCEPT_LIVE_PAYMENT_RISK";
    assert.doesNotThrow(() => assertPaymentEnvironment());
    process.env.PAYPAL_ENV = "production";
    assert.throws(() => assertPaymentEnvironment(), /Unknown PayPal environment/);
  } finally {
    if (original.env === undefined) delete process.env.PAYPAL_ENV; else process.env.PAYPAL_ENV = original.env;
    if (original.allow === undefined) delete process.env.FINANCIAL_ALLOW_LIVE_PAYMENTS; else process.env.FINANCIAL_ALLOW_LIVE_PAYMENTS = original.allow;
    if (original.acknowledgement === undefined) delete process.env.FINANCIAL_LIVE_ACKNOWLEDGEMENT; else process.env.FINANCIAL_LIVE_ACKNOWLEDGEMENT = original.acknowledgement;
  }
});

test("rejects invalid runtime financial limits instead of silently accepting them", () => {
  const original = process.env.FINANCIAL_MAX_DAILY_TRANSACTIONS;
  try {
    process.env.FINANCIAL_MAX_DAILY_TRANSACTIONS = "2.5";
    assert.throws(() => getFinancialPolicyLimits(), /positive integer/);
  } finally {
    if (original === undefined) delete process.env.FINANCIAL_MAX_DAILY_TRANSACTIONS;
    else process.env.FINANCIAL_MAX_DAILY_TRANSACTIONS = original;
  }
});


test("requires step-up confirmation for high-value payments", () => {
  const highValueLimits = { ...limits, highValueThreshold: 500 };
  const result = evaluatePaymentPolicy({ ...candidate, amount: "600" }, { dailySpent: 0, dailyCount: 0 }, highValueLimits);
  assert.equal(result.allowed, true);
  assert.equal(result.requiresStepUp, true);
  assert.equal(result.approvalRequired, true);
});

test("blocks exact duplicate transactions and elevated suspicious activity", () => {
  const duplicate = evaluatePaymentPolicy(candidate, { dailySpent: 0, dailyCount: 1, duplicateCount: 1 }, limits);
  assert.equal(duplicate.allowed, false);
  assert.match(duplicate.reason, /duplicate/i);
  const suspicious = evaluatePaymentPolicy(candidate, { dailySpent: 0, dailyCount: 0, recentAttempts: 5, failedAttempts: 2, newRecipient: true }, limits);
  assert.equal(suspicious.risk, "high");
  assert.ok(suspicious.riskScore >= 60);
});


test("user-specific limits can tighten but never loosen global ceilings", () => {
  const base = { maxTransactionAmount: 1000, maxDailyAmount: 2500, maxDailyTransactions: 10, highValueThreshold: 500 };
  const result = resolveUserFinancialLimits(base, { enabled: true, max_transaction_amount: 2000, max_daily_amount: 9000, max_daily_transactions: 50, high_value_threshold: 900 });
  assert.deepEqual(result, base);
  const tightened = resolveUserFinancialLimits(base, { enabled: true, max_transaction_amount: 100, max_daily_amount: 200, max_daily_transactions: 2, high_value_threshold: 50 });
  assert.deepEqual(tightened, { maxTransactionAmount: 100, maxDailyAmount: 200, maxDailyTransactions: 2, highValueThreshold: 50 });
  assert.throws(() => resolveUserFinancialLimits(base, { enabled: false, max_transaction_amount: 100, max_daily_amount: 200, max_daily_transactions: 2, high_value_threshold: 50 }), /disabled/);
});

test("PayPal capture verification binds payer, amount, currency, reference and order ID", () => {
  const order = { id: "ORDER123", status: "APPROVED", payer: { payer_id: "PAYER123" }, purchase_units: [{ reference_id: "TX123", amount: { currency_code: "USD", value: "25.00" } }] };
  const expected = { orderId: "ORDER123", payerId: "PAYER123", transactionId: "TX123", amount: "25.00", currency: "USD" };
  assert.equal(verifyPayPalOrder(order, expected).allowed, true);
  assert.match(verifyPayPalOrder({ ...order, payer: { payer_id: "OTHER" } }, expected).reason, /buyer identity/);
  assert.match(verifyPayPalOrder({ ...order, purchase_units: [{ ...order.purchase_units[0], amount: { currency_code: "USD", value: "250.00" } }] }, expected).reason, /amount or currency/);
});

test("recovers a completed PayPal capture after the API lost the original response", () => {
  const order = {
    id: "ORDER123",
    status: "COMPLETED",
    payer: { payer_id: "PAYER123" },
    purchase_units: [{
      reference_id: "TX123",
      amount: { currency_code: "USD", value: "25.00" },
      payments: { captures: [{ id: "CAPTURE123", status: "COMPLETED", amount: { currency_code: "USD", value: "25.00" } }] }
    }]
  };
  const expected = { orderId: "ORDER123", payerId: "PAYER123", transactionId: "TX123", amount: "25.00", currency: "USD" };
  assert.deepEqual(verifyPayPalCapturedOrder(order, expected), {
    allowed: true,
    reason: "Previously completed PayPal capture verified for safe recovery.",
    captureId: "CAPTURE123"
  });
  assert.match(verifyPayPalCapturedOrder({ ...order, payer: { payer_id: "OTHER" } }, expected).reason, /buyer identity/);
  assert.match(verifyPayPalCapturedOrder({ ...order, purchase_units: [{ ...order.purchase_units[0], payments: { captures: [{ id: "CAPTURE123", status: "PENDING", amount: { currency_code: "USD", value: "25.00" } }] } }] }, expected).reason, /completed capture/);
  assert.match(verifyPayPalCapturedOrder({ ...order, purchase_units: [{ ...order.purchase_units[0], payments: { captures: [{ id: "CAPTURE123", status: "COMPLETED", amount: { currency_code: "USD", value: "250.00" } }] } }] }, expected).reason, /capture amount or currency/);
});

test("verifies financial audit hash-chain continuity and detects payload tampering", () => {
  const makeEntry = (id, previousHash, eventType) => {
    const payload = JSON.stringify({ userId: "telegram:123", eventType, allowed: true, reason: "test", policyVersion: "test", risk: "low", riskScore: 10, payloadHash: null, previousHash, createdAt: "2026-11-12T00:00:00.000Z" });
    return { id, user_id: "telegram:123", previous_hash: previousHash, entry_hash: createHash("sha256").update(payload).digest("hex"), entry_payload: payload };
  };
  const first = makeEntry(1, "GENESIS", "PAYMENT_PREPARE");
  const second = makeEntry(2, first.entry_hash, "PAYMENT_EXECUTE");
  assert.deepEqual(verifyFinancialAuditChain([first, second]), { valid: true, verifiedEntries: 2, reason: "Financial audit hash chain is intact." });
  const tampered = { ...second, entry_payload: second.entry_payload.replace('"test"', '"tampered"') };
  const failed = verifyFinancialAuditChain([first, tampered]);
  assert.equal(failed.valid, false);
  assert.equal(failed.brokenEntryId, 2);
  assert.match(failed.reason, /entry hash/);
  const brokenLink = { ...second, previous_hash: "wrong-parent" };
  assert.match(verifyFinancialAuditChain([first, brokenLink]).reason, /previous-hash link/);
});

test("blocks high-confidence suspicious activity before execution", () => {
  const result = evaluatePaymentPolicy({ ...candidate, amount: "900" }, { dailySpent: 1500, dailyCount: 2, recentAttempts: 7, failedAttempts: 3, newRecipient: true }, { ...limits, highValueThreshold: 500 });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /automatic block threshold/);
});

