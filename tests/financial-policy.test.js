import test from "node:test";
import assert from "node:assert/strict";
import { assertPaymentEnvironment, evaluatePaymentPolicy, getFinancialPolicyLimits, paymentPayloadHash } from "../dist/apps/api/src/financial-policy.js";

const candidate = { userId: "telegram:123", amount: "25.00", currency: "USD", recipient: "Alex", purpose: "Dinner" };
const limits = { maxTransactionAmount: 1000, maxDailyAmount: 2500, maxDailyTransactions: 10 };
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
