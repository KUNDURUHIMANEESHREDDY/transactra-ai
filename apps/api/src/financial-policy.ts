import { createHash } from "node:crypto";

export const FINANCIAL_POLICY_VERSION = "2026-11-12.2";
export const SUPPORTED_CURRENCIES = new Set(["USD", "EUR", "GBP", "INR", "CAD", "AUD", "SGD", "JPY"]);

export interface PaymentCandidate { userId:string; amount:string|number; currency:string; recipient:string; purpose:string }
export interface PaymentExposure {
  dailySpent:number; dailyCount:number; failedAttempts?:number; duplicateCount?:number;
  newRecipient?:boolean; recentAttempts?:number;
}
export interface PaymentPolicyDecision {
  allowed:boolean; approvalRequired:true; requiresStepUp:boolean; riskScore:number;
  risk:"low"|"medium"|"high"; reason:string; policyVersion:string;
  normalized?:{userId:string;amount:string;currency:string;recipient:string;purpose:string};
}
export interface FinancialPolicyLimits {
  maxTransactionAmount:number; maxDailyAmount:number; maxDailyTransactions:number; highValueThreshold:number;
}
const positiveLimit=(name:string,fallback:number):number=>{
  const raw=process.env[name];if(raw===undefined||raw==="")return fallback;
  const value=Number(raw);if(!Number.isFinite(value)||value<=0)throw new Error(name+" must be a positive finite number.");
  return value;
};
export function getFinancialPolicyLimits():FinancialPolicyLimits{
  const maxDailyTransactions=positiveLimit("FINANCIAL_MAX_DAILY_TRANSACTIONS",10);
  if(!Number.isSafeInteger(maxDailyTransactions))throw new Error("FINANCIAL_MAX_DAILY_TRANSACTIONS must be a positive integer.");
  const limits={maxTransactionAmount:positiveLimit("FINANCIAL_MAX_TRANSACTION_AMOUNT",1000),maxDailyAmount:positiveLimit("FINANCIAL_MAX_DAILY_AMOUNT",2500),maxDailyTransactions,highValueThreshold:positiveLimit("FINANCIAL_HIGH_VALUE_THRESHOLD",500)};
  if(limits.highValueThreshold>limits.maxTransactionAmount)throw new Error("FINANCIAL_HIGH_VALUE_THRESHOLD cannot exceed FINANCIAL_MAX_TRANSACTION_AMOUNT.");
  return limits;
}
export function assertPaymentEnvironment():void{
  const environment=String(process.env.PAYPAL_ENV||"sandbox").toLowerCase();
  if(environment!=="sandbox"&&environment!=="live")throw new Error("Unknown PayPal environment; payment execution is blocked.");
  if(environment==="live"&&(process.env.FINANCIAL_ALLOW_LIVE_PAYMENTS!=="true"||process.env.FINANCIAL_LIVE_ACKNOWLEDGEMENT!=="I_ACCEPT_LIVE_PAYMENT_RISK"))throw new Error("Live payments are disabled. Sandbox is required unless the explicit live-payment gates are configured.");
}
function normalizeAmount(value:string|number,currency:string):string|null{
  const raw=String(value).trim();if(!/^\d{1,9}(?:\.\d{1,2})?$/.test(raw))return null;
  const amount=Number(raw);if(!Number.isFinite(amount)||amount<=0)return null;
  if(currency==="JPY"&&!Number.isInteger(amount))return null;
  return currency==="JPY"?String(Math.trunc(amount)):amount.toFixed(2);
}
export function paymentPayloadHash(payment:{userId:string;amount:string;currency:string;recipient:string;purpose:string}):string{
  const currency=String(payment.currency).trim().toUpperCase(),canonicalAmount=normalizeAmount(payment.amount,currency)||String(payment.amount);
  return createHash("sha256").update(JSON.stringify({userId:payment.userId,amount:canonicalAmount,currency,recipient:payment.recipient,purpose:payment.purpose})).digest("hex");
}
export function evaluatePaymentPolicy(candidate:PaymentCandidate,exposure:PaymentExposure,limits=getFinancialPolicyLimits()):PaymentPolicyDecision{
  const deny=(reason:string):PaymentPolicyDecision=>({allowed:false,approvalRequired:true,requiresStepUp:false,riskScore:100,risk:"high",reason,policyVersion:FINANCIAL_POLICY_VERSION});
  const userId=String(candidate.userId||"").trim(),currency=String(candidate.currency||"").trim().toUpperCase();
  const recipient=String(candidate.recipient||"").trim(),purpose=String(candidate.purpose||"").trim();
  if(!/^[A-Za-z0-9._:@-]{1,128}$/.test(userId))return deny("Authenticated user identity is missing or invalid.");
  if(!SUPPORTED_CURRENCIES.has(currency))return deny("Currency is not supported by Transactra financial policy.");
  const amount=normalizeAmount(candidate.amount,currency);
  if(!amount)return deny("Amount must be positive, finite, and use the currency's supported decimal precision.");
  if(!recipient||recipient.length>80||/[\r\n\u0000-\u001f]/.test(recipient))return deny("Recipient label is missing or invalid.");
  if(!purpose||purpose.length>120||/[\u0000-\u001f]/.test(purpose))return deny("Payment purpose is missing or invalid.");
  const metrics=[exposure.dailySpent,exposure.dailyCount,exposure.failedAttempts??0,exposure.duplicateCount??0,exposure.recentAttempts??0];
  if(metrics.some(x=>!Number.isFinite(x)||x<0)||!Number.isSafeInteger(exposure.dailyCount)||!Number.isSafeInteger(exposure.failedAttempts??0)||!Number.isSafeInteger(exposure.duplicateCount??0)||!Number.isSafeInteger(exposure.recentAttempts??0)||typeof (exposure.newRecipient??false)!=="boolean")return deny("Transaction exposure could not be verified; policy fails closed.");
  const numericAmount=Number(amount);
  if(numericAmount>limits.maxTransactionAmount)return deny("Transaction exceeds the configured per-transaction limit.");
  if(exposure.dailyCount>=limits.maxDailyTransactions)return deny("Daily transaction-count limit reached.");
  if(exposure.dailySpent+numericAmount>limits.maxDailyAmount)return deny("Daily spending limit would be exceeded.");
  if((exposure.duplicateCount??0)>0)return deny("Exact or pending duplicate payment detected; duplicate execution is blocked.");
  let riskScore=10;
  if(numericAmount>=limits.maxTransactionAmount*.8)riskScore+=25;
  if(exposure.dailySpent+numericAmount>=limits.maxDailyAmount*.8)riskScore+=20;
  if(exposure.newRecipient)riskScore+=15;
  if((exposure.failedAttempts??0)>=2)riskScore+=25;
  if((exposure.recentAttempts??0)>=5)riskScore+=20;
  const requiresStepUp=numericAmount>=limits.highValueThreshold||riskScore>=60;
  const risk: "low"|"medium"|"high"=riskScore>=60?"high":riskScore>=30||requiresStepUp?"medium":"low";
  return {allowed:true,approvalRequired:true,requiresStepUp,riskScore:Math.min(100,riskScore),risk,reason:requiresStepUp?"Policy checks passed; an additional transaction-bound confirmation is required before execution.":"Policy checks passed. A one-time, transaction-bound Telegram approval is still mandatory.",policyVersion:FINANCIAL_POLICY_VERSION,normalized:{userId,amount,currency,recipient,purpose}};
}
