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
  getPayPalConfig
} from "./paypal-oauth.js";
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
async function parse(text:string):Promise<Intent>{
 if(!text.trim()||text.length>1000)throw Error("Enter a payment request under 1,000 characters.");
 const base=process.env.AI_BASE_URL,key=process.env.AI_API_KEY,model=process.env.AI_MODEL;
 if(base&&key&&model)try{
  const r=await fetch(base.replace(/\/$/,"")+"/chat/completions",{method:"POST",headers:{Authorization:"Bearer "+key,"Content-Type":"application/json"},body:JSON.stringify({model,temperature:0,response_format:{type:"json_object"},messages:[{role:"system",content:"Extract payment amount, currency, recipient and purpose as JSON. Never infer missing amount or recipient."},{role:"user",content:text}]}),signal:AbortSignal.timeout(12000)});
  if(r.ok){const data=await r.json() as {choices?:Array<{message?:{content?:string}}>};const p=JSON.parse(data.choices?.[0]?.message?.content||"{}") as Record<string,unknown>;const amount=Number(p.amount),currency=String(p.currency||"USD").toUpperCase(),recipient=String(p.recipient||"").trim();if(Number.isFinite(amount)&&amount>0&&amount<=1000000&&currencies.has(currency)&&recipient)return {amount:amount.toFixed(2),currency,recipient:recipient.slice(0,80),purpose:String(p.purpose||"Payment").slice(0,120),confidence:.97,source:"model"};}
 }catch{/* no-key deterministic fallback */}
 return rules(text);
}
async function ensureDb(){if(!db)throw Error("DATABASE_URL is required. Start PostgreSQL with docker compose and configure .env.");await db.query("CREATE TABLE IF NOT EXISTS payment_transactions(id UUID PRIMARY KEY,raw_prompt TEXT NOT NULL,recipient TEXT NOT NULL,purpose TEXT NOT NULL,amount NUMERIC(18,2) NOT NULL CHECK(amount>0),currency CHAR(3) NOT NULL,status TEXT NOT NULL,paypal_order_id TEXT UNIQUE,paypal_capture_id TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");}
async function token(){if(!clientId||!secret)throw Error("PayPal Sandbox credentials are not configured on the server.");const auth=Buffer.from(clientId+":"+secret).toString("base64");const r=await fetch(paypalBase+"/v1/oauth2/token",{method:"POST",headers:{Authorization:"Basic "+auth,"Content-Type":"application/x-www-form-urlencoded"},body:"grant_type=client_credentials"});const d=await r.json() as {access_token?:string;error_description?:string};if(!r.ok||!d.access_token)throw Error(d.error_description||"PayPal authentication failed.");return d.access_token;}
async function paypal(path:string,t:string,method:string,payload?:unknown,requestId?:string){const r=await fetch(paypalBase+path,{method,headers:{Authorization:"Bearer "+t,"Content-Type":"application/json",...(requestId?{"PayPal-Request-Id":requestId}:{})},...(payload?{body:JSON.stringify(payload)}:{})});const d=await r.json() as Record<string,unknown>;if(!r.ok)throw Error(String(d.message||d.name||"PayPal request failed"));return d;}
async function ensureWorkflowSchema(){
 await ensureDb();
 await db!.query("CREATE TABLE IF NOT EXISTS payment_workflows(id UUID PRIMARY KEY,raw_prompt TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('PENDING_APPROVAL','APPROVED','IN_PROGRESS','COMPLETED','REJECTED','FAILED')),step_count INTEGER NOT NULL CHECK(step_count BETWEEN 2 AND 8),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
 await db!.query("CREATE TABLE IF NOT EXISTS payment_workflow_steps(id UUID PRIMARY KEY,workflow_id UUID NOT NULL REFERENCES payment_workflows(id),sequence_no INTEGER NOT NULL CHECK(sequence_no BETWEEN 1 AND 8),recipient TEXT NOT NULL,purpose TEXT NOT NULL,amount NUMERIC(18,2) NOT NULL CHECK(amount>0),currency CHAR(3) NOT NULL,status TEXT NOT NULL DEFAULT 'PENDING',paypal_order_id TEXT UNIQUE,approve_url TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(workflow_id,sequence_no))");
 await db!.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS workflow_id UUID REFERENCES payment_workflows(id)");
 await db!.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS workflow_step_id UUID REFERENCES payment_workflow_steps(id)");
}
function requireOwner(req:IncomingMessage){const expected=String(process.env.TELEGRAM_OWNER_ID||"");const supplied=String(req.headers["x-transactra-owner-id"]||"");return Boolean(expected&&supplied&&expected===supplied);}
function requireBotOwner(req:IncomingMessage){
 const expected=process.env.BACKEND_SHARED_SECRET||"",supplied=String(req.headers["x-transactra-edge-secret"]||"");
 const owner=String(process.env.TELEGRAM_OWNER_ID||""),user=String(req.headers["x-transactra-owner-id"]||"");
 const a=Buffer.from(expected),b=Buffer.from(supplied);
 return Boolean(owner&&/^\\d{1,20}$/.test(owner)&&user===owner&&expected&&supplied&&a.length===b.length&&timingSafeEqual(a,b));
}
function telegramUserId(req:IncomingMessage){return String(req.headers["x-transactra-owner-id"]||"");}
async function notifyTelegramUser(userId:string,message:string){
 const botToken=process.env.TELEGRAM_BOT_TOKEN;
 if(!botToken||!/^\\d{1,20}$/.test(userId))return;
 try{
  const response=await fetch("https://api.telegram.org/bot"+botToken+"/sendMessage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:userId,text:message}),signal:AbortSignal.timeout(10000)});
  if(!response.ok)console.error("Telegram OAuth notification failed:",response.status);
 }catch(error){console.error("Telegram OAuth notification failed:",error instanceof Error?error.message:"unknown error");}
}
function splitPaymentInstructions(text:string){return text.split(/\s*(?:;|\n+|\bthen\b)\s*/i).map(x=>x.trim()).filter(Boolean);}
async function createWorkflowOrder(workflowId:string){
 const q=await db!.query("SELECT id,sequence_no,recipient,purpose,amount::text,currency FROM payment_workflow_steps WHERE workflow_id=$1 AND status='READY' ORDER BY sequence_no LIMIT 1",[workflowId]);
 if(!q.rowCount){const state=await db!.query("SELECT status FROM payment_workflows WHERE id=$1",[workflowId]);return {complete:state.rows[0]?.status==="COMPLETED",pending:state.rows[0]?.status==="IN_PROGRESS"};}
 const p=q.rows[0] as {id:string;sequence_no:number;recipient:string;purpose:string;amount:string;currency:string};
 const claim=await db!.query("UPDATE payment_workflow_steps SET status='CREATING',updated_at=NOW() WHERE id=$1 AND status='READY' RETURNING id",[p.id]);
 if(!claim.rowCount)return {pending:true};
 const txId=randomUUID();
 await db!.query("INSERT INTO payment_transactions(id,raw_prompt,recipient,purpose,amount,currency,status,workflow_id,workflow_step_id) VALUES($1,$2,$3,$4,$5,$6,'CREATING',$7,$8)",[txId,"Approved workflow "+workflowId,p.recipient,p.purpose,p.amount,p.currency,workflowId,p.id]);
 try{
  const access=await token();
  const order=await paypal("/v2/checkout/orders",access,"POST",{intent:"CAPTURE",purchase_units:[{reference_id:txId,description:p.purpose.slice(0,127),amount:{currency_code:p.currency,value:p.amount}}],application_context:{brand_name:"Transactra",user_action:"PAY_NOW",shipping_preference:"NO_SHIPPING"}},txId) as {id?:string;links?:Array<{rel?:string;href?:string}>};
  const approveUrl=order.links?.find(x=>x.rel==="approve"||x.rel==="payer-action")?.href;
  if(!order.id||!approveUrl)throw Error("PayPal did not return an order approval link.");
  await db!.query("UPDATE payment_transactions SET paypal_order_id=$1,status='CREATED',updated_at=NOW() WHERE id=$2",[order.id,txId]);
  await db!.query("UPDATE payment_workflow_steps SET status='AWAITING_BUYER_APPROVAL',paypal_order_id=$1,approve_url=$2,updated_at=NOW() WHERE id=$3",[order.id,approveUrl,p.id]);
  await db!.query("UPDATE payment_workflows SET status='IN_PROGRESS',updated_at=NOW() WHERE id=$1",[workflowId]);
  const total=await db!.query("SELECT step_count FROM payment_workflows WHERE id=$1",[workflowId]);
  return {workflowId,step:p.sequence_no,totalSteps:Number(total.rows[0].step_count),orderId:order.id,approveUrl,recipient:p.recipient,amount:p.amount,currency:p.currency,purpose:p.purpose};
 }catch(e){
  await db!.query("UPDATE payment_workflow_steps SET status='FAILED',updated_at=NOW() WHERE id=$1",[p.id]);
  await db!.query("UPDATE payment_transactions SET status='FAILED',updated_at=NOW() WHERE id=$1",[txId]);
  await db!.query("UPDATE payment_workflows SET status='FAILED',updated_at=NOW() WHERE id=$1",[workflowId]);
  throw e;
 }
}

async function route(req:IncomingMessage,res:ServerResponse){
 const url=new URL(req.url||"/","http://"+(req.headers.host||"localhost"));
 try{
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

  // --- Telegram-bound PayPal OAuth 2.0 Account Connection ---
  if(req.method==="GET"&&url.pathname==="/api/auth/paypal/connect"){
   if(!requireBotOwner(req))return send(res,401,{error:"Authenticated Telegram owner session required."});
   if(!db)return send(res,503,{error:"Database is required for persistent OAuth connection."});
   if(!process.env.TOKEN_ENCRYPTION_SECRET||Buffer.byteLength(process.env.TOKEN_ENCRYPTION_SECRET,"utf8")<32)return send(res,503,{error:"TOKEN_ENCRYPTION_SECRET must be configured with at least 32 bytes."});
   await ensurePayPalConnectionSchema(db);
   const {authorizeUrl}=await createOAuthState(db,telegramUserId(req),req.headers.host);
   return send(res,200,{authorizeUrl,provider:"PayPal",environment:process.env.PAYPAL_ENV||"sandbox"});
  }

  if(req.method==="GET"&&url.pathname==="/api/auth/paypal/callback"){
   if(!db)return send(res,503,{error:"Database is required for OAuth callback."});
   await ensurePayPalConnectionSchema(db);
   const config=getPayPalConfig(req.headers.host);
   const code=url.searchParams.get("code"),state=url.searchParams.get("state");
   const err=url.searchParams.get("error"),errDesc=url.searchParams.get("error_description");
   if(!state||state.length>256){
    res.writeHead(302,{Location:config.frontendUrl+"/?paypal_connection=error&reason=missing_or_invalid_state","Cache-Control":"no-store","Referrer-Policy":"no-referrer"});return res.end();
   }
   const validation=await validateAndConsumeState(db,state);
   if(!validation.valid||!validation.userId){
    res.writeHead(302,{Location:config.frontendUrl+"/?paypal_connection=error&reason=invalid_state","Cache-Control":"no-store","Referrer-Policy":"no-referrer"});return res.end();
   }
   const userId=validation.userId;
   if(err||!code){
    await notifyTelegramUser(userId,"PayPal connection was not completed. No account was linked. Send “connect paypal” whenever you are ready to try again.");
    res.writeHead(302,{Location:config.frontendUrl+"/?paypal_connection=cancelled","Cache-Control":"no-store","Referrer-Policy":"no-referrer"});return res.end();
   }
   try{
    const tokenRes=await exchangeAuthorizationCode(code,req.headers.host);
    const userInfo=await fetchPayPalUserInfo(tokenRes.access_token,req.headers.host);
    await saveConnectedAccount(db,userId,{
     payerId:userInfo.payerId,email:userInfo.email,name:userInfo.name,verifiedAccount:userInfo.verifiedAccount,
     accessToken:tokenRes.access_token,refreshToken:tokenRes.refresh_token,expiresIn:tokenRes.expires_in,scope:tokenRes.scope
    });
    await notifyTelegramUser(userId,"✅ PayPal connected successfully.\n\nAccount: "+(userInfo.email||userInfo.name||"PayPal account")+
      "\nEnvironment: "+(process.env.PAYPAL_ENV||"sandbox")+"\n\nYour connection is stored against your Telegram account.");
    res.writeHead(302,{Location:config.frontendUrl+"/?paypal_connection=success","Cache-Control":"no-store","Referrer-Policy":"no-referrer"});return res.end();
   }catch(e){
    console.error("PayPal OAuth callback error:",e instanceof Error?e.message:"unknown error");
    await notifyTelegramUser(userId,"PayPal could not be connected. Please try again later. No successful connection was recorded.");
    res.writeHead(302,{Location:config.frontendUrl+"/?paypal_connection=error","Cache-Control":"no-store","Referrer-Policy":"no-referrer"});return res.end();
   }
  }

  if(req.method==="GET"&&url.pathname==="/api/auth/paypal/status"){
   if(!requireBotOwner(req))return send(res,401,{error:"Authenticated Telegram owner session required."});
   if(!db)return send(res,200,{connected:false,account:null,dbConnected:false});
   await ensurePayPalConnectionSchema(db);
   return send(res,200,await getConnectedAccountStatus(db,telegramUserId(req)));
  }

  if(req.method==="POST"&&url.pathname==="/api/auth/paypal/disconnect"){
   if(!requireBotOwner(req))return send(res,401,{error:"Authenticated Telegram owner session required."});
   if(!db)return send(res,503,{error:"Database is required to disconnect account."});
   await ensurePayPalConnectionSchema(db);
   const disconnected=await disconnectPayPalAccount(db,telegramUserId(req));
   return send(res,200,{success:disconnected,message:disconnected?"PayPal account disconnected.":"No active PayPal connection found."});
  }
  if(req.method==="POST"&&url.pathname==="/api/parse"){const b=await read(req);return send(res,200,{intent:await parse(String(b.text||""))});}
  if(req.method==="POST"&&url.pathname==="/api/workflows/plan"){
   if(!requireOwner(req))return send(res,401,{error:"Owner authentication required."});
   await ensureWorkflowSchema();const b=await read(req),raw=String(b.text||"").trim();
   if(!raw||raw.length>4000)return send(res,400,{error:"Provide a workflow instruction under 4,000 characters."});
   const parts=splitPaymentInstructions(raw);
   if(parts.length<2||parts.length>8)return send(res,400,{error:"Use 2–8 payment instructions separated by semicolons, new lines, or 'then'."});
   const intents=[];for(const part of parts)intents.push(await parse(part));
   const workflowId=randomUUID();await db!.query("INSERT INTO payment_workflows(id,raw_prompt,status,step_count) VALUES($1,$2,'PENDING_APPROVAL',$3)",[workflowId,raw,parts.length]);
   for(let i=0;i<intents.length;i++){const p=intents[i]!;await db!.query("INSERT INTO payment_workflow_steps(id,workflow_id,sequence_no,recipient,purpose,amount,currency,status) VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING')",[randomUUID(),workflowId,i+1,p.recipient,p.purpose,p.amount,p.currency]);}
   return send(res,201,{workflowId,status:"PENDING_APPROVAL",steps:intents.map((p,i)=>({sequence:i+1,...p})),totalAmountByCurrency:intents.reduce((a,p)=>{a[p.currency]=(a[p.currency]||0)+Number(p.amount);return a;},{} as Record<string,number>)});
  }
  const wm=url.pathname.match(/^\/api\/workflows\/([0-9a-f-]+)(?:\/(approve|reject|next))?$/i);
  if(wm){
   if(!requireOwner(req))return send(res,401,{error:"Owner authentication required."});
   await ensureWorkflowSchema();const id=wm[1]!,action=wm[2]||"",w=await db!.query("SELECT id,status,step_count FROM payment_workflows WHERE id=$1",[id]);
   if(!w.rowCount)return send(res,404,{error:"Payment workflow not found."});
   if(req.method==="GET"&&!action){const steps=await db!.query("SELECT sequence_no,recipient,purpose,amount::text,currency,status,paypal_order_id FROM payment_workflow_steps WHERE workflow_id=$1 ORDER BY sequence_no",[id]);return send(res,200,{workflow:w.rows[0],steps:steps.rows});}
   if(req.method==="POST"&&action==="reject"){if(w.rows[0].status!=="PENDING_APPROVAL")return send(res,409,{error:"Only a pending workflow can be rejected."});await db!.query("UPDATE payment_workflows SET status='REJECTED',updated_at=NOW() WHERE id=$1",[id]);await db!.query("UPDATE payment_workflow_steps SET status='REJECTED',updated_at=NOW() WHERE workflow_id=$1 AND status='PENDING'",[id]);return send(res,200,{status:"REJECTED"});}
   if(req.method==="POST"&&action==="approve"){const ok=await db!.query("UPDATE payment_workflows SET status='APPROVED',updated_at=NOW() WHERE id=$1 AND status='PENDING_APPROVAL' RETURNING id",[id]);if(!ok.rowCount)return send(res,409,{error:"Workflow is not awaiting approval or was already approved."});await db!.query("UPDATE payment_workflow_steps SET status='READY',updated_at=NOW() WHERE workflow_id=$1 AND sequence_no=1 AND status='PENDING'",[id]);return send(res,200,await createWorkflowOrder(id));}
   if(req.method==="POST"&&action==="next"){if(!["APPROVED","IN_PROGRESS"].includes(String(w.rows[0].status)))return send(res,409,{error:"Workflow is not approved for execution."});return send(res,200,await createWorkflowOrder(id));}
   return send(res,405,{error:"Method not allowed."});
  }

  if(req.method==="GET"&&url.pathname==="/api/transactions"){await ensureDb();const q=await db!.query("SELECT id,recipient,purpose,amount::text,currency,status,paypal_order_id,created_at FROM payment_transactions ORDER BY created_at DESC LIMIT 50");return send(res,200,{transactions:q.rows});}
  if(req.method==="POST"&&url.pathname==="/api/orders"){
   await ensureDb();const b=await read(req),amount=Number(b.amount),currency=String(b.currency||"USD").toUpperCase(),recipient=String(b.recipient||"").trim(),purpose=String(b.purpose||"Payment").trim();
   if(!Number.isFinite(amount)||amount<=0||amount>1000000||!currencies.has(currency)||!recipient||recipient.length>80)return send(res,400,{error:"Invalid payment details. Review amount, currency and recipient."});
   const id=randomUUID();await db!.query("INSERT INTO payment_transactions(id,raw_prompt,recipient,purpose,amount,currency,status) VALUES($1,$2,$3,$4,$5,$6,'CREATING')",[id,String(b.rawPrompt||"").slice(0,1000),recipient,purpose.slice(0,120),amount.toFixed(2),currency]);
   try{const t=await token();const o=await paypal("/v2/checkout/orders",t,"POST",{intent:"CAPTURE",purchase_units:[{reference_id:id,description:purpose.slice(0,127),amount:{currency_code:currency,value:amount.toFixed(2)}}],application_context:{brand_name:"Transactra",user_action:"PAY_NOW",shipping_preference:"NO_SHIPPING"}},id) as {id?:string;status?:string;links?:Array<{rel?:string;href?:string}>};if(!o.id)throw Error("PayPal did not return an order ID.");await db!.query("UPDATE payment_transactions SET paypal_order_id=$1,status='CREATED',updated_at=NOW() WHERE id=$2",[o.id,id]);return send(res,200,{orderId:o.id,status:o.status||"CREATED",approveUrl:o.links?.find(x=>x.rel==="approve"||x.rel==="payer-action")?.href});}catch(e){await db!.query("UPDATE payment_transactions SET status='FAILED',updated_at=NOW() WHERE id=$1",[id]);throw e;}
  }
  const m=url.pathname.match(/^\/api\/orders\/([A-Z0-9]+)\/capture$/i);
  if(req.method==="POST"&&m){await ensureDb();const id=m[1]!;const old=await db!.query("SELECT status,workflow_id,workflow_step_id FROM payment_transactions WHERE paypal_order_id=$1",[id]);if(!old.rowCount)return send(res,404,{error:"PayPal order is not associated with Transactra."});if(old.rows[0].status==="COMPLETED")return send(res,200,{status:"COMPLETED",alreadyCaptured:true,workflowId:old.rows[0].workflow_id||undefined});const t=await token();const d=await paypal("/v2/checkout/orders/"+encodeURIComponent(id)+"/capture",t,"POST",{},id+"-capture") as {status?:string;purchase_units?:Array<{payments?:{captures?:Array<{id?:string}>}} >};const status=String(d.status||"UNKNOWN"),captureId=d.purchase_units?.[0]?.payments?.captures?.[0]?.id||null;await db!.query("UPDATE payment_transactions SET status=$1,paypal_capture_id=$2,updated_at=NOW() WHERE paypal_order_id=$3",[status,captureId,id]);let workflowId:string|undefined,workflowComplete:boolean|undefined;if(old.rows[0].workflow_id&&old.rows[0].workflow_step_id){workflowId=String(old.rows[0].workflow_id);await db!.query("UPDATE payment_workflow_steps SET status=$1,updated_at=NOW() WHERE id=$2",[status==="COMPLETED"?"COMPLETED":"PAYMENT_"+status,old.rows[0].workflow_step_id]);if(status==="COMPLETED"){const remaining=await db!.query("SELECT id FROM payment_workflow_steps WHERE workflow_id=$1 AND status NOT IN ('COMPLETED','REJECTED') ORDER BY sequence_no LIMIT 1",[workflowId]);if(remaining.rowCount){await db!.query("UPDATE payment_workflow_steps SET status='READY',updated_at=NOW() WHERE id=$1 AND status='PENDING'",[remaining.rows[0].id]);}else{await db!.query("UPDATE payment_workflows SET status='COMPLETED',updated_at=NOW() WHERE id=$1",[workflowId]);workflowComplete=true;}}}return send(res,200,{status,captureId,workflowId,workflowComplete});}
  return send(res,404,{error:"Route not found."});
 }catch(e){return send(res,500,{error:e instanceof Error?e.message:"Unexpected server error"});}
}
const server=createServer((req,res)=>{void route(req,res);});server.listen(port,host,()=>console.log("Transactra API listening at http://"+host+":"+port));
process.on("SIGINT",async()=>{await db?.end();server.close();});process.on("SIGTERM",async()=>{await db?.end();server.close();});