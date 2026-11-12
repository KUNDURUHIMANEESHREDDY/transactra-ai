import {createServer,type IncomingMessage,type ServerResponse} from "node:http";
import {randomUUID,timingSafeEqual,createHash} from "node:crypto";
import {processTelegramUpdate} from "../../telegram/src/bot.js";
import {Pool} from "pg";
import { Client as PayPalClient, Environment as PayPalEnvironment, OrdersController, CheckoutPaymentIntent, OrderApplicationContextUserAction, OrderApplicationContextShippingPreference } from "@paypal/paypal-server-sdk";
import {
  ensurePayPalConnectionSchema,
  createOAuthState,
  validateAndConsumeState,
  exchangeAuthorizationCode,
  fetchPayPalUserInfo,
  saveConnectedAccount,
  getConnectedAccountStatus,
  disconnectPayPalAccount,
  getPayPalConfig,
  createOAuthSessionToken,
  hashOAuthSession
} from "./paypal-oauth.js";
import { getAuthenticatedUser, verifyTelegramWebAppInitData, createAuthenticatedSessionCookie, clearAuthenticatedSessionCookie } from "./request-auth.js";
import { handleObservabilityRoute } from "./observability.js";
import { assertPaymentEnvironment, evaluatePaymentPolicy, getFinancialPolicyLimits, paymentPayloadHash, FINANCIAL_POLICY_VERSION, resolveUserFinancialLimits, verifyPayPalOrder, verifyPayPalCapturedOrder, verifyFinancialAuditChain } from "./financial-policy.js";
const port=Number(process.env.PORT||8787),host=process.env.HOST||"127.0.0.1";
const clientId=process.env.PAYPAL_CLIENT_ID||"",secret=process.env.PAYPAL_CLIENT_SECRET||"";
const paypalSdkClient = new PayPalClient({ environment: process.env.NODE_ENV === "production" || process.env.PAYPAL_ENV === "live" ? PayPalEnvironment.Production : PayPalEnvironment.Sandbox, clientCredentialsAuthCredentials: { oAuthClientId: clientId, oAuthClientSecret: secret }, timeout: 20000 });
const paypalOrders = new OrdersController(paypalSdkClient);
const db=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL}):null;
const currencies=new Set(["USD","EUR","GBP","INR","CAD","AUD","SGD","JPY"]);
const processedTelegramUpdates=new Set<number>();
type Intent={amount:string;currency:string;recipient:string;purpose:string;confidence:number;source:"rules"|"model"};
function send(res:ServerResponse,status:number,data:unknown){res.writeHead(status,{"Content-Type":"application/json","Cache-Control":"no-store"});res.end(JSON.stringify(data));}
async function read(req:IncomingMessage){let raw="";for await(const c of req)raw+=c;if(raw.length>20000)throw Error("Request too large");return raw?JSON.parse(raw) as Record<string,unknown>:{};}
function rules(text:string):Intent{
 const m=text.match(/(?:\b(?:USD|EUR|GBP|INR|CAD|AUD|SGD|JPY)\s*)?[$\u20AC\u00A3\u20B9]?\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)/i);
 if(!m)throw Error("Add a clear amount, such as $24.50 or 850 INR.");
 const n=Number((m[1]||"").replaceAll(",",""));if(!Number.isFinite(n)||n<=0||n>1000000)throw Error("Amount must be greater than zero and no more than 1,000,000.");
 const up=text.toUpperCase(),currency=up.match(/\b(USD|EUR|GBP|INR|CAD|AUD|SGD|JPY)\b/)?.[1]||(text.includes("\u20B9")?"INR":text.includes("\u20AC")?"EUR":text.includes("\u00A3")?"GBP":"USD");
 const recipient=text.match(/\bto\s+([A-Za-z][A-Za-z0-9 &.'-]{0,59}?)(?=\s+(?:for|as|because|with|using)\b|[,.;]|$)/i)?.[1]?.trim();
 if(!recipient)throw Error("Who is this payment for? Include a recipient, for example to Alex.");
 const purpose=text.match(/\bfor\s+(.+?)(?:[.!?]|$)/i)?.[1]?.trim()||"Payment";
 return {amount:n.toFixed(2),currency,recipient,purpose:purpose.slice(0,120),confidence:.82,source:"rules"};
}
type ChatMessage={role:"system"|"user";content:string};
async function cloudPilotCompletion(messages:ChatMessage[],maxTokens=384):Promise<string>{
 const configuredUrl=process.env.CLOUDPILOT_INFERENCE_URL||"";
 const sharedSecret=process.env.CLOUDPILOT_INFERENCE_SECRET||"";
 if(!configuredUrl)throw Error("CloudPilot inference URL is not configured.");
 if(Buffer.byteLength(sharedSecret,"utf8")<32)throw Error("CloudPilot inference secret is not configured with at least 32 bytes.");
 let endpoint:URL;
 try{endpoint=new URL(configuredUrl.endsWith("/chat/completions")?configuredUrl:configuredUrl.replace(/\/$/,"")+"/chat/completions");}
 catch{throw Error("CloudPilot inference URL is invalid.");}
 if(endpoint.protocol!=="https:")throw Error("CloudPilot inference requires HTTPS.");
 const model=process.env.AI_MODEL||"stepfun-ai/step-5-preview";
 const response=await fetch(endpoint,{method:"POST",headers:{Authorization:"Bearer "+sharedSecret,"Content-Type":"application/json","Accept":"application/json"},body:JSON.stringify({model,messages,max_tokens:maxTokens,temperature:0.2}),redirect:"error",signal:AbortSignal.timeout(125000)});
 if(!response.ok)throw Error("CloudPilot inference returned HTTP "+response.status+".");
 const data=await response.json() as {model?:string;choices?:Array<{message?:{content?:string}}>} ;
 const reply=data.choices?.[0]?.message?.content;
 if(typeof reply!=="string"||!reply.trim())throw Error("CloudPilot returned an empty or invalid completion.");
 if(data.model&&data.model!==model)throw Error("CloudPilot returned an unexpected model identifier.");
 return reply.trim();
}
function modelIntent(raw:string):Intent{
 let p:Record<string,unknown>;
 try{p=JSON.parse(raw) as Record<string,unknown>;}catch{throw Error("CloudPilot could not return valid payment details. Please restate the amount and recipient.");}
 const amount=Number(p.amount),currency=String(p.currency||"USD").toUpperCase(),recipient=String(p.recipient||"").trim();
 if(!Number.isFinite(amount)||amount<=0||amount>1000000||!currencies.has(currency)||!recipient||recipient.length>80)throw Error("CloudPilot did not identify a valid amount, currency and recipient. Please clarify the payment request.");
 return {amount:amount.toFixed(2),currency,recipient,purpose:String(p.purpose||"Payment").slice(0,120),confidence:.97,source:"model"};
}
async function parse(text:string):Promise<Intent>{
 if(!text.trim()||text.length>1000)throw Error("Enter a payment request under 1,000 characters.");
 const cloudPilotUrl=process.env.CLOUDPILOT_INFERENCE_URL;
 if(cloudPilotUrl){
  const raw=await cloudPilotCompletion([{role:"system",content:"Extract payment amount, currency, recipient and purpose as JSON. Never infer a missing amount or recipient. If either is missing, return an empty string for that field. Return only valid JSON."},{role:"user",content:text}],384);
  return modelIntent(raw);
 }
 const base=process.env.AI_BASE_URL,key=process.env.AI_API_KEY,model=process.env.AI_MODEL;
 if(base&&key&&model)try{
  const endpoint=base.replace(/\/$/,"")+(base.endsWith("/chat/completions")?"":"/chat/completions");
  const r=await fetch(endpoint,{method:"POST",headers:{Authorization:"Bearer "+key,"Content-Type":"application/json"},body:JSON.stringify({model,temperature:0,response_format:{type:"json_object"},messages:[{role:"system",content:"Extract payment amount, currency, recipient and purpose as JSON. Never infer missing amount or recipient. Return only valid JSON."},{role:"user",content:text}]}),signal:AbortSignal.timeout(12000)});
  if(r.ok){const data=await r.json() as {choices?:Array<{message?:{content?:string}}>};return modelIntent(data.choices?.[0]?.message?.content||"{}");}
 }catch{/* legacy provider remains optional; use the deterministic parser when unavailable */}
 return rules(text);
}
async function ensureDb(){
 if(!db)throw Error("DATABASE_URL is required. Start PostgreSQL with docker compose and configure .env.");
 await db.query("CREATE TABLE IF NOT EXISTS payment_transactions(id UUID PRIMARY KEY,user_id TEXT NOT NULL,approval_id UUID UNIQUE,raw_prompt TEXT NOT NULL,recipient TEXT NOT NULL,purpose TEXT NOT NULL,amount NUMERIC(18,2) NOT NULL CHECK(amount>0),currency CHAR(3) NOT NULL,status TEXT NOT NULL,paypal_order_id TEXT UNIQUE,paypal_capture_id TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
 await db.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS user_id TEXT");
 await db.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS approval_id UUID");
 await db.query("CREATE TABLE IF NOT EXISTS payment_approval_challenges(id UUID PRIMARY KEY,user_id TEXT NOT NULL,raw_prompt TEXT NOT NULL,recipient TEXT NOT NULL,purpose TEXT NOT NULL,amount NUMERIC(18,2) NOT NULL CHECK(amount>0),currency CHAR(3) NOT NULL,payload_hash CHAR(64) NOT NULL,policy_version TEXT NOT NULL,risk_level TEXT NOT NULL CHECK(risk_level IN ('low','medium','high')),status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','CONSUMED','REJECTED','EXPIRED','DENIED')),expires_at TIMESTAMPTZ NOT NULL,consumed_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
 await db.query("CREATE INDEX IF NOT EXISTS payment_transactions_user_created_idx ON payment_transactions(user_id,created_at DESC)");
 await db.query("CREATE INDEX IF NOT EXISTS payment_approval_challenges_user_expiry_idx ON payment_approval_challenges(user_id,expires_at) WHERE status='PENDING'");
 await db.query("CREATE TABLE IF NOT EXISTS financial_policy_audit(id BIGSERIAL PRIMARY KEY,user_id TEXT NOT NULL,event_type TEXT NOT NULL,allowed BOOLEAN NOT NULL,reason TEXT NOT NULL,policy_version TEXT NOT NULL,risk_level TEXT NOT NULL,payload_hash CHAR(64),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
 await db.query("CREATE INDEX IF NOT EXISTS financial_policy_audit_user_created_idx ON financial_policy_audit(user_id,created_at DESC)");
 const migration=await db.query("SELECT 1 FROM schema_migrations WHERE version='0008_financial_policy_hardening'");
 if(!migration.rowCount)throw Error("Financial policy migration 0008 is required before any payment operation.");
}
function assertPayPalSdkConfigured(){if(!clientId||!secret)throw Error("PayPal API credentials are not configured on the server.");}
async function createPayPalOrder(transactionId:string,p:{amount:string;currency:string;purpose:string}){assertPayPalSdkConfigured();const response=await paypalOrders.createOrder({body:{intent:CheckoutPaymentIntent.Capture,purchaseUnits:[{referenceId:transactionId,description:p.purpose.slice(0,127),amount:{currencyCode:p.currency.trim(),value:p.amount}}],applicationContext:{brandName:"Transactra",userAction:OrderApplicationContextUserAction.PayNow,shippingPreference:OrderApplicationContextShippingPreference.NoShipping}},paypalRequestId:transactionId,prefer:"return=representation"});return response.result;}
async function getPayPalOrder(orderId:string){assertPayPalSdkConfigured();const response=await paypalOrders.getOrder({id:orderId});return response.result;}
async function capturePayPalOrder(orderId:string,requestId:string){assertPayPalSdkConfigured();const response=await paypalOrders.captureOrder({id:orderId,paypalRequestId:requestId,prefer:"return=representation"});return response.result;}
async function ensureWorkflowSchema(){
 await ensureDb();
 await db!.query("CREATE TABLE IF NOT EXISTS payment_workflows(id UUID PRIMARY KEY,user_id TEXT NOT NULL,raw_prompt TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('PENDING_APPROVAL','APPROVED','IN_PROGRESS','COMPLETED','REJECTED','FAILED')),step_count INTEGER NOT NULL CHECK(step_count BETWEEN 2 AND 8),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
 await db!.query("ALTER TABLE payment_workflows ADD COLUMN IF NOT EXISTS user_id TEXT");
 await db!.query("CREATE TABLE IF NOT EXISTS payment_workflow_steps(id UUID PRIMARY KEY,workflow_id UUID NOT NULL REFERENCES payment_workflows(id),sequence_no INTEGER NOT NULL CHECK(sequence_no BETWEEN 1 AND 8),recipient TEXT NOT NULL,purpose TEXT NOT NULL,amount NUMERIC(18,2) NOT NULL CHECK(amount>0),currency CHAR(3) NOT NULL,status TEXT NOT NULL DEFAULT 'PENDING',paypal_order_id TEXT UNIQUE,approve_url TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(workflow_id,sequence_no))");
 await db!.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS workflow_id UUID REFERENCES payment_workflows(id)");
 await db!.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS workflow_step_id UUID REFERENCES payment_workflow_steps(id)");
}
function requireBotOwner(req:IncomingMessage){
 const owner=String(process.env.TELEGRAM_OWNER_ID||"");
 if(!owner||!/^\d{1,20}$/.test(owner))return false;
 if(getAuthenticatedUser(req)==="telegram:"+owner)return true;
 const expected=String(process.env.BACKEND_SHARED_SECRET||""),supplied=String(req.headers["x-transactra-edge-secret"]||""),user=String(req.headers["x-transactra-owner-id"]||"");
 const a=Buffer.from(expected),b=Buffer.from(supplied);
 return Boolean(expected.length>=32&&user===owner&&supplied&&a.length===b.length&&timingSafeEqual(a,b));
}
function telegramUserId(req:IncomingMessage){return "telegram:"+String(req.headers["x-transactra-owner-id"]||"");}
async function loadUserFinancialLimits(client:any,userId:string){
 const base=getFinancialPolicyLimits();
 const q=await client.query("SELECT enabled,max_transaction_amount::text,max_daily_amount::text,max_daily_transactions,high_value_threshold::text FROM financial_user_policies WHERE user_id=$1",[userId]);
 return resolveUserFinancialLimits(base,q.rowCount?q.rows[0]:null);
}
async function paymentExposure(client:any,userId:string,currency:string,recipient:string,amount:string,purpose:string,excludeTransactionId?:string,payloadHash?:string,excludeApprovalId?:string){
 const q=await client.query("SELECT COALESCE(SUM(amount) FILTER(WHERE created_at>=NOW()-INTERVAL '24 hours' AND status NOT IN ('FAILED','CANCELLED','DENIED')),0)::text AS spent,COUNT(*) FILTER(WHERE created_at>=NOW()-INTERVAL '24 hours' AND status NOT IN ('FAILED','CANCELLED','DENIED'))::int AS count,COUNT(*) FILTER(WHERE status='FAILED' AND created_at>NOW()-INTERVAL '1 hour')::int AS failed,COUNT(*) FILTER(WHERE amount=$4 AND recipient=$3 AND purpose=$5 AND created_at>NOW()-INTERVAL '10 minutes' AND status NOT IN ('FAILED','CANCELLED','DENIED'))::int AS duplicates,NOT EXISTS(SELECT 1 FROM payment_transactions x WHERE x.user_id=$1 AND x.currency=$2 AND x.recipient=$3 AND x.status='COMPLETED') AS new_recipient FROM payment_transactions WHERE user_id=$1 AND currency=$2 AND ($6::uuid IS NULL OR id<>$6::uuid)",[userId,currency,recipient,amount,purpose,excludeTransactionId||null]);
 const attempts=await client.query("SELECT COUNT(*)::int AS recent FROM payment_approval_challenges WHERE user_id=$1 AND created_at>NOW()-INTERVAL '10 minutes'",[userId]);
 const pendingDuplicates=payloadHash?await client.query("SELECT COUNT(*)::int AS count FROM payment_approval_challenges WHERE user_id=$1 AND payload_hash=$2 AND status='PENDING' AND expires_at>NOW() AND ($3::uuid IS NULL OR id<>$3::uuid)",[userId,payloadHash,excludeApprovalId||null]):{rows:[{count:0}]};
 return {dailySpent:Number(q.rows[0]?.spent||0),dailyCount:Number(q.rows[0]?.count||0),failedAttempts:Number(q.rows[0]?.failed||0),duplicateCount:Number(q.rows[0]?.duplicates||0)+Number(pendingDuplicates.rows[0]?.count||0),newRecipient:Boolean(q.rows[0]?.new_recipient),recentAttempts:Number(attempts.rows[0]?.recent||0)};
}
async function appendFinancialAudit(client:any,event:{userId:string;eventType:string;allowed:boolean;reason:string;policyVersion:string;risk:string;riskScore:number;payloadHash?:string|null}){
 await client.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext('financial-audit'))",[event.userId]);
 const previous=await client.query("SELECT entry_hash FROM financial_policy_audit WHERE user_id=$1 ORDER BY id DESC LIMIT 1",[event.userId]);
 const previousHash=String(previous.rows[0]?.entry_hash||"GENESIS"),createdAt=new Date().toISOString();
 const canonical=JSON.stringify({userId:event.userId,eventType:event.eventType,allowed:event.allowed,reason:event.reason,policyVersion:event.policyVersion,risk:event.risk,riskScore:event.riskScore,payloadHash:event.payloadHash||null,previousHash,createdAt});
 const entryHash=createHash("sha256").update(canonical).digest("hex");
 await client.query("INSERT INTO financial_policy_audit(user_id,event_type,allowed,reason,policy_version,risk_level,risk_score,payload_hash,previous_hash,entry_hash,entry_payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",[event.userId,event.eventType,event.allowed,event.reason,event.policyVersion,event.risk,event.riskScore,event.payloadHash||null,previousHash,entryHash,canonical,createdAt]);
}

async function createPaymentApproval(userId:string,raw:string,intent:Intent,idempotencyKey?:string){
 assertPaymentEnvironment();
 const account=await getConnectedAccountStatus(db!,userId);
 if(!account.connected||!account.account?.verified)throw Error("Connect a verified PayPal account before preparing a payment.");
 if(idempotencyKey&&!/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey))throw Error("Invalid idempotency key.");
 const client=await db!.connect();
 try{
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",[userId,intent.currency]);
  const candidate={userId,amount:intent.amount,currency:intent.currency,recipient:intent.recipient,purpose:intent.purpose};
  const requestHash=paymentPayloadHash(candidate);
  if(idempotencyKey){
   const existing=await client.query("SELECT id,payload_hash,status,expires_at,risk_level,policy_version,requires_step_up FROM payment_approval_challenges WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE",[userId,idempotencyKey]);
   if(existing.rowCount){
    const prior=existing.rows[0];
    if(prior.payload_hash!==requestHash)throw Error("Idempotency key was already used for a different payment request.");
    if(prior.status!=="PENDING"||new Date(prior.expires_at).getTime()<=Date.now()){await client.query("COMMIT");return {ok:false as const,error:"This idempotent payment request has already been consumed or expired."};}
    await client.query("COMMIT");
    return {ok:true as const,approvalId:prior.id,intent,risk:prior.risk_level,policyVersion:prior.policy_version,requiresStepUp:Boolean(prior.requires_step_up),expiresInSeconds:Math.max(0,Math.floor((new Date(prior.expires_at).getTime()-Date.now())/1000))};
   }
  }
  const rate=await client.query("SELECT COUNT(*) FILTER (WHERE status='PENDING' AND expires_at>NOW())::int AS pending,COUNT(*) FILTER (WHERE created_at>NOW()-INTERVAL '10 minutes')::int AS recent FROM payment_approval_challenges WHERE user_id=$1",[userId]);
  if(Number(rate.rows[0]?.pending||0)>=5||Number(rate.rows[0]?.recent||0)>=10){
   const reason="Payment request rate limit reached; wait before creating another approval.";
   await appendFinancialAudit(client,{userId,eventType:"PAYMENT_PREPARE",allowed:false,reason,policyVersion:FINANCIAL_POLICY_VERSION,risk:"high",riskScore:100,payloadHash:requestHash});
   await client.query("COMMIT");return {ok:false as const,error:reason};
  }
  const limits=await loadUserFinancialLimits(client,userId);
  const exposure=await paymentExposure(client,userId,intent.currency,intent.recipient,intent.amount,intent.purpose,undefined,requestHash);
  const decision=evaluatePaymentPolicy(candidate,exposure,limits);
  if(!decision.allowed){
   await appendFinancialAudit(client,{userId,eventType:"PAYMENT_PREPARE",allowed:false,reason:decision.reason,policyVersion:decision.policyVersion,risk:decision.risk,riskScore:decision.riskScore,payloadHash:requestHash});
   await client.query("COMMIT");return {ok:false as const,error:decision.reason};
  }
  const normalized=decision.normalized!,approvalId=randomUUID(),hash=paymentPayloadHash(normalized);
  await client.query("INSERT INTO payment_approval_challenges(id,user_id,raw_prompt,recipient,purpose,amount,currency,payload_hash,policy_version,risk_level,risk_score,requires_step_up,idempotency_key,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW()+INTERVAL '10 minutes')",[approvalId,userId,raw.slice(0,1000),normalized.recipient,normalized.purpose,normalized.amount,normalized.currency,hash,decision.policyVersion,decision.risk,decision.riskScore,decision.requiresStepUp,idempotencyKey||null]);
  await appendFinancialAudit(client,{userId,eventType:"PAYMENT_PREPARE",allowed:true,reason:decision.reason,policyVersion:decision.policyVersion,risk:decision.risk,riskScore:decision.riskScore,payloadHash:hash});
  await client.query("COMMIT");
  return {ok:true as const,approvalId,intent:{...intent,amount:normalized.amount,currency:normalized.currency,recipient:normalized.recipient,purpose:normalized.purpose},risk:decision.risk,riskScore:decision.riskScore,requiresStepUp:decision.requiresStepUp,policyVersion:decision.policyVersion,expiresInSeconds:600};
 }catch(error){await client.query("ROLLBACK");throw error;}
 finally{client.release();}
}
async function consumePaymentApproval(userId:string,approvalId:string){
 const account=await getConnectedAccountStatus(db!,userId);
 if(!account.connected||!account.account?.verified)return {ok:false as const,error:"A verified PayPal account must remain connected before payment execution."};
 const client=await db!.connect();
 try{
  await client.query("BEGIN");
  const result=await client.query("SELECT raw_prompt,recipient,purpose,amount::text,currency,payload_hash,policy_version,risk_level,risk_score,requires_step_up,step_up_confirmed,status,expires_at FROM payment_approval_challenges WHERE id=$1 AND user_id=$2 FOR UPDATE",[approvalId,userId]);
  if(!result.rowCount){await client.query("ROLLBACK");return {ok:false as const,error:"Approval is invalid or belongs to another user."};}
  const c=result.rows[0] as {raw_prompt:string;recipient:string;purpose:string;amount:string;currency:string;payload_hash:string;policy_version:string;risk_level:string;risk_score:number;requires_step_up:boolean;step_up_confirmed:boolean;status:string;expires_at:Date};
  if(c.status!=="PENDING"||new Date(c.expires_at).getTime()<=Date.now()){
   if(c.status==="PENDING")await client.query("UPDATE payment_approval_challenges SET status='EXPIRED' WHERE id=$1",[approvalId]);
   await client.query("COMMIT");return {ok:false as const,error:"Approval is expired, already used, or no longer pending."};
  }
  if(c.requires_step_up&&!c.step_up_confirmed){await client.query("ROLLBACK");return {ok:false as const,error:"Additional high-value confirmation is required before this payment can proceed."};}
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",[userId,c.currency.trim()]);
  const normalized={userId,amount:c.amount,currency:c.currency.trim(),recipient:c.recipient,purpose:c.purpose},hash=paymentPayloadHash(normalized);
  if(hash!==c.payload_hash){
   await client.query("UPDATE payment_approval_challenges SET status='DENIED' WHERE id=$1",[approvalId]);
   await appendFinancialAudit(client,{userId,eventType:"PAYMENT_EXECUTE",allowed:false,reason:"Approval payload integrity check failed",policyVersion:c.policy_version,risk:"high",riskScore:100,payloadHash:hash});
   await client.query("COMMIT");return {ok:false as const,error:"Approval payload integrity check failed."};
  }
  const limits=await loadUserFinancialLimits(client,userId);
  const exposure=await paymentExposure(client,userId,normalized.currency,normalized.recipient,normalized.amount,normalized.purpose,undefined,hash,approvalId);
  const decision=evaluatePaymentPolicy(normalized,exposure,limits);
  if(!decision.allowed||(decision.requiresStepUp&&!c.step_up_confirmed)){
   await client.query("UPDATE payment_approval_challenges SET status='DENIED' WHERE id=$1",[approvalId]);
   const reason=decision.allowed?"A new high-value or elevated-risk condition requires additional confirmation.":decision.reason;
   await appendFinancialAudit(client,{userId,eventType:"PAYMENT_EXECUTE",allowed:false,reason,policyVersion:decision.policyVersion,risk:decision.risk,riskScore:decision.riskScore,payloadHash:hash});
   await client.query("COMMIT");return {ok:false as const,error:reason};
  }
  const transactionId=randomUUID();
  await client.query("UPDATE payment_approval_challenges SET status='CONSUMED',consumed_at=NOW() WHERE id=$1 AND status='PENDING'",[approvalId]);
  await client.query("INSERT INTO payment_transactions(id,user_id,approval_id,raw_prompt,recipient,purpose,amount,currency,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'CREATING')",[transactionId,userId,approvalId,c.raw_prompt,c.recipient,c.purpose,c.amount,normalized.currency]);
  await appendFinancialAudit(client,{userId,eventType:"PAYMENT_EXECUTE",allowed:true,reason:decision.reason,policyVersion:c.policy_version,risk:decision.risk,riskScore:decision.riskScore,payloadHash:hash});
  await client.query("COMMIT");
  return {ok:true as const,transactionId,rawPrompt:c.raw_prompt,recipient:c.recipient,purpose:c.purpose,amount:c.amount,currency:normalized.currency,policyVersion:decision.policyVersion,risk:decision.risk,riskScore:decision.riskScore};
 }catch(error){await client.query("ROLLBACK");throw error;}
 finally{client.release();}
}
function splitPaymentInstructions(text:string){return text.split(/\s*(?:;|\n+|\bthen\b)\s*/i).map(x=>x.trim()).filter(Boolean);}
async function createWorkflowOrder(workflowId:string,userId:string){
 assertPaymentEnvironment();
 const account=await getConnectedAccountStatus(db!,userId);
 if(!account.connected||!account.account?.verified)throw Error("Connect a verified PayPal account before executing a payment workflow.");
 const client=await db!.connect();
 let transactionId="",p:{id:string;sequence_no:number;recipient:string;purpose:string;amount:string;currency:string;step_up_confirmed:boolean}|undefined,totalSteps=0;
 try{
  await client.query("BEGIN");
  const workflow=await client.query("SELECT status,step_count FROM payment_workflows WHERE id=$1 AND user_id=$2 FOR UPDATE",[workflowId,userId]);
  if(!workflow.rowCount){await client.query("ROLLBACK");throw Error("Payment workflow not found.");}
  if(!["APPROVED","IN_PROGRESS"].includes(String(workflow.rows[0].status))){await client.query("ROLLBACK");throw Error("Workflow is not approved for execution.");}
  totalSteps=Number(workflow.rows[0].step_count);
  const q=await client.query("SELECT id,sequence_no,recipient,purpose,amount::text,currency,step_up_confirmed FROM payment_workflow_steps WHERE workflow_id=$1 AND status='READY' ORDER BY sequence_no LIMIT 1 FOR UPDATE",[workflowId]);
  if(!q.rowCount){await client.query("COMMIT");return {complete:workflow.rows[0].status==="COMPLETED",pending:true};}
  p=q.rows[0] as {id:string;sequence_no:number;recipient:string;purpose:string;amount:string;currency:string;step_up_confirmed:boolean};
  const currency=p.currency.trim();
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",[userId,currency]);
  const limits=await loadUserFinancialLimits(client,userId);
   const candidate={userId,amount:p.amount,currency,recipient:p.recipient,purpose:p.purpose};
   const hash=paymentPayloadHash(candidate);
   const exposure=await paymentExposure(client,userId,currency,p.recipient,p.amount,p.purpose,undefined,hash);
   const decision=evaluatePaymentPolicy(candidate,exposure,limits);
   if(decision.requiresStepUp&&!p.step_up_confirmed){
    await client.query("UPDATE payment_workflow_steps SET status='AWAITING_STEP_UP',updated_at=NOW() WHERE id=$1 AND status='READY'",[p.id]);
    await appendFinancialAudit(client,{userId,eventType:"WORKFLOW_STEP_UP_REQUIRED",allowed:false,reason:"High-value or elevated-risk workflow step is paused until the user confirms it separately.",policyVersion:decision.policyVersion,risk:decision.risk,riskScore:decision.riskScore,payloadHash:hash});
    await client.query("COMMIT");
    return {requiresStepUp:true,workflowId,step:p.sequence_no,totalSteps,recipient:p.recipient,amount:p.amount,currency,purpose:p.purpose};
   }
  if(!decision.allowed){
   await client.query("UPDATE payment_workflow_steps SET status='POLICY_BLOCKED',updated_at=NOW() WHERE id=$1",[p.id]);
   await client.query("UPDATE payment_workflows SET status='FAILED',updated_at=NOW() WHERE id=$1",[workflowId]);
   await appendFinancialAudit(client,{userId,eventType:"WORKFLOW_EXECUTE",allowed:false,reason:decision.reason,policyVersion:decision.policyVersion,risk:decision.risk,riskScore:decision.riskScore,payloadHash:hash});
   await client.query("COMMIT");throw Error("Workflow blocked by Financial Policy Engine: "+decision.reason);
  }
  transactionId=randomUUID();
  await client.query("UPDATE payment_workflow_steps SET status='CREATING',updated_at=NOW() WHERE id=$1 AND status='READY'",[p.id]);
  await client.query("INSERT INTO payment_transactions(id,user_id,raw_prompt,recipient,purpose,amount,currency,status,workflow_id,workflow_step_id) VALUES($1,$2,$3,$4,$5,$6,$7,'CREATING',$8,$9)",[transactionId,userId,"Approved workflow "+workflowId,p.recipient,p.purpose,p.amount,currency,workflowId,p.id]);
  await appendFinancialAudit(client,{userId,eventType:"WORKFLOW_EXECUTE",allowed:true,reason:decision.reason,policyVersion:decision.policyVersion,risk:decision.risk,riskScore:decision.riskScore,payloadHash:hash});
  await client.query("COMMIT");
 }catch(error){
  try{await client.query("ROLLBACK");}catch{}
  throw error;
 }finally{client.release();}
 if(!p||!transactionId)return {pending:true};
 try{
  const order=await createPayPalOrder(transactionId,p);
  const approveUrl=order.links?.find(x=>x.rel==="approve"||x.rel==="payer-action")?.href;
  if(!order.id||!approveUrl)throw Error("PayPal did not return an order approval link.");
  await db!.query("UPDATE payment_transactions SET paypal_order_id=$1,status='CREATED',updated_at=NOW() WHERE id=$2",[order.id,transactionId]);
  await db!.query("UPDATE payment_workflow_steps SET status='AWAITING_BUYER_APPROVAL',paypal_order_id=$1,approve_url=$2,updated_at=NOW() WHERE id=$3",[order.id,approveUrl,p.id]);
  await db!.query("UPDATE payment_workflows SET status='IN_PROGRESS',updated_at=NOW() WHERE id=$1 AND user_id=$2",[workflowId,userId]);
  return {workflowId,step:p.sequence_no,totalSteps,orderId:order.id,approveUrl,recipient:p.recipient,amount:p.amount,currency:p.currency.trim(),purpose:p.purpose};
 }catch(e){
  await db!.query("UPDATE payment_workflow_steps SET status='FAILED',updated_at=NOW() WHERE id=$1",[p.id]);
  await db!.query("UPDATE payment_transactions SET status='FAILED',updated_at=NOW() WHERE id=$1",[transactionId]);
  await db!.query("UPDATE payment_workflows SET status='FAILED',updated_at=NOW() WHERE id=$1 AND user_id=$2",[workflowId,userId]);
  throw e;
 }
}

async function route(req:IncomingMessage,res:ServerResponse){
 const url=new URL(req.url||"/","http://"+(req.headers.host||"localhost"));
 try{
  if(await handleObservabilityRoute(req,res,url,db))return;
  if(req.method==="GET"&&url.pathname==="/api/health")return send(res,200,{status:"ok",database:Boolean(db),paypalConfigured:Boolean(clientId&&secret),telegramWebhookConfigured:Boolean(process.env.BACKEND_SHARED_SECRET)});
  if(req.method==="GET"&&url.pathname==="/api/financial-audit/verify"){
   if(!requireBotOwner(req))return send(res,401,{error:"Authenticated Telegram session required."});
   await ensureDb();
   const userId=telegramUserId(req);
   const audit=await db!.query("SELECT id,user_id,previous_hash,entry_hash,entry_payload FROM financial_policy_audit WHERE user_id=$1 ORDER BY id ASC",[userId]);
   const verification=verifyFinancialAuditChain(audit.rows);
   return send(res,verification.valid?200:409,verification);
  }
  if(req.method==="GET"&&url.pathname==="/api/auth/session"){
    const userId=getAuthenticatedUser(req);
    if(!userId)return send(res,401,{authenticated:false});
    return send(res,200,{authenticated:true,user:{id:userId,provider:"telegram"}});
  }
  if(req.method==="POST"&&url.pathname==="/api/auth/telegram/session"){
    const body=await read(req),initData=String(body.initData||"");
    const identity=verifyTelegramWebAppInitData(initData);
    if(!identity)return send(res,401,{error:"Telegram authentication could not be verified. Reopen Transactra from the Telegram bot."});
    const cookie=createAuthenticatedSessionCookie(identity.userId);
    res.writeHead(200,{"Content-Type":"application/json","Cache-Control":"no-store","Set-Cookie":cookie,"Referrer-Policy":"no-referrer"});
    return res.end(JSON.stringify({authenticated:true,user:{id:identity.userId,provider:"telegram"},expiresIn:8*60*60}));
  }
  if(req.method==="POST"&&url.pathname==="/api/auth/telegram/logout"){
    res.writeHead(200,{"Content-Type":"application/json","Cache-Control":"no-store","Set-Cookie":clearAuthenticatedSessionCookie()});
    return res.end(JSON.stringify({authenticated:false}));
  }
  if(req.method==="POST"&&url.pathname==="/telegram/webhook"){
   const expected=process.env.BACKEND_SHARED_SECRET||"",supplied=String(req.headers["x-transactra-edge-secret"]||"");
   if(!expected||!supplied)return send(res,401,{error:"Webhook authentication failed."});
   const a=Buffer.from(expected),b=Buffer.from(supplied);
   if(a.length!==b.length||!timingSafeEqual(a,b))return send(res,401,{error:"Webhook authentication failed."});
   const update=await read(req),updateId=Number(update.update_id);
   if(!Number.isSafeInteger(updateId)||updateId<0)return send(res,400,{error:"Invalid Telegram update."});
   if(processedTelegramUpdates.has(updateId))return send(res,200,{ok:true,duplicate:true});
   try{await processTelegramUpdate(update);processedTelegramUpdates.add(updateId);if(processedTelegramUpdates.size>2000)processedTelegramUpdates.delete(processedTelegramUpdates.values().next().value!);return send(res,200,{ok:true});}
   catch(e){console.error("Telegram webhook processing failed:",e instanceof Error?e.message:"unknown error");return send(res,500,{error:"Telegram update processing failed."});}
  }
  if(req.method==="GET"&&url.pathname==="/api/config")return send(res,200,{paypalClientId:clientId,paypalConfigured:Boolean(clientId&&secret),environment:process.env.NODE_ENV==="production"||process.env.PAYPAL_ENV==="live"?"live":"sandbox",telegramBotUsername:process.env.TELEGRAM_BOT_USERNAME||""});

  // Telegram authenticates the owner; the browser receives a one-time launch ticket.
  if (req.method === "GET" && url.pathname === "/api/auth/paypal/connect") {
    if (!requireBotOwner(req)) return send(res, 401, { error: "Authenticated Telegram owner session required." });
    if (!db) return send(res, 503, { error: "Database is required for persistent OAuth connection." });
    if (!process.env.TOKEN_ENCRYPTION_SECRET || Buffer.byteLength(process.env.TOKEN_ENCRYPTION_SECRET, "utf8") < 32)
      return send(res, 503, { error: "TOKEN_ENCRYPTION_SECRET must be configured with at least 32 bytes." });
    await ensurePayPalConnectionSchema(db);
    const browserSession = createOAuthSessionToken();
    const sessionHash = hashOAuthSession(browserSession);
    const authenticatedOwner = getAuthenticatedUser(req);
    if (!authenticatedOwner || authenticatedOwner !== "telegram:" + String(process.env.TELEGRAM_OWNER_ID || ""))
      return send(res, 401, { error: "Authenticated Telegram owner identity could not be verified." });
    const { state } = await createOAuthState(db, authenticatedOwner, sessionHash);
    const launch = new URL("/api/auth/paypal/start", getPayPalConfig().redirectUri);
    launch.searchParams.set("state", state);
    launch.searchParams.set("session", browserSession);
    res.writeHead(302, { Location: launch.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/api/auth/paypal/start") {
    if (!db) return send(res, 503, { error: "Database is required for OAuth launch." });
    await ensurePayPalConnectionSchema(db);
    const state = url.searchParams.get("state") || "";
    const session = url.searchParams.get("session") || "";
    if (!/^[0-9a-f]{64}$/i.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(session))
      return send(res, 400, { error: "Invalid or expired PayPal authorization launch." });
    const sessionHash = hashOAuthSession(session);
    const launch = await db.query(
      "UPDATE paypal_oauth_states SET launch_used_at=COALESCE(launch_used_at,NOW()) WHERE state=$1 AND session_hash=$2 AND used_at IS NULL AND expires_at>NOW() RETURNING state",
      [state, sessionHash]
    );
    if (!launch.rowCount) return send(res, 410, { error: "This PayPal authorization link is expired or has already been used. Start again in Telegram." });
    const config = getPayPalConfig();
    const params = new URLSearchParams({ client_id: config.clientId, response_type: "code", scope: "openid profile email", redirect_uri: config.redirectUri, state, prompt: "login" });
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.writeHead(302, {
      Location: config.authBase + "/signin/authorize?" + params.toString(),
      "Set-Cookie": "transactra_paypal_oauth=" + session + "; HttpOnly; SameSite=Lax; Path=/api/auth/paypal; Max-Age=600" + secure,
      "Cache-Control": "no-store", "Referrer-Policy": "no-referrer"
    });
    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/api/auth/paypal/callback") {
    if (!db) return send(res, 503, { error: "Database is required for OAuth callback." });
    await ensurePayPalConnectionSchema(db);
    const config = getPayPalConfig();
    const cookie = String(req.headers.cookie || "").split(";").map(part => part.trim())
      .find(part => part.startsWith("transactra_paypal_oauth="))?.slice("transactra_paypal_oauth=".length) || "";
    const state = url.searchParams.get("state") || "";
    const code = url.searchParams.get("code") || "";
    const browserSessionHash = cookie ? hashOAuthSession(cookie) : "";
    const validation = browserSessionHash
      ? await validateAndConsumeState(db, state, browserSessionHash)
      : { valid: false, error: "OAuth browser session is missing." };
    const redirectBase = validation.valid && validation.redirectUrl
      ? validation.redirectUrl
      : config.frontendUrl;
    const clearCookie = "transactra_paypal_oauth=; HttpOnly; SameSite=Lax; Path=/api/auth/paypal; Max-Age=0" +
      (process.env.NODE_ENV === "production" ? "; Secure" : "");
    const finish = (target: string) => {
      res.writeHead(302, {
        Location: target,
        "Set-Cookie": clearCookie,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer"
      });
      res.end();
    };
    if (!validation.valid || !validation.userId) return finish(config.frontendUrl + "/?paypal_connection=error&reason=invalid_session_or_state");
    if (url.searchParams.has("error")) return finish(redirectBase + "/?paypal_connection=error&reason=authorization_denied");
    if (!code) return finish(redirectBase + "/?paypal_connection=error&reason=missing_authorization_code");

    try {
      const tokenRes = await exchangeAuthorizationCode(code);
      const userInfo = await fetchPayPalUserInfo(tokenRes.access_token);
      await saveConnectedAccount(db, validation.userId, {
        payerId: userInfo.payerId,
        ...(userInfo.email ? { email: userInfo.email } : {}),
        ...(userInfo.name ? { name: userInfo.name } : {}),
        verifiedAccount: userInfo.verifiedAccount,
        accessToken: tokenRes.access_token,
        ...(tokenRes.refresh_token ? { refreshToken: tokenRes.refresh_token } : {}),
        expiresIn: tokenRes.expires_in,
        ...(tokenRes.scope ? { scope: tokenRes.scope } : {})
      });
      return finish(redirectBase + "/?paypal_connection=success");
    } catch (e) {
      console.error("PayPal OAuth callback failed:", e instanceof Error ? e.message : "unknown error");
      return finish(redirectBase + "/?paypal_connection=error&reason=oauth_exchange_failed");
    }
  }

  if (req.method === "GET" && url.pathname === "/api/auth/paypal/status") {
    const userId = getAuthenticatedUser(req);
    if (!userId) return send(res, 401, { error: "An authenticated user session is required." });
    if (!db) return send(res, 503, { error: "Database is required for PayPal account status." });
    await ensurePayPalConnectionSchema(db);
    return send(res, 200, await getConnectedAccountStatus(db, userId));
  }

  if (req.method === "POST" && url.pathname === "/api/auth/paypal/disconnect") {
    const userId = getAuthenticatedUser(req);
    if (!userId) return send(res, 401, { error: "An authenticated user session is required." });
    if (!db) return send(res, 503, { error: "Database is required to disconnect account." });
    await ensurePayPalConnectionSchema(db);
    const disconnected = await disconnectPayPalAccount(db, userId);
    return send(res, 200, { success: disconnected, message: disconnected ? "PayPal account disconnected." : "No active PayPal connection found." });
  }
  if(req.method==="POST"&&url.pathname==="/api/parse"){const b=await read(req);return send(res,200,{intent:await parse(String(b.text||""))});}
  if(req.method==="POST"&&url.pathname==="/api/ai/chat"){
   if(!requireBotOwner(req))return send(res,401,{error:"Authenticated Telegram owner session required."});
   const b=await read(req),prompt=String(b.text||"").trim();
   if(!prompt||prompt.length>1000)return send(res,400,{error:"Send a message between 1 and 1,000 characters."});
   const reply=await cloudPilotCompletion([{role:"system",content:"You are Transactra's informational assistant, powered by CloudPilot. Answer clearly and briefly. You may explain payment workflows and help prepare payment instructions, but you cannot authorize, create, approve, capture, or execute payments. Never claim an action was completed. Never ask for passwords, one-time codes, API keys, or payment credentials."},{role:"user",content:prompt}],384);
   return send(res,200,{reply,model:process.env.AI_MODEL||"stepfun-ai/step-5-preview"});
  }
  if(req.method==="POST"&&url.pathname==="/api/payments/prepare"){
   if(!requireBotOwner(req))return send(res,401,{error:"Authenticated Telegram session required."});
   await ensureDb();const userId=telegramUserId(req),b=await read(req),raw=String(b.text||"").trim();
   const intent=await parse(raw),idempotencyKey=String(req.headers["x-transactra-idempotency-key"]||""),prepared=await createPaymentApproval(userId,raw,intent,idempotencyKey||undefined);
   if(!prepared.ok)return send(res,422,{error:prepared.error});
   return send(res,201,prepared);
  }
  if(req.method==="POST"&&url.pathname==="/api/workflows/plan"){
   if(!requireBotOwner(req))return send(res,401,{error:"Authenticated Telegram session required."});
   await ensureWorkflowSchema();const userId=telegramUserId(req),b=await read(req),raw=String(b.text||"").trim(),idempotencyKey=String(req.headers["x-transactra-idempotency-key"]||"");
   if(idempotencyKey&&!/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey))return send(res,400,{error:"Invalid workflow idempotency key."});
   if(!raw||raw.length>4000)return send(res,400,{error:"Provide a workflow instruction under 4,000 characters."});
   const parts=splitPaymentInstructions(raw);
   if(parts.length<2||parts.length>8)return send(res,400,{error:"Use 2-8 payment instructions separated by semicolons, new lines, or then."});
   const intents=[];for(const part of parts)intents.push(await parse(part));
    if(idempotencyKey){
     const existing=await db!.query("SELECT id,raw_prompt,status,step_count FROM payment_workflows WHERE user_id=$1 AND idempotency_key=$2",[userId,idempotencyKey]);
     if(existing.rowCount){
      if(existing.rows[0].raw_prompt!==raw)return send(res,409,{error:"Idempotency key was already used for a different workflow."});
      const steps=await db!.query("SELECT sequence_no,recipient,purpose,amount::text,currency,status FROM payment_workflow_steps WHERE workflow_id=$1 ORDER BY sequence_no",[existing.rows[0].id]);
      const totals=steps.rows.reduce((a:any,p:any)=>{a[p.currency]=(a[p.currency]||0)+Number(p.amount);return a;},{} as Record<string,number>);
      return send(res,200,{workflowId:existing.rows[0].id,status:existing.rows[0].status,steps:steps.rows,totalAmountByCurrency:totals,idempotentReplay:true});
     }
    }

   const limits=await loadUserFinancialLimits(db!,userId),plannedByCurrency=new Map<string,number>(),plannedCounts=new Map<string,number>();
   for(const p of intents){
    const candidate={userId,amount:p.amount,currency:p.currency,recipient:p.recipient,purpose:p.purpose},hash=paymentPayloadHash(candidate);
    const exposure=await paymentExposure(db!,userId,p.currency,p.recipient,p.amount,p.purpose,undefined,hash),planned=plannedByCurrency.get(p.currency)||0,plannedCount=plannedCounts.get(p.currency)||0;
    const decision=evaluatePaymentPolicy(candidate,{...exposure,dailySpent:exposure.dailySpent+planned,dailyCount:exposure.dailyCount+plannedCount},limits);
    if(!decision.allowed)return send(res,422,{error:"Workflow blocked by Financial Policy Engine: "+decision.reason,policyVersion:decision.policyVersion});
    plannedByCurrency.set(p.currency,planned+Number(p.amount));plannedCounts.set(p.currency,plannedCount+1);
   }
   const workflowId=randomUUID();await db!.query("INSERT INTO payment_workflows(id,user_id,raw_prompt,status,step_count,idempotency_key) VALUES($1,$2,$3,'PENDING_APPROVAL',$4,$5)",[workflowId,userId,raw,parts.length,idempotencyKey||null]);
   for(let i=0;i<intents.length;i++){const p=intents[i]!;await db!.query("INSERT INTO payment_workflow_steps(id,workflow_id,sequence_no,recipient,purpose,amount,currency,status) VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING')",[randomUUID(),workflowId,i+1,p.recipient,p.purpose,p.amount,p.currency]);}
   return send(res,201,{workflowId,status:"PENDING_APPROVAL",steps:intents.map((p,i)=>({sequence:i+1,...p})),totalAmountByCurrency:intents.reduce((a,p)=>{a[p.currency]=(a[p.currency]||0)+Number(p.amount);return a;},{} as Record<string,number>)});
  }
  const wm=url.pathname.match(/^\/api\/workflows\/([0-9a-f-]+)(?:\/(approve|reject|next|step-up))?$/i);
  if(wm){
   if(!requireBotOwner(req))return send(res,401,{error:"Authenticated Telegram session required."});
   await ensureWorkflowSchema();const userId=telegramUserId(req),id=wm[1]!,action=wm[2]||"",w=await db!.query("SELECT id,status,step_count FROM payment_workflows WHERE id=$1 AND user_id=$2",[id,userId]);
   if(!w.rowCount)return send(res,404,{error:"Payment workflow not found."});
   if(req.method==="GET"&&!action){const steps=await db!.query("SELECT sequence_no,recipient,purpose,amount::text,currency,status,paypal_order_id FROM payment_workflow_steps WHERE workflow_id=$1 ORDER BY sequence_no",[id]);return send(res,200,{workflow:w.rows[0],steps:steps.rows});}
   if(req.method==="POST"&&action==="reject"){
     if(w.rows[0].status!=="PENDING_APPROVAL")return send(res,409,{error:"Only a pending workflow can be rejected."});
     const client=await db!.connect();try{await client.query("BEGIN");const changed=await client.query("UPDATE payment_workflows SET status='REJECTED',updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status='PENDING_APPROVAL' RETURNING id",[id,userId]);if(!changed.rowCount){await client.query("ROLLBACK");return send(res,409,{error:"Workflow was already decided."});}await client.query("UPDATE payment_workflow_steps SET status='REJECTED',updated_at=NOW() WHERE workflow_id=$1 AND status='PENDING'",[id]);await appendFinancialAudit(client,{userId,eventType:"WORKFLOW_REJECT",allowed:false,reason:"User rejected the payment workflow before order creation.",policyVersion:FINANCIAL_POLICY_VERSION,risk:"low",riskScore:0,payloadHash:createHash("sha256").update(id).digest("hex")});await client.query("COMMIT");return send(res,200,{status:"REJECTED"});}catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
    }
   if(req.method==="POST"&&action==="approve"){
     const client=await db!.connect();try{await client.query("BEGIN");const ok=await client.query("UPDATE payment_workflows SET status='APPROVED',updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status='PENDING_APPROVAL' RETURNING id",[id,userId]);if(!ok.rowCount){await client.query("ROLLBACK");return send(res,409,{error:"Workflow is not awaiting approval or was already approved."});}await client.query("UPDATE payment_workflow_steps SET status='READY',updated_at=NOW() WHERE workflow_id=$1 AND sequence_no=1 AND status='PENDING'",[id]);await appendFinancialAudit(client,{userId,eventType:"WORKFLOW_APPROVE",allowed:true,reason:"User explicitly approved the payment workflow; each step remains subject to fresh policy evaluation and PayPal buyer approval.",policyVersion:FINANCIAL_POLICY_VERSION,risk:"medium",riskScore:35,payloadHash:createHash("sha256").update(id).digest("hex")});await client.query("COMMIT");}catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
     return send(res,200,await createWorkflowOrder(id,userId));
    }
    if(req.method==="POST"&&action==="step-up"){
     const client=await db!.connect();try{await client.query("BEGIN");const q=await client.query("UPDATE payment_workflow_steps SET step_up_confirmed=TRUE,status='READY',updated_at=NOW() WHERE workflow_id=$1 AND status='AWAITING_STEP_UP' RETURNING sequence_no,amount::text,currency,recipient,purpose",[id]);if(!q.rowCount){await client.query("ROLLBACK");return send(res,409,{error:"No workflow step is waiting for additional confirmation."});}const step=q.rows[0];await appendFinancialAudit(client,{userId,eventType:"WORKFLOW_STEP_UP",allowed:true,reason:"User explicitly confirmed a high-value or elevated-risk workflow step.",policyVersion:FINANCIAL_POLICY_VERSION,risk:"high",riskScore:60,payloadHash:createHash("sha256").update(id+":"+step.sequence_no).digest("hex")});await client.query("COMMIT");}catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
     return send(res,200,await createWorkflowOrder(id,userId));
    }
   if(req.method==="POST"&&action==="next"){if(!["APPROVED","IN_PROGRESS"].includes(String(w.rows[0].status)))return send(res,409,{error:"Workflow is not approved for execution."});return send(res,200,await createWorkflowOrder(id,userId));}
   return send(res,405,{error:"Method not allowed."});
  }

  if(req.method==="GET"&&url.pathname==="/api/transactions"){
   if(!requireBotOwner(req))return send(res,401,{error:"Authenticated Telegram session required."});
   await ensureDb();const q=await db!.query("SELECT id,recipient,purpose,amount::text,currency,status,paypal_order_id,created_at FROM payment_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50",[telegramUserId(req)]);
   return send(res,200,{transactions:q.rows});
  }
   if(req.method==="POST"&&url.pathname==="/api/payments/reject"){
   if(!requireBotOwner(req))return send(res,401,{error:"Authenticated Telegram session required."});
   await ensureDb();const userId=telegramUserId(req),b=await read(req),approvalId=String(b.approvalId||"");
   if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(approvalId))return send(res,400,{error:"A valid payment approval is required."});
   const client=await db!.connect();
   try{
    await client.query("BEGIN");
    const q=await client.query("SELECT payload_hash,policy_version,risk_level,risk_score FROM payment_approval_challenges WHERE id=$1 AND user_id=$2 AND status='PENDING' AND expires_at>NOW() FOR UPDATE",[approvalId,userId]);
    if(!q.rowCount){await client.query("ROLLBACK");return send(res,409,{error:"This payment approval is no longer pending or has expired."});}
    await client.query("UPDATE payment_approval_challenges SET status='REJECTED' WHERE id=$1 AND user_id=$2 AND status='PENDING'",[approvalId,userId]);
    await appendFinancialAudit(client,{userId,eventType:"PAYMENT_REJECT",allowed:false,reason:"Owner explicitly revoked the pending transaction approval; no PayPal order was created.",policyVersion:q.rows[0].policy_version,risk:q.rows[0].risk_level,riskScore:Number(q.rows[0].risk_score),payloadHash:q.rows[0].payload_hash});
    await client.query("COMMIT");return send(res,200,{rejected:true});
   }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
  }
  if(req.method==="POST"&&url.pathname==="/api/payments/step-up"){
    if(!requireBotOwner(req))return send(res,401,{error:"Authenticated Telegram session required."});
    await ensureDb();const userId=telegramUserId(req),b=await read(req),approvalId=String(b.approvalId||"");
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(approvalId))return send(res,400,{error:"A valid payment approval is required."});
    const client=await db!.connect();
    try{
     await client.query("BEGIN");
     const q=await client.query("UPDATE payment_approval_challenges SET step_up_confirmed=TRUE WHERE id=$1 AND user_id=$2 AND status='PENDING' AND requires_step_up=TRUE AND expires_at>NOW() RETURNING payload_hash,policy_version,risk_level,risk_score",[approvalId,userId]);
     if(!q.rowCount){await client.query("ROLLBACK");return send(res,409,{error:"This payment does not require step-up or its approval has expired."});}
     await appendFinancialAudit(client,{userId,eventType:"PAYMENT_STEP_UP",allowed:true,reason:"User explicitly confirmed the high-value or elevated-risk payment.",policyVersion:q.rows[0].policy_version,risk:q.rows[0].risk_level,riskScore:Number(q.rows[0].risk_score),payloadHash:q.rows[0].payload_hash});
     await client.query("COMMIT");return send(res,200,{confirmed:true});
    }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
   }
  if(req.method==="POST"&&url.pathname==="/api/orders"){
   if(!requireBotOwner(req))return send(res,401,{error:"Authenticated Telegram session required."});
   await ensureDb();const b=await read(req),approvalId=String(b.approvalId||"");
   if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(approvalId))return send(res,400,{error:"A valid transaction approval is required."});
   assertPaymentEnvironment();
   const userId=telegramUserId(req),approved=await consumePaymentApproval(userId,approvalId);
   if(!approved.ok)return send(res,409,{error:approved.error});
   const id=approved.transactionId;
   try{
    const o=await createPayPalOrder(id,approved);
    const approveUrl=o.links?.find(x=>x.rel==="approve"||x.rel==="payer-action")?.href;
    if(!o.id||!approveUrl)throw Error("PayPal did not return a valid order approval link.");
    await db!.query("UPDATE payment_transactions SET paypal_order_id=$1,status='CREATED',updated_at=NOW() WHERE id=$2",[o.id,id]);
    return send(res,200,{orderId:o.id,status:o.status||"CREATED",approveUrl,policyVersion:approved.policyVersion,risk:approved.risk});
   }catch(e){await db!.query("UPDATE payment_transactions SET status='FAILED',updated_at=NOW() WHERE id=$1",[id]);throw e;}
  }
  const m=url.pathname.match(/^\/api\/orders\/([A-Z0-9]+)\/capture$/i);
   if(req.method==="POST"&&m){
    if(!requireBotOwner(req))return send(res,401,{error:"Authenticated Telegram session required."});
    await ensureDb();assertPaymentEnvironment();const orderId=m[1]!,userId=telegramUserId(req);
    const old=await db!.query("SELECT id,status,workflow_id,workflow_step_id,approval_id,amount::text,currency,recipient,purpose FROM payment_transactions WHERE paypal_order_id=$1 AND user_id=$2",[orderId,userId]);
    if(!old.rowCount)return send(res,404,{error:"PayPal order is not associated with this Telegram user."});
    const tx=old.rows[0] as {id:string;status:string;workflow_id:string|null;workflow_step_id:string|null;approval_id:string|null;amount:string;currency:string;recipient:string;purpose:string};
    if(tx.status==="COMPLETED")return send(res,200,{status:"COMPLETED",alreadyCaptured:true,workflowId:tx.workflow_id||undefined});
    const account=await getConnectedAccountStatus(db!,userId);
    if(!account.connected||!account.account?.verified)return send(res,403,{error:"A verified PayPal account must remain connected to capture this payment."});
    const claim=await db!.query("UPDATE payment_transactions SET status='CAPTURING',updated_at=NOW() WHERE id=$1 AND status IN ('CREATED','CAPTURE_PENDING') RETURNING id",[tx.id]);
    if(!claim.rowCount)return send(res,409,{error:"This order is already being captured or is not eligible for capture."});
    try{
     const order=await getPayPalOrder(orderId);
     const expected={orderId,payerId:account.account.payerId,transactionId:tx.id,amount:tx.amount,currency:tx.currency.trim()};
     const orderCheck=order.status==="COMPLETED"
      ?verifyPayPalCapturedOrder({...(order.id?{id:order.id}:{}),...(order.status?{status:order.status}:{}),...(order.payer?.payerId?{payer:{payer_id:order.payer.payerId}}:{}),...(order.purchaseUnits?{purchase_units:order.purchaseUnits.map(unit=>({...((unit.referenceId)?{reference_id:unit.referenceId}:{}),...(unit.amount?{amount:{currency_code:unit.amount.currencyCode,value:unit.amount.value}}:{}),...(unit.payments?.captures?{payments:{captures:unit.payments.captures.map(capture=>({...((capture.id)?{id:capture.id}:{}),...(capture.status?{status:capture.status}:{}),...(capture.amount?{amount:{currency_code:capture.amount.currencyCode,value:capture.amount.value}}:{})}))}}:{})}))}: {})},expected)
      :verifyPayPalOrder({...(order.id?{id:order.id}:{}),...(order.status?{status:order.status}:{}),...(order.payer?.payerId?{payer:{payer_id:order.payer.payerId}}:{}),...(order.purchaseUnits?{purchase_units:order.purchaseUnits.map(unit=>({...((unit.referenceId)?{reference_id:unit.referenceId}:{}),...(unit.amount?{amount:{currency_code:unit.amount.currencyCode,value:unit.amount.value}}:{})}))}: {})},expected);
     if(!orderCheck.allowed){
      const reason=orderCheck.reason,completedOrder=order.status==="COMPLETED";
      const audit=await db!.connect();
      try{await audit.query("BEGIN");await audit.query("UPDATE payment_transactions SET status=$1,updated_at=NOW() WHERE id=$2",[completedOrder?"CAPTURE_PENDING":"DENIED",tx.id]);await appendFinancialAudit(audit,{userId,eventType:completedOrder?"PAYMENT_CAPTURE_RECOVERY_REVIEW":"PAYMENT_CAPTURE",allowed:false,reason:completedOrder?"PayPal reports a completed order but capture verification needs manual review: "+reason:reason,policyVersion:FINANCIAL_POLICY_VERSION,risk:"high",riskScore:100,payloadHash:paymentPayloadHash({userId,amount:tx.amount,currency:tx.currency.trim(),recipient:tx.recipient,purpose:tx.purpose})});await audit.query("COMMIT");}catch(e){await audit.query("ROLLBACK");throw e;}finally{audit.release();}
      return send(res,completedOrder?202:403,completedOrder?{status:"CAPTURE_PENDING",manualReviewRequired:true,error:reason}:{error:reason});
     }
     const limits=await loadUserFinancialLimits(db!,userId),hash=paymentPayloadHash({userId,amount:tx.amount,currency:tx.currency.trim(),recipient:tx.recipient,purpose:tx.purpose});
     const exposure=await paymentExposure(db!,userId,tx.currency.trim(),tx.recipient,tx.amount,tx.purpose,tx.id,hash);
     const decision=evaluatePaymentPolicy({userId,amount:tx.amount,currency:tx.currency.trim(),recipient:tx.recipient,purpose:tx.purpose},exposure,limits);
     let stepUpConfirmed=true;
     if(tx.approval_id){const approval=await db!.query("SELECT step_up_confirmed FROM payment_approval_challenges WHERE id=$1 AND user_id=$2",[tx.approval_id,userId]);stepUpConfirmed=Boolean(approval.rows[0]?.step_up_confirmed);}
     else if(tx.workflow_step_id){const step=await db!.query("SELECT step_up_confirmed FROM payment_workflow_steps WHERE id=$1",[tx.workflow_step_id]);stepUpConfirmed=Boolean(step.rows[0]?.step_up_confirmed);}
     if(!decision.allowed||(decision.requiresStepUp&&!stepUpConfirmed)){
      const reason=decision.allowed?"Policy now requires an additional high-value confirmation; capture is blocked.":decision.reason;
      const audit=await db!.connect();
      try{await audit.query("BEGIN");await audit.query("UPDATE payment_transactions SET status='DENIED',updated_at=NOW() WHERE id=$1",[tx.id]);await appendFinancialAudit(audit,{userId,eventType:"PAYMENT_CAPTURE",allowed:false,reason,policyVersion:decision.policyVersion,risk:decision.risk,riskScore:decision.riskScore,payloadHash:hash});await audit.query("COMMIT");}catch(e){await audit.query("ROLLBACK");throw e;}finally{audit.release();}
      return send(res,409,{error:reason});
     }
     const recovered=order.status==="COMPLETED",captured=recovered?order:await capturePayPalOrder(orderId,tx.id+"-capture");
     const status=String(captured.status||"UNKNOWN"),capture=captured.purchaseUnits?.[0]?.payments?.captures?.[0],captureId=capture?.id||null,completed=status==="COMPLETED"&&capture?.status==="COMPLETED";
     const audit=await db!.connect();let workflowComplete:boolean|undefined;
     try{
      await audit.query("BEGIN");
      await audit.query("UPDATE payment_transactions SET status=$1,paypal_capture_id=$2,updated_at=NOW() WHERE id=$3",[completed?"COMPLETED":"CAPTURE_PENDING",captureId,tx.id]);
      await appendFinancialAudit(audit,{userId,eventType:recovered?"PAYMENT_CAPTURE_RECOVERED":"PAYMENT_CAPTURE",allowed:completed,reason:recovered?"Recovered a previously completed PayPal capture after an interrupted API response.":completed?"PayPal confirmed the capture.":"PayPal capture is pending or incomplete.",policyVersion:decision.policyVersion,risk:decision.risk,riskScore:decision.riskScore,payloadHash:hash});
      if(tx.workflow_id&&tx.workflow_step_id){
       await audit.query("UPDATE payment_workflow_steps SET status=$1,updated_at=NOW() WHERE id=$2",[completed?"COMPLETED":"PAYMENT_PENDING",tx.workflow_step_id]);
       if(completed){
        const remaining=await audit.query("SELECT id FROM payment_workflow_steps WHERE workflow_id=$1 AND status NOT IN ('COMPLETED','REJECTED') ORDER BY sequence_no LIMIT 1",[tx.workflow_id]);
        if(remaining.rowCount)await audit.query("UPDATE payment_workflow_steps SET status='READY',updated_at=NOW() WHERE id=$1 AND status='PENDING'",[remaining.rows[0].id]);
        else{await audit.query("UPDATE payment_workflows SET status='COMPLETED',updated_at=NOW() WHERE id=$1 AND user_id=$2",[tx.workflow_id,userId]);workflowComplete=true;}
       }
      }
      await audit.query("COMMIT");
     }catch(e){await audit.query("ROLLBACK");throw e;}finally{audit.release();}
     return send(res,completed?200:202,{status:completed?"COMPLETED":"CAPTURE_PENDING",captureId,recovered:recovered||undefined,workflowId:tx.workflow_id||undefined,workflowComplete});
    }catch(e){await db!.query("UPDATE payment_transactions SET status='CREATED',updated_at=NOW() WHERE id=$1 AND status='CAPTURING'",[tx.id]);throw e;}
   }
   return send(res,404,{error:"Route not found."});
 }catch(e){return send(res,500,{error:e instanceof Error?e.message:"Unexpected server error"});}
}
const server=createServer((req,res)=>{void route(req,res);});server.listen(port,host,()=>console.log("Transactra API listening at http://"+host+":"+port));
process.on("SIGINT",async()=>{await db?.end();server.close();});process.on("SIGTERM",async()=>{await db?.end();server.close();});