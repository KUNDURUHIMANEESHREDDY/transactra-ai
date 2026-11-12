import { createHash } from "node:crypto";

export const FINANCIAL_POLICY_VERSION = "2026-11-12.1";
export const SUPPORTED_CURRENCIES = new Set(["USD", "EUR", "GBP", "INR", "CAD", "AUD", "SGD", "JPY"]);

export interface PaymentCandidate {
  userId: string;
  amount: string | number;
  currency: string;
  recipient: string;
  purpose: string;
}
export interface PaymentExposure { dailySpent: number; dailyCount: number }
export interface PaymentPolicyDecision {
  allowed: boolean;
  approvalRequired: true;
  risk: "low" | "medium" | "high";
  reason: string;
  policyVersion: string;
  normalized?: { userId: string; amount: string; currency: string; recipient: string; purpose: string };
}
export interface FinancialPolicyLimits {
  maxTransactionAmount: number;
  maxDailyAmount: number;
  maxDailyTransactions: number;
}
const positiveLimit = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(name + " must be a positive finite number.");
  return value;
};
export function getFinancialPolicyLimits(): FinancialPolicyLimits {
  const maxDailyTransactions = positiveLimit("FINANCIAL_MAX_DAILY_TRANSACTIONS", 10);
  if (!Number.isSafeInteger(maxDailyTransactions)) throw new Error("FINANCIAL_MAX_DAILY_TRANSACTIONS must be a positive integer.");
  return {
    maxTransactionAmount: positiveLimit("FINANCIAL_MAX_TRANSACTION_AMOUNT", 1000),
    maxDailyAmount: positiveLimit("FINANCIAL_MAX_DAILY_AMOUNT", 2500),
    maxDailyTransactions
  };
}
export function assertPaymentEnvironment(): void {
  const environment = String(process.env.PAYPAL_ENV || "sandbox").toLowerCase();
  if (environment !== "sandbox" && environment !== "live") throw new Error("Unknown PayPal environment; payment execution is blocked.");
  if (environment === "live" && (
    process.env.FINANCIAL_ALLOW_LIVE_PAYMENTS !== "true" ||
    process.env.FINANCIAL_LIVE_ACKNOWLEDGEMENT !== "I_ACCEPT_LIVE_PAYMENT_RISK"
  )) throw new Error("Live payments are disabled. Sandbox is required unless the explicit live-payment gates are configured.");
}
function normalizeAmount(value: string | number, currency: string): string | null {
  const raw = String(value).trim();
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(raw)) return null;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (currency === "JPY" && !Number.isInteger(amount)) return null;
  return currency === "JPY" ? String(Math.trunc(amount)) : amount.toFixed(2);
}
export function paymentPayloadHash(payment: { userId: string; amount: string; currency: string; recipient: string; purpose: string }): string {
  const currency = String(payment.currency).trim().toUpperCase();
  const canonicalAmount = normalizeAmount(payment.amount, currency) || String(payment.amount);
  const canonical = JSON.stringify({
    userId: payment.userId, amount: canonicalAmount, currency,
    recipient: payment.recipient, purpose: payment.purpose
  });
  return createHash("sha256").update(canonical).digest("hex");
}
export function evaluatePaymentPolicy(candidate: PaymentCandidate, exposure: PaymentExposure, limits = getFinancialPolicyLimits()): PaymentPolicyDecision {
  const deny = (reason: string, risk: "low" | "medium" | "high" = "high"): PaymentPolicyDecision =>
    ({ allowed: false, approvalRequired: true, risk, reason, policyVersion: FINANCIAL_POLICY_VERSION });
  const userId = String(candidate.userId || "").trim();
  const currency = String(candidate.currency || "").trim().toUpperCase();
  const recipient = String(candidate.recipient || "").trim();
  const purpose = String(candidate.purpose || "").trim();
  if (!/^[A-Za-z0-9._:@-]{1,128}$/.test(userId)) return deny("Authenticated user identity is missing or invalid.");
  if (!SUPPORTED_CURRENCIES.has(currency)) return deny("Currency is not supported by Transactra financial policy.");
  const amount = normalizeAmount(candidate.amount, currency);
  if (!amount) return deny("Amount must be positive, finite, and use the currency's supported decimal precision.");
  if (!recipient || recipient.length > 80 || /[\r\n\u0000-\u001f]/.test(recipient)) return deny("Recipient label is missing or invalid.");
  if (!purpose || purpose.length > 120 || /[\u0000-\u001f]/.test(purpose)) return deny("Payment purpose is missing or invalid.");
  if (!Number.isFinite(exposure.dailySpent) || exposure.dailySpent < 0 || !Number.isSafeInteger(exposure.dailyCount) || exposure.dailyCount < 0) {
    return deny("Transaction exposure could not be verified; policy fails closed.");
  }
  const numericAmount = Number(amount);
  if (numericAmount > limits.maxTransactionAmount) return deny("Transaction exceeds the configured per-transaction limit.");
  if (exposure.dailyCount >= limits.maxDailyTransactions) return deny("Daily transaction-count limit reached.");
  if (exposure.dailySpent + numericAmount > limits.maxDailyAmount) return deny("Daily spending limit would be exceeded.");
  const risk = numericAmount >= limits.maxTransactionAmount * 0.8 || exposure.dailySpent + numericAmount >= limits.maxDailyAmount * 0.8 ? "medium" : "low";
  return {
    allowed: true, approvalRequired: true, risk,
    reason: "Policy checks passed. A one-time, transaction-bound Telegram approval is still mandatory.",
    policyVersion: FINANCIAL_POLICY_VERSION,
    normalized: { userId, amount, currency, recipient, purpose }
  };
}
