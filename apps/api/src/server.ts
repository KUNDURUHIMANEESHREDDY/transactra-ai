import {createServer,type IncomingMessage,type ServerResponse} from "node:http";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
const port=Number(process.env.PORT||8787),host=process.env.HOST||"127.0.0.1";
const clientId=process.env.PAYPAL_CLIENT_ID||"",secret=process.env.PAYPAL_CLIENT_SECRET||"";
const paypalBase=process.env.PAYPAL_ENV==="live"?"https://api-m.paypal.com":"https://api-m.sandbox.paypal.com";
const db=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL}):null;
const currencies=new Set(["USD","EUR","GBP","INR","CAD","AUD","SGD","JPY"]);
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
async function route(req:IncomingMessage,res:ServerResponse){
 const url=new URL(req.url||"/","http://"+(req.headers.host||"localhost"));
 try{
  if(req.method==="GET"&&url.pathname==="/api/health")return send(res,200,{status:"ok",database:Boolean(db),paypalConfigured:Boolean(clientId&&secret)});
  if(req.method==="GET"&&url.pathname==="/api/config")return send(res,200,{paypalClientId:clientId,paypalConfigured:Boolean(clientId&&secret),environment:process.env.PAYPAL_ENV||"sandbox"});
  if(req.method==="POST"&&url.pathname==="/api/parse"){const b=await read(req);return send(res,200,{intent:await parse(String(b.text||""))});}
  if(req.method==="GET"&&url.pathname==="/api/transactions"){await ensureDb();const q=await db!.query("SELECT id,recipient,purpose,amount::text,currency,status,paypal_order_id,created_at FROM payment_transactions ORDER BY created_at DESC LIMIT 50");return send(res,200,{transactions:q.rows});}
  if(req.method==="POST"&&url.pathname==="/api/orders"){
   await ensureDb();const b=await read(req),amount=Number(b.amount),currency=String(b.currency||"USD").toUpperCase(),recipient=String(b.recipient||"").trim(),purpose=String(b.purpose||"Payment").trim();
   if(!Number.isFinite(amount)||amount<=0||amount>1000000||!currencies.has(currency)||!recipient||recipient.length>80)return send(res,400,{error:"Invalid payment details. Review amount, currency and recipient."});
   const id=randomUUID();await db!.query("INSERT INTO payment_transactions(id,raw_prompt,recipient,purpose,amount,currency,status) VALUES($1,$2,$3,$4,$5,$6,'CREATING')",[id,String(b.rawPrompt||"").slice(0,1000),recipient,purpose.slice(0,120),amount.toFixed(2),currency]);
   try{const t=await token();const o=await paypal("/v2/checkout/orders",t,"POST",{intent:"CAPTURE",purchase_units:[{reference_id:id,description:purpose.slice(0,127),amount:{currency_code:currency,value:amount.toFixed(2)}}],application_context:{brand_name:"Transactra",user_action:"PAY_NOW",shipping_preference:"NO_SHIPPING"}},id) as {id?:string;status?:string};if(!o.id)throw Error("PayPal did not return an order ID.");await db!.query("UPDATE payment_transactions SET paypal_order_id=$1,status='CREATED',updated_at=NOW() WHERE id=$2",[o.id,id]);return send(res,200,{orderId:o.id,status:o.status||"CREATED"});}catch(e){await db!.query("UPDATE payment_transactions SET status='FAILED',updated_at=NOW() WHERE id=$1",[id]);throw e;}
  }
  const m=url.pathname.match(/^\/api\/orders\/([A-Z0-9]+)\/capture$/i);
  if(req.method==="POST"&&m){await ensureDb();const id=m[1]!;const old=await db!.query("SELECT status FROM payment_transactions WHERE paypal_order_id=$1",[id]);if(!old.rowCount)return send(res,404,{error:"PayPal order is not associated with Transactra."});if(old.rows[0].status==="COMPLETED")return send(res,200,{status:"COMPLETED",alreadyCaptured:true});const t=await token();const d=await paypal("/v2/checkout/orders/"+encodeURIComponent(id)+"/capture",t,"POST",{},id+"-capture") as {status?:string;purchase_units?:Array<{payments?:{captures?:Array<{id?:string}>}} >};const status=String(d.status||"UNKNOWN"),captureId=d.purchase_units?.[0]?.payments?.captures?.[0]?.id||null;await db!.query("UPDATE payment_transactions SET status=$1,paypal_capture_id=$2,updated_at=NOW() WHERE paypal_order_id=$3",[status,captureId,id]);return send(res,200,{status,captureId});}
  return send(res,404,{error:"Route not found."});
 }catch(e){return send(res,500,{error:e instanceof Error?e.message:"Unexpected server error"});}
}
const server=createServer((req,res)=>{void route(req,res);});server.listen(port,host,()=>console.log("Transactra API listening at http://"+host+":"+port));
process.on("SIGINT",async()=>{await db?.end();server.close();});process.on("SIGTERM",async()=>{await db?.end();server.close();});