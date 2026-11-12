import { randomUUID } from "node:crypto";

const token = process.env.TELEGRAM_BOT_TOKEN || "";
const ownerId = process.env.TELEGRAM_OWNER_ID || "";
const backendSharedSecret = process.env.BACKEND_SHARED_SECRET || "";
const apiBase = (process.env.API_BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const telegramBase = "https://api.telegram.org/bot" + token;
type Intent = { amount:string; currency:string; recipient:string; purpose:string; confidence:number; source:string };
type Pending = { intent:Intent; rawPrompt:string; approvalId:string; orderId?:string };
const pending = new Map<string, Pending>();
let offset = 0;

async function tg<T=unknown>(method:string, body:Record<string,unknown> = {}):Promise<T> {
  const response = await fetch(telegramBase + "/" + method, {
    method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body),
    signal:AbortSignal.timeout(method==="getUpdates" ? 35000 : 15000)
  });
  const result = await response.json() as {ok:boolean;result:T;description?:string};
  if (!response.ok || !result.ok) throw new Error(result.description || "Telegram API request failed");
  return result.result;
}
async function api<T=Record<string,unknown>>(path:string, method="GET", body?:unknown):Promise<T> {
  const response = await fetch(apiBase + path, {
    method, headers:{"Content-Type":"application/json","x-transactra-owner-id":ownerId,"x-transactra-edge-secret":backendSharedSecret},
    ...(body===undefined?{}:{body:JSON.stringify(body)}), signal:AbortSignal.timeout(130000)
  });
  const data = await response.json() as T & {error?:string};
  if (!response.ok) throw new Error(data.error || "Transactra API request failed");
  return data;
}
async function say(chatId:number|string, text:string, replyMarkup?:unknown) {
  return tg("sendMessage", {chat_id:chatId,text, ...(replyMarkup?{reply_markup:replyMarkup}:{})});
}
function keyboard(rows:Array<Array<Record<string,string>>>) { return {inline_keyboard:rows}; }
function money(amount:string,currency:string) {
  try { return new Intl.NumberFormat("en-US",{style:"currency",currency}).format(Number(amount)); }
  catch { return amount+" "+currency; }
}
function owner(update:any) {
  const from = update.message?.from || update.callback_query?.from;
  const chat = update.message?.chat || update.callback_query?.message?.chat;
  return from && chat && chat.type==="private" && String(from.id)===ownerId && String(chat.id)===ownerId;
}
async function handleMessage(message:any) {
  const chatId=message.chat.id, text=String(message.text||"").trim();
  if (!text) return;
  if (text==="/start" || text.startsWith("/start ")) {
    await say(chatId,"Welcome to Transactra. Your Telegram payment desk is ready.\n\nSend one payment or a multi-step plan separated by semicolons, new lines, or ΓÇ£thenΓÇ¥. Send ΓÇ£connect paypalΓÇ¥ to link your account. Use /history, /summary and /help. Every plan requires owner approval, and each PayPal checkout requires buyer approval.");
    return;
  }
  if ((text.toLowerCase()==="connect paypal" || text.toLowerCase()==="connect to paypal") || text==="/connect" || text==="/paypal") {
    try {
      const result=await api<{authorizeUrl:string;environment:string}>("/api/auth/paypal/connect");
      await say(chatId,"CONNECT PAYPAL ┬╖ "+result.environment.toUpperCase()+"\n\nOpen PayPalΓÇÖs official authorization page, sign in with your PayPal email or mobile number, and approve the requested access. Transactra never asks for your PayPal password or one-time code in Telegram.",keyboard([[{text:"Authorize PayPal",url:result.authorizeUrl}]]));
    } catch(e) { await say(chatId,e instanceof Error?e.message:"Could not start PayPal authorization. Check the server configuration."); }
    return;
  }
  if (text==="/ai" || text.startsWith("/ai ")) {
    const prompt=text.slice(3).trim();
    if(!prompt)return void await say(chatId,"Use /ai followed by a message. Example: /ai Explain how Transactra protects a PayPal payment.");
    try {
      const result=await api<{reply:string;model:string}>("/api/ai/chat","POST",{text:prompt});
      await say(chatId,"CLOUDPILOT AI ┬╖ "+result.model+"\n\n"+result.reply);
    } catch(e) {
      await say(chatId,e instanceof Error?e.message:"CloudPilot is unavailable. Check the inference endpoint and secret configuration.");
    }
    return;
  }
  if (text==="/help") {
    await say(chatId,"TRANSACTRA - TELEGRAM COMMANDS\n\nSend one payment, or a 2ΓÇô8 step plan separated by semicolons, new lines, or ΓÇ£thenΓÇ¥. Example: Pay $25 to Alex for dinner; then pay $60 to Sam for hosting.\n/ai <message> - chat with CloudPilot AI\n/connect - securely connect your PayPal account\n/history - recent transactions\n/summary - captured payment totals\n/cancel - clear unsubmitted drafts\n/help - this message\n\nReview each draft, approve it, complete PayPal Sandbox checkout, then return here to capture. Never send PayPal credentials in Telegram.");
    return;
  }
  if (text==="/cancel") {
    for (const [id,draft] of pending) { if (!draft.orderId) pending.delete(id); }
    await say(chatId,"Unsubmitted payment drafts cleared. Any existing PayPal orders remain uncaptured; use the PayPal checkout page to cancel them.");
    return;
  }
  if (text==="/history") {
    try {
      const data=await api<{transactions:Array<{recipient:string;purpose:string;amount:string;currency:string;status:string;created_at:string}>}>("/api/transactions");
      if (!data.transactions.length) return void await say(chatId,"No transactions yet.");
      const lines=data.transactions.slice(0,10).map((x,i)=>(i+1)+". "+x.recipient+" ├é┬╖ "+money(x.amount,x.currency)+"\n   "+x.purpose+" ├é┬╖ "+x.status+" ├é┬╖ "+new Date(x.created_at).toLocaleDateString());
      await say(chatId,"RECENT TRANSACTIONS\n\n"+lines.join("\n\n"));
    } catch(e) { await say(chatId,e instanceof Error?e.message:"Could not load transaction history."); }
    return;
  }
  if (text==="/summary") {
    try {
      const data=await api<{transactions:Array<{amount:string;currency:string;status:string}>}>("/api/transactions");
      const completed=data.transactions.filter(x=>x.status==="COMPLETED");
      const totals=new Map<string,number>();
      for(const x of completed) totals.set(x.currency,(totals.get(x.currency)||0)+Number(x.amount));
      const amount=totals.size?[...totals].map(([c,v])=>money(v.toFixed(2),c)).join("\n"):"No captured payments yet.";
      await say(chatId,"PAYMENT SUMMARY\n\nCaptured transactions: "+completed.length+"\n"+amount+"\n\nOnly PayPal-confirmed captures are included.");
    } catch(e) { await say(chatId,e instanceof Error?e.message:"Could not load payment summary."); }
    return;
  }
  if (text.startsWith("/")) { await say(chatId,"Unknown command. Send /help to see what I can do."); return; }
  if (/[;\n]|\bthen\b/i.test(text)) {
    try {
      const plan=await api<{workflowId:string;steps:Array<{sequence:number;amount:string;currency:string;recipient:string;purpose:string;source:string}>;totalAmountByCurrency:Record<string,number>}>("/api/workflows/plan","POST",{text});
      const lines=plan.steps.map(s=>s.sequence+". "+money(s.amount,s.currency)+" ΓåÆ "+s.recipient+" ("+s.purpose+")");
      const totals=Object.entries(plan.totalAmountByCurrency).map(([c,v])=>money(v.toFixed(2),c)).join(", ");
      await say(chatId,"AGENT PAYMENT PLAN ┬╖ "+plan.steps.length+" STEPS\n\n"+lines.join("\n")+"\n\nTotal planned: "+totals+"\n\nAll steps are stored as a draft. Approving authorizes Transactra to create the first PayPal order; each checkout still requires your PayPal buyer approval before capture.",keyboard([[{text:"Approve entire plan",callback_data:"workflowapprove:"+plan.workflowId},{text:"Reject plan",callback_data:"workflowreject:"+plan.workflowId}]]));
    } catch(e) { await say(chatId,e instanceof Error?e.message:"Could not prepare this payment workflow."); }
    return;
  }
  try {
    const data=await api<{approvalId:string;intent:Intent;risk:string;expiresInSeconds:number}>("/api/payments/prepare","POST",{text});
    const id=randomUUID().slice(0,12);
    pending.set(id,{intent:data.intent,rawPrompt:text,approvalId:data.approvalId});
    const p=data.intent;
    await say(chatId,
      "PAYMENT DRAFT ├é┬╖ REVIEW REQUIRED\n\nAmount: "+money(p.amount,p.currency)+"\nRecipient label: "+p.recipient+"\nPurpose: "+p.purpose+"\nCurrency: "+p.currency+"\n\nAI extraction: "+(p.source==="model"?"AI model":"local parser")+"\nFinancial Policy: "+data.risk.toUpperCase()+" RISK · explicit approval required · expires in "+Math.floor(data.expiresInSeconds/60)+" min\n\nThis recipient is a transaction label. PayPal Checkout charges the merchant connected to the configured PayPal app. No money moves until you approve and complete PayPal checkout.",
      keyboard([[{text:"Approve & continue",callback_data:"approve:"+id},{text:"Discard",callback_data:"discard:"+id}]]));
  } catch(e) { await say(chatId,e instanceof Error?e.message:"I couldn't understand that payment. Try ├óΓé¼┼ôPay $25 to Alex for dinner├óΓé¼┬¥."); }
}
async function handleCallback(query:any) {
  const chatId=query.message?.chat?.id, data=String(query.data||"");
  await tg("answerCallbackQuery",{callback_query_id:query.id});
  const [action,id]=data.split(":");
  if (!chatId || !id) return;
  if (action==="workflowreject") {
    try { await api("/api/workflows/"+id+"/reject","POST",{}); await say(chatId,"Payment plan rejected. No PayPal orders were created."); }
    catch(e) { await say(chatId,e instanceof Error?e.message:"Could not reject the payment plan."); }
    return;
  }
  if (action==="workflowapprove") {
    try {
      const result=await api<{workflowId:string;step:number;totalSteps:number;orderId:string;approveUrl:string;amount:string;currency:string;recipient:string;purpose:string}>("/api/workflows/"+id+"/approve","POST",{});
      await say(chatId,"PLAN APPROVED ┬╖ STEP "+result.step+"/"+result.totalSteps+"\n\n"+money(result.amount,result.currency)+" ┬╖ "+result.recipient+"\n"+result.purpose+"\n\nOpen PayPal, complete buyer approval, then return here to capture this step. Later steps remain queued until this capture is verified.",keyboard([[{text:"Open PayPal checkout",url:result.approveUrl}],[{text:"I've completed PayPal approval",callback_data:"capture:"+result.orderId}]]));
    } catch(e) { await say(chatId,e instanceof Error?e.message:"Could not approve the payment plan."); }
    return;
  }
  if (action==="capture") {
    try {
      const result=await api<{status:string;captureId?:string;workflowId?:string;workflowComplete?:boolean}>("/api/orders/"+encodeURIComponent(id)+"/capture","POST",{});
      if (result.status==="COMPLETED") {
        const history=await api<{transactions:Array<{recipient:string;purpose:string;amount:string;currency:string;status:string;paypal_order_id:string}>}>("/api/transactions");
        const tx=history.transactions.find(x=>x.paypal_order_id===id);
        await say(chatId,"PAYMENT CAPTURED [OK]\n\n"+(tx?"Amount: "+money(tx.amount,tx.currency)+"\nRecipient label: "+tx.recipient+"\nPurpose: "+tx.purpose+"\n":"")+"PayPal order: "+id+"\nPayPal capture: "+(result.captureId||"confirmed")+"\n\nThis status came from PayPal's capture response.");
        if(result.workflowId){
          if(result.workflowComplete)await say(chatId,"AGENT WORKFLOW COMPLETE\n\nAll approved payment steps have been captured and verified by PayPal.");
          else{
            const next=await api<{step?:number;totalSteps?:number;orderId?:string;approveUrl?:string;amount?:string;currency?:string;recipient?:string;purpose?:string;complete?:boolean}>("/api/workflows/"+result.workflowId+"/next","POST",{});
            if(next.approveUrl&&next.orderId)await say(chatId,"NEXT APPROVED STEP ┬╖ "+next.step+"/"+next.totalSteps+"\n\n"+money(String(next.amount),String(next.currency))+" ┬╖ "+next.recipient+"\n"+next.purpose+"\n\nOpen PayPal to approve this payment. No capture has happened yet.",keyboard([[{text:"Open PayPal checkout",url:next.approveUrl}],[{text:"I've completed PayPal approval",callback_data:"capture:"+next.orderId}]]));
            else if(next.complete)await say(chatId,"AGENT WORKFLOW COMPLETE\n\nAll approved payment steps have been processed.");
          }
        }
      } else {
        await say(chatId,"PayPal returned status: "+result.status+". The payment is not marked completed. If you have just approved checkout, wait a moment and try again.");
      }
    } catch(e) { await say(chatId,e instanceof Error?e.message:"PayPal capture failed. Check the checkout approval and try again."); }
    return;
  }
  const draft=pending.get(id);
  if (!draft) return void await say(chatId,"This payment draft has expired. Send the request again.");
  if (action==="discard") { pending.delete(id); return void await say(chatId,"Payment draft discarded. No PayPal order was created."); }
  if (action==="approve") {
    try {
      const result=await api<{orderId:string;status:string;approveUrl?:string}>("/api/orders","POST",{approvalId:draft.approvalId});
      if (!result.approveUrl) throw new Error("PayPal did not return an approval link.");
      pending.delete(id);
      await say(chatId,
        "PAYPAL ORDER CREATED - "+result.orderId+"\n\nOpen PayPal checkout and sign in with your Sandbox personal test account. Complete buyer approval, then return to this chat and tap the capture button.\n\nNo capture has happened yet.",
        keyboard([[{text:"Open PayPal checkout",url:result.approveUrl}],[{text:"I've completed PayPal approval",callback_data:"capture:"+result.orderId}]]));
    } catch(e) { await say(chatId,e instanceof Error?e.message:"Could not create the PayPal order."); }
  }
}
export async function processTelegramUpdate(update:any) {
  if (!owner(update)) return;
  if (update.message) await handleMessage(update.message);
  else if (update.callback_query) await handleCallback(update.callback_query);
}

async function main() {
  if (!token || !ownerId || backendSharedSecret.length < 32) throw new Error("Set TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_ID and BACKEND_SHARED_SECRET (at least 32 characters) in .env before starting the Transactra Telegram bot.");
  if (process.env.TELEGRAM_CLEAR_WEBHOOK==="true") await tg("deleteWebhook",{drop_pending_updates:false});
  const webhook=await tg<{url?:string}>("getWebhookInfo");
  if (webhook.url) throw new Error("A Telegram webhook is already configured. Set TELEGRAM_CLEAR_WEBHOOK=true once to switch this bot to polling, then restart it.");
  await tg("setMyCommands",{commands:[
    {command:"start",description:"Open your Transactra payment desk"},
    {command:"ai",description:"Chat with CloudPilot AI"},
    {command:"history",description:"Show recent transactions"},
    {command:"summary",description:"Show captured payment totals"},
    {command:"cancel",description:"Discard pending payment drafts"},
    {command:"help",description:"Show available commands"}
  ]});
  const me=await tg<{username:string}>("getMe");
  console.log("Transactra Telegram bot @"+me.username+" is polling. Owner ID allowlist is enabled.");
  while(true) {
    try {
      const updates=await tg<any[]>("getUpdates",{offset,timeout:25,allowed_updates:["message","callback_query"]});
      for(const update of updates) {
        offset=update.update_id+1;
        await processTelegramUpdate(update);
      }
    } catch(e) {
      console.error("Telegram polling error:",e instanceof Error?e.message:"unknown error");
      await new Promise(resolve=>setTimeout(resolve,2500));
    }
  }
}
if (process.argv[1] && /(?:^|[\\/])bot\.(?:ts|js|mjs)$/.test(process.argv[1])) {
  void main().catch(e=>{console.error(e);process.exit(1);});
}
