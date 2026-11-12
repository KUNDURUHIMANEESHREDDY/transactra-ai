import {createServer,type IncomingMessage,type ServerResponse} from "node:http";
import {randomUUID,timingSafeEqual} from "node:crypto";
import {processTelegramUpdate} from "../../telegram/src/bot.js";
import {Pool} from "pg";
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
import { getAuthenticatedUser } from "./request-auth.js";
import { handleObservabilityRoute } from "./observability.js";
import { assertPaymentEnvironment, evaluatePaymentPolicy, getFinancialPolicyLimits, paymentPayloadHash } from "./financial-policy.js";
const port=Number(process.env.PORT||8787),host=process.env.HOST||"127.0.0.1";
const clientId=process.env.PAYPAL_CLIENT_ID||"",secret=process.env.PAYPAL_CLIENT_SECRET||"";
const paypalBase=process.env.PAYPAL_ENV==="live"?"https://api-m.paypal.com":"https://api-m.sandbox.paypal.com";
const db=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL}):null;
const currencies=new Set(["USD","EUR","GBP","INR","CAD","AUD","SGD","JPY"]);
const processedTelegramUpdates=new Set<number>();
type Intent={amount:string;currency:string;recipient:string;purpose:string;confidence:number;source:"rules"|"model"};
function send(res:ServerResponse,status:number,data:unknown){res.writeHead(status,{"Content-Type":"application/json","Cache-Control":"no-store"});res.end(JSON.stringify(data));}
async function read(req:IncomingMessage){let raw="";for await(const c of req)raw+=c;if(raw.length>20000)throw Error("Request too large");return raw?JSON.parse(raw) as Record<string,unknown>:{};}
function rules(text:string):Intent{
 const m=text.match(/(?:\b(?:USD|EUR|GBP|INR|CAD|AUD|SGD|JPY)\s*)?[$€£₹]?\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)/i);
 if(!m)throw Error("Add a clear amount, such as $24.50 or 850 INR.");
 const n=Number((m[1]||"").replaceAll(",",""));if(!Number.isFinite(n)||n<=0||n>1000000)throw Error("Amount must be greater than zero and no more than 1,000,000.");
 const up=text.toUpperCase(),currency=up.match(/\b(USD|EUR|GBP|INR|CAD|AUD|SGD|JPY)\b/)?.[1]||(text.includes("₹")?"INR":text.includes("€")?"EUR":text.includes("£")?"GBP":"USD");
 const recipient=text.match(/\bto\s+([A-Za-z][A-Za-z0-9 &.'-]{0,59}?)(?=\s+(?:for|as|because|with|using)\b|[,.;]|$)/i)?.[1]?.trim();
 if(!recipient)throw Error("Who is this payment for? Include a recipient, for example “to Alex”.");
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
}
async function token(){if(!clientId||!secret)throw Error("PayPal Sandbox credentials are not configured on the server.");const auth=Buffer.from(clientId+":"+secret).toString("base64");const r=await fetch(paypalBase+"/v1/oauth2/token",{method:"POST",headers:{Authorization:"Basic "+auth,"Content-Type":"application/x-www-form-urlencoded"},body:"grant_type=client_credentials"});const d=await r.json() as {access_token?:string;error_description?:string};if(!r.ok||!d.access_token)throw Error(d.error_description||"PayPal authentication failed.");return d.access_token;}
async function paypal(path:string,t:string,method:string,payload?:unknown,requestId?:string){const r=await fetch(paypalBase+path,{method,headers:{Authorization:"Bearer "+t,"Content-Type":"application/json",...(requestId?{"PayPal-Request-Id":requestId}:{})},...(payload?{body:JSON.stringify(payload)}:{})});const d=await r.json() as Record<string,unknown>;if(!r.ok)throw Error(String(d.message||d.name||"PayPal request failed"));return d;}
async function ensureWorkflowSchema(){
 await ensureDb();
 await db!.query("CREATE TABLE IF NOT EXISTS payment_workflows(id UUID PRIMARY KEY,user_id TEXT NOT NULL,raw_prompt TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('PENDING_APPROVAL','APPROVED','IN_PROGRESS','COMPLETED','REJECTED','FAILED')),step_count INTEGER NOT NULL CHECK(step_count BETWEEN 2 AND 8),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
 await db!.query("ALTER TABLE payment_workflows ADD COLUMN IF NOT EXISTS user_id TEXT");
 await db!.query("CREATE TABLE IF NOT EXISTS payment_workflow_steps(id UUID PRIMARY KEY,workflow_id UUID NOT NULL REFERENCES payment_workflows(id),sequence_no INTEGER NOT NULL CHECK(sequence_no BETWEEN 1 AND 8),recipient TEXT NOT NULL,purpose TEXT NOT NULL,amount NUMERIC(18,2) NOT NULL CHECK(amount>0),currency CHAR(3) NOT NULL,status TEXT NOT NULL DEFAULT 'PENDING',paypal_order_id TEXT UNIQUE,approve_url TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(workflow_id,sequence_no))");
 await db!.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS workflow_id UUID REFERENCES payment_workflows(id)");
 await db!.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS workflow_step_id UUID REFERENCES payment_workflow_steps(id)");
}
function requireBotOwner(req:IncomingMessage){
 const expected=String(process.env.BACKEND_SHARED_SECRET||""),supplied=String(req.headers["x-transactra-edge-secret"]||"");
 const owner=String(process.env.TELEGRAM_OWNER_ID||""),user=String(req.headers["x-transactra-owner-id"]||"");
 const a=Buffer.from(expected),b=Buffer.from(supplied);
 return Boolean(expected.length>=32&&owner&&/^\d{1,20}$/.test(owner)&&user===owner&&supplied&&a.length===b.length&&timingSafeEqual(a,b));
}
function telegramUserId(req:IncomingMessage){return "telegram:"+String(req.headers["x-transactra-owner-id"]||"");}
async function paymentExposure(userId:string,currency:string){
 const q=await db!.query("SELECT COALESCE(SUM(amount),0)::text AS spent,COUNT(*)::int AS count FROM payment_transactions WHERE user_id=$1 AND currency=$2 AND created_at >= NOW()-INTERVAL '24 hours' AND status NOT IN ('FAILED','CANCELLED','DENIED')",[userId,currency]);
 return {dailySpent:Number(q.rows[0]?.spent||0),dailyCount:Number(q.rows[0]?.count||0)};
}
function policyError(decision:ReturnType<typeof evaluatePaymentPolicy>){return decision.reason;}

async function createPaymentApproval(userId:string,raw:string,intent:Intent){
 assertPaymentEnvironment();
 const client=await db!.connect();
 try{
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",[userId,intent.currency]);
  const rate=await client.query("SELECT COUNT(*) FILTER (WHERE status='PENDING' AND expires_at>NOW())::int AS pending,COUNT(*) FILTER (WHERE created_at>NOW()-INTERVAL '10 minutes')::int AS recent FROM payment_approval_challenges WHERE user_id=$1",[userId]);
  if(Number(rate.rows[0]?.pending||0)>=5||Number(rate.rows[0]?.recent||0)>=10){
   const reason="Payment request rate limit reached; wait before creating another approval.";
   await client.query("INSERT INTO financial_policy_audit(user_id,event_type,allowed,reason,policy_version,risk_level) VALUES($1,'PAYMENT_PREPARE',false,$2,$3,'high')",[userId,reason,"2026-11-12.1"]);
   await client.query("COMMIT");return {ok:false as const,error:reason};
  }
  const exposure=await client.query("SELECT COALESCE(SUM(amount),0)::text AS spent,COUNT(*)::int AS count FROM payment_transactions WHERE user_id=$1 AND currency=$2 AND created_at>=NOW()-INTERVAL '24 hours' AND status NOT IN ('FAILED','CANCELLED','DENIED')",[userId,intent.currency]);
  const decision=evaluatePaymentPolicy({userId,amount:intent.amount,currency:intent.currency,recipient:intent.recipient,purpose:intent.purpose},{dailySpent:Number(exposure.rows[0]?.spent||0),dailyCount:Number(exposure.rows[0]?.count||0)});
  if(!decision.allowed){
   await client.query("INSERT INTO financial_policy_audit(user_id,event_type,allowed,reason,policy_version,risk_level) VALUES($1,'PAYMENT_PREPARE',false,$2,$3,$4)",[userId,decision.reason,decision.policyVersion,decision.risk]);
   await client.query("COMMIT");return {ok:false as const,error:decision.reason};
  }
  const normalized=decision.normalized!,approvalId=randomUUID(),hash=paymentPayloadHash(normalized);
  await client.query("INSERT INTO payment_approval_challenges(id,user_id,raw_prompt,recipient,purpose,amount,currency,payload_hash,policy_version,risk_level,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()+INTERVAL '10 minutes')",[approvalId,userId,raw.slice(0,1000),normalized.recipient,normalized.purpose,normalized.amount,normalized.currency,hash,decision.policyVersion,decision.risk]);
  await client.query("INSERT INTO financial_policy_audit(user_id,event_type,allowed,reason,policy_version,risk_level,payload_hash) VALUES($1,'PAYMENT_PREPARE',true,$2,$3,$4,$5)",[userId,decision.reason,decision.policyVersion,decision.risk,hash]);
  await client.query("COMMIT");
  return {ok:true as const,approvalId,intent:{...intent,amount:normalized.amount,currency:normalized.currency,recipient:normalized.recipient,purpose:normalized.purpose},risk:decision.risk,policyVersion:decision.policyVersion,expiresInSeconds:600};
 }catch(error){await client.query("ROLLBACK");throw error;}
 finally{client.release();}
}
async function consumePaymentApproval(userId:string,approvalId:string){
 const client=await db!.connect();
 try{
  await client.query("BEGIN");
  const result=await client.query("SELECT raw_prompt,recipient,purpose,amount::text,currency,payload_hash,policy_version,risk_level,status,expires_at FROM payment_approval_challenges WHERE id=$1 AND user_id=$2 FOR UPDATE",[approvalId,userId]);
  if(!result.rowCount){await client.query("ROLLBACK");return {ok:false as const,error:"Approval is invalid or belongs to another user."};}
  const c=result.rows[0] as {raw_prompt:string;recipient:string;purpose:string;amount:string;currency:string;payload_hash:string;policy_version:string;risk_level:string;status:string;expires_at:Date};
  if(c.status!=="PENDING"||new Date(c.expires_at).getTime()<=Date.now()){
   if(c.status==="PENDING")await client.query("UPDATE payment_approval_challenges SET status='EXPIRED' WHERE id=$1",[approvalId]);
   await client.query("COMMIT");return {ok:false as const,error:"Approval is expired, already used, or no longer pending."};
  }
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",[userId,c.currency.trim()]);
  const normalized={userId,amount:c.amount,currency:c.currency.trim(),recipient:c.recipient,purpose:c.purpose};
  const hash=paymentPayloadHash(normalized);
  if(hash!==c.payload_hash){
   await client.query("UPDATE payment_approval_challenges SET status='DENIED' WHERE id=$1",[approvalId]);
   await client.query("INSERT INTO financial_policy_audit(user_id,event_type,allowed,reason,policy_version,risk_level,payload_hash) VALUES($1,'PAYMENT_EXECUTE',false,'Approval payload integrity check failed',$2,'high',$3)",[userId,c.policy_version,hash]);
   await client.query("COMMIT");return {ok:false as const,error:"Approval payload integrity check failed."};
  }
  const exposure=await client.query("SELECT COALESCE(SUM(amount),0)::text AS spent,COUNT(*)::int AS count FROM payment_transactions WHERE user_id=$1 AND currency=$2 AND created_at>=NOW()-INTERVAL '24 hours' AND status NOT IN ('FAILED','CANCELLED','DENIED')",[userId,normalized.currency]);
  const decision=evaluatePaymentPolicy(normalized,{dailySpent:Number(exposure.rows[0]?.spent||0),dailyCount:Number(exposure.rows[0]?.count||0)});
  if(!decision.allowed){
   await client.query("UPDATE payment_approval_challenges SET status='DENIED' WHERE id=$1",[approvalId]);
   await client.query("INSERT INTO financial_policy_audit(user_id,event_type,allowed,reason,policy_version,risk_level,payload_hash) VALUES($1,'PAYMENT_EXECUTE',false,$2,$3,$4,$5)",[userId,decision.reason,decision.policyVersion,decision.risk,hash]);
   await client.query("COMMIT");return {ok:false as const,error:decision.reason};
  }
  const transactionId=randomUUID();
  await client.query("UPDATE payment_approval_challenges SET status='CONSUMED',consumed_at=NOW() WHERE id=$1 AND status='PENDING'",[approvalId]);
  await client.query("INSERT INTO payment_transactions(id,user_id,approval_id,raw_prompt,recipient,purpose,amount,currency,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'CREATING')",[transactionId,userId,approvalId,c.raw_prompt,c.recipient,c.purpose,c.amount,normalized.currency]);
  await client.query("INSERT INTO financial_policy_audit(user_id,event_type,allowed,reason,policy_version,risk_level,payload_hash) VALUES($1,'PAYMENT_EXECUTE',true,$2,$3,$4,$5)",[userId,decision.reason,c.policy_version,c.risk_level,hash]);
  await client.query("COMMIT");
  return {ok:true as const,transactionId,rawPrompt:c.raw_prompt,recipient:c.recipient,purpose:c.purpose,amount:c.amount,currency:normalized.currency,policyVersion:c.policy_version,risk:c.risk_level};
 }catch(error){await client.query("ROLLBACK");throw error;}
 finally{client.release();}
}
function splitPaymentInstructions(text:string){return text.split(/\s*(?:;|\n+|\bthen\b)\s*/i).map(x=>x.trim()).filter(Boolean);}
async function createWorkflowOrder(workflowId:string,userId:string){
 assertPaymentEnvironment();
 const client=await db!.connect();
 let transactionId="",p:{id:string;sequence_no:number;recipient:string;purpose:string;amount:string;currency:string}|undefined,totalSteps=0;
 try{
  await client.query("BEGIN");
  const workflow=await client.query("SELECT status,step_count FROM payment_workflows WHERE id=$1 AND user_id=$2 FOR UPDATE",[workflowId,userId]);
  if(!workflow.rowCount){await client.query("ROLLBACK");throw Error("Payment workflow not found.");}
  if(!["APPROVED","IN_PROGRESS"].includes(String(workflow.rows[0].status))){await client.query("ROLLBACK");throw Error("Workflow is not approved for execution.");}
  totalSteps=Number(workflow.rows[0].step_count);
  const q=await client.query("SELECT id,sequence_no,recipient,purpose,amount::text,currency FROM payment_workflow_steps WHERE workflow_id=$1 AND status='READY' ORDER BY sequence_no LIMIT 1 FOR UPDATE",[workflowId]);
  if(!q.rowCount){await client.query("COMMIT");return {complete:workflow.rows[0].status==="COMPLETED",pending:true};}
  p=q.rows[0] as {id:string;sequence_no:number;recipient:string;purpose:string;amount:string;currency:string};
  const currency=p.currency.trim();
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",[userId,currency]);
  const exposure=await client.query("SELECT COALESCE(SUM(amount),0)::text AS spent,COUNT(*)::int AS count FROM payment_transactions WHERE user_id=$1 AND currency=$2 AND created_at>=NOW()-INTERVAL '24 hours' AND status NOT IN ('FAILED','CANCELLED','DENIED')",[userId,currency]);
  const decision=evaluatePaymentPolicy({userId,amount:p.amount,currency,recipient:p.recipient,purpose:p.purpose},{dailySpent:Number(exposure.rows[0]?.spent||0),dailyCount:Number(exposure.rows[0]?.count||0)});
  if(!decision.allowed){
   await client.query("UPDATE payment_workflow_steps SET status='POLICY_BLOCKED',updated_at=NOW() WHERE id=$1",[p.id]);
   await client.query("UPDATE payment_workflows SET status='FAILED',updated_at=NOW() WHERE id=$1",[workflowId]);
   await client.query("INSERT INTO financial_policy_audit(user_id,event_type,allowed,reason,policy_version,risk_level) VALUES($1,'WORKFLOW_EXECUTE',false,$2,$3,$4)",[userId,decision.reason,decision.policyVersion,decision.risk]);
   await client.query("COMMIT");throw Error("Workflow blocked by Financial Policy Engine: "+decision.reason);
  }
  transactionId=randomUUID();
  await client.query("UPDATE payment_workflow_steps SET status='CREATING',updated_at=NOW() WHERE id=$1 AND status='READY'",[p.id]);
  await client.query("INSERT INTO payment_transactions(id,user_id,raw_prompt,recipient,purpose,amount,currency,status,workflow_id,workflow_step_id) VALUES($1,$2,$3,$4,$5,$6,$7,'CREATING',$8,$9)",[transactionId,userId,"Approved workflow "+workflowId,p.recipient,p.purpose,p.amount,currency,workflowId,p.id]);
  await client.query("INSERT INTO financial_policy_audit(user_id,event_type,allowed,reason,policy_version,risk_level,payload_hash) VALUES($1,'WORKFLOW_EXECUTE',true,$2,$3,$4,$5)",[userId,decision.reason,decision.policyVersion,decision.risk,paymentPayloadHash({userId,amount:p.amount,currency,recipient:p.recipient,purpose:p.purpose})]);
  await client.query("COMMIT");
 }catch(error){
  try{await client.query("ROLLBACK");}catch{}
  throw error;
 }finally{client.release();}
 if(!p||!transactionId)return {pending:true};
 try{
  const access=await token();
  const order=await paypal("/v2/checkout/orders",access,"POST",{intent:"CAPTURE",purchase_units:[{reference_id:transactionId,description:p.purpose.slice(0,127),amount:{currency_code:p.currency.trim(),value:p.amount}}],application_context:{brand_name:"Transactra",user_action:"PAY_NOW",shipping_preference:"NO_SHIPPING"}},transactionId) as {id?:string;links?:Array<{rel?:string;href?:string}>};
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
  if(req.method==="GET"&&url.pathname==="/api/config")return send(res,200,{paypalClientId:clientId,paypalConfigured:Boolean(clientId&&secret),environment:process.env.PAYPAL_ENV||"sandbox"});

  // Telegram authenticates the owner; the browser receives a one-time launch ticket.
  if (req.method === "GET" && url.pathname === "/api/auth/paypal/connect") {
    if (!requireBotOwner(req)) return send(res, 401, { error: "Authenticated Telegram owner session required." });
    if (!db) return send(res, 503, { error: "Database is required for persistent OAuth connection." });
    if (!process.env.TOKEN_ENCRYPTION_SECRET || Buffer.byteLength(process.env.TOKEN_ENCRYPTION_SECRET, "utf8") < 32)
      return send(res, 503, { error: "TOKEN_ENCRYPTION_SECRET must be configured with at least 32 bytes." });
    await ensurePayPalConnectionSchema(db);
    const browserSession = createOAuthSessionToken();
    const sessionHash = hashOAuthSession(browserSession);
    const { state } = await createOAuthState(db, telegramUserId(req), sessionHash);
    const launch = new URL("/api/auth/paypal/start", getPayPalConfig().redirectUri);
    launch.searchParams.set("state", state);
    launch.searchParams.set("session", browserSession);
    return send(res, 200, { authorizeUrl: launch.toString(), provider: "PayPal", environment: process.env.PAYPAL_ENV || "sandbox" });
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
      "UPDATE paypal_oauth_states SET launch_used_at=NOW() WHERE state=$1 AND session_hash=$2 AND launch_used_at IS NULL AND used_at IS NULL AND expires_at>NOW() RETURNING state",
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
   const intent=await parse(raw),prepared=await createPaymentApproval(userId,raw,intent);
   if(!prepared.ok)return send(res,422,{error:prepared.error});
   return send(res,201,prepared);
  }
  if(req.method==="POST"&&url.pathname==="/api/workflows/plan"){
   if(!requireBotOwner(req))return send(res,401,{error:"Authenticated Telegram session required."});
   await ensureWorkflowSchema();const userId=telegramUserId(req),b=await read(req),raw=String(b.text||"").trim();
   if(!raw||raw.length>4000)return send(res,400,{error:"Provide a workflow instruction under 4,000 characters."});
   const parts=splitPaymentInstructions(raw);
   if(parts.length<2||parts.length>8)return send(res,400,{error:"Use 2–8 payment instructions separated by semicolons, new lines, or 'then'."});
   const intents=[];for(const part of parts)intents.push(await parse(part));
   const limits=getFinancialPolicyLimits(),plannedByCurrency=new Map<string,number>(),plannedCounts=new Map<string,number>();
   for(const p of intents){
    const exposure=await paymentExposure(userId,p.currency),planned=plannedByCurrency.get(p.currency)||0,plannedCount=plannedCounts.get(p.currency)||0;
    const decision=evaluatePaymentPolicy({userId,amount:p.amount,currency:p.currency,recipient:p.recipient,purpose:p.purpose},{dailySpent:exposure.dailySpent+planned,dailyCount:exposure.dailyCount+plannedCount},limits);
    if(!decision.allowed)return send(res,422,{error:"Workflow blocked by Financial Policy Engine: "+decision.reason,policyVersion:decision.policyVersion});
    plannedByCurrency.set(p.currency,planned+Number(p.amount));plannedCounts.set(p.currency,plannedCount+1);
   }
   const workflowId=randomUUID();await db!.query("INSERT INTO payment_workflows(id,user_id,raw_prompt,status,step_count) VALUES($1,$2,$3,'PENDING_APPROVAL',$4)",[workflowId,userId,raw,parts.length]);
   for(let i=0;i<intents.length;i++){const p=intents[i]!;await db!.query("INSERT INTO payment_workflow_steps(id,workflow_id,sequence_no,recipient,purpose,amount,currency,status) VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING')",[randomUUID(),workflowId,i+1,p.recipient,p.purpose,p.amount,p.currency]);}
   return send(res,201,{workflowId,status:"PENDING_APPROVAL",steps:intents.map((p,i)=>({sequence:i+1,...p})),totalAmountByCurrency:intents.reduce((a,p)=>{a[p.currency]=(a[p.currency]||0)+Number(p.amount);return a;},{} as Record<string,number>)});
  }
  const wm=url.pathname.match(/^\/api\/workflows\/([0-9a-f-]+)(?:\/(approve|reject|next))?$/i);
  if(wm){
   if(!requireBotOwner(req))return send(res,401,{error:"Authenticated Telegram session required."});
   await ensureWorkflowSchema();const userId=telegramUserId(req),id=wm[1]!,action=wm[2]||"",w=await db!.query("SELECT id,status,step_count FROM payment_workflows WHERE id=$1 AND user_id=$2",[id,userId]);
   if(!w.rowCount)return send(res,404,{error:"Payment workflow not found."});
   if(req.method==="GET"&&!action){const steps=await db!.query("SELECT sequence_no,recipient,purpose,amount::text,currency,status,paypal_order_id FROM payment_workflow_steps WHERE workflow_id=$1 ORDER BY sequence_no",[id]);return send(res,200,{workflow:w.rows[0],steps:steps.rows});}
   if(req.method==="POST"&&action==="reject"){if(w.rows[0].status!=="PENDING_APPROVAL")return send(res,409,{error:"Only a pending workflow can be rejected."});await db!.query("UPDATE payment_workflows SET status='REJECTED',updated_at=NOW() WHERE id=$1",[id]);await db!.query("UPDATE payment_workflow_steps SET status='REJECTED',updated_at=NOW() WHERE workflow_id=$1 AND status='PENDING'",[id]);return send(res,200,{status:"REJECTED"});}
   if(req.method==="POST"&&action==="approve"){const ok=await db!.query("UPDATE payment_workflows SET status='APPROVED',updated_at=NOW() WHERE id=$1 AND status='PENDING_APPROVAL' RETURNING id",[id]);if(!ok.rowCount)return send(res,409,{error:"Workflow is not awaiting approval or was already approved."});await db!.query("UPDATE payment_workflow_steps SET status='READY',updated_at=NOW() WHERE workflow_id=$1 AND sequence_no=1 AND status='PENDING'",[id]);return send(res,200,await createWorkflowOrder(id,userId));}
   if(req.method==="POST"&&action==="next"){if(!["APPROVED","IN_PROGRESS"].includes(String(w.rows[0].status)))return send(res,409,{error:"Workflow is not approved for execution."});return send(res,200,await createWorkflowOrder(id,userId));}
   return send(res,405,{error:"Method not allowed."});
  }

  if(req.method==="GET"&&url.pathname==="/api/transactions"){
   if(!requireBotOwner(req))return send(res,401,{error:"Authenticated Telegram session required."});
   await ensureDb();const q=await db!.query("SELECT id,recipient,purpose,amount::text,currency,status,paypal_order_id,created_at FROM payment_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50",[telegramUserId(req)]);
   return send(res,200,{transactions:q.rows});
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
    const t=await token();
    const o=await paypal("/v2/checkout/orders",t,"POST",{intent:"CAPTURE",purchase_units:[{reference_id:id,description:approved.purpose.slice(0,127),amount:{currency_code:approved.currency,value:approved.amount}}],application_context:{brand_name:"Transactra",user_action:"PAY_NOW",shipping_preference:"NO_SHIPPING"}},id) as {id?:string;status?:string;links?:Array<{rel?:string;href?:string}>};
    const approveUrl=o.links?.find(x=>x.rel==="approve"||x.rel==="payer-action")?.href;
    if(!o.id||!approveUrl)throw Error("PayPal did not return a valid order approval link.");
    await db!.query("UPDATE payment_transactions SET paypal_order_id=$1,status='CREATED',updated_at=NOW() WHERE id=$2",[o.id,id]);
    return send(res,200,{orderId:o.id,status:o.status||"CREATED",approveUrl,policyVersion:approved.policyVersion,risk:approved.risk});
   }catch(e){await db!.query("UPDATE payment_transactions SET status='FAILED',updated_at=NOW() WHERE id=$1",[id]);throw e;}
  }
  const m=url.pathname.match(/^\/api\/orders\/([A-Z0-9]+)\/capture$/i);
  if(req.method==="POST"&&m){
   if(!requireBotOwner(req))return send(res,401,{error:"Authenticated Telegram session required."});
   await ensureDb();assertPaymentEnvironment();const id=m[1]!,userId=telegramUserId(req);
   const old=await db!.query("SELECT id,status,workflow_id,workflow_step_id FROM payment_transactions WHERE paypal_order_id=$1 AND user_id=$2",[id,userId]);
   if(!old.rowCount)return send(res,404,{error:"PayPal order is not associated with this Telegram user."});
   if(old.rows[0].status==="COMPLETED")return send(res,200,{status:"COMPLETED",alreadyCaptured:true,workflowId:old.rows[0].workflow_id||undefined});
   const claim=await db!.query("UPDATE payment_transactions SET status='CAPTURING',updated_at=NOW() WHERE id=$1 AND status='CREATED' RETURNING id",[old.rows[0].id]);
   if(!claim.rowCount)return send(res,409,{error:"This order is already being captured or is not eligible for capture."});
   try{
    const t=await token();
    const d=await paypal("/v2/checkout/orders/"+encodeURIComponent(id)+"/capture",t,"POST",{},String(old.rows[0].id)+"-capture") as {status?:string;purchase_units?:Array<{payments?:{captures?:Array<{id?:string;status?:string}>}} >};
    const status=String(d.status||"UNKNOWN"),capture=d.purchase_units?.[0]?.payments?.captures?.[0],captureId=capture?.id||null;
    const completed=status==="COMPLETED"&&capture?.status==="COMPLETED";
    await db!.query("UPDATE payment_transactions SET status=$1,paypal_capture_id=$2,updated_at=NOW() WHERE id=$3",[completed?"COMPLETED":"CAPTURE_PENDING",captureId,old.rows[0].id]);
    let workflowId:string|undefined,workflowComplete:boolean|undefined;
    if(old.rows[0].workflow_id&&old.rows[0].workflow_step_id){
     workflowId=String(old.rows[0].workflow_id);
     await db!.query("UPDATE payment_workflow_steps SET status=$1,updated_at=NOW() WHERE id=$2",[completed?"COMPLETED":"PAYMENT_PENDING",old.rows[0].workflow_step_id]);
     if(completed){
      const remaining=await db!.query("SELECT id FROM payment_workflow_steps WHERE workflow_id=$1 AND status NOT IN ('COMPLETED','REJECTED') ORDER BY sequence_no LIMIT 1",[workflowId]);
      if(remaining.rowCount)await db!.query("UPDATE payment_workflow_steps SET status='READY',updated_at=NOW() WHERE id=$1 AND status='PENDING'",[remaining.rows[0].id]);
      else{await db!.query("UPDATE payment_workflows SET status='COMPLETED',updated_at=NOW() WHERE id=$1 AND user_id=$2",[workflowId,userId]);workflowComplete=true;}
     }
    }
    return send(res,completed?200:202,{status:completed?"COMPLETED":"CAPTURE_PENDING",captureId,workflowId,workflowComplete});
   }catch(e){await db!.query("UPDATE payment_transactions SET status='CREATED',updated_at=NOW() WHERE id=$1 AND status='CAPTURING'",[old.rows[0].id]);throw e;}
  }
  return send(res,404,{error:"Route not found."});
 }catch(e){return send(res,500,{error:e instanceof Error?e.message:"Unexpected server error"});}
}
const server=createServer((req,res)=>{void route(req,res);});server.listen(port,host,()=>console.log("Transactra API listening at http://"+host+":"+port));
process.on("SIGINT",async()=>{await db?.end();server.close();});process.on("SIGTERM",async()=>{await db?.end();server.close();});