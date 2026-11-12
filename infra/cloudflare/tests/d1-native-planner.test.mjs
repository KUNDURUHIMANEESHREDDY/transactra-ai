import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.mjs";

const OWNER="123456",BOT="test-bot",SECRET="test-secret";
function nativeDb(){
 const statements=[];
 const db={
  prepare(sql){
   const entry={sql,values:[]};
   const statement={entry,
    bind(...values){entry.values=values;return statement;},
    async run(){statements.push(entry);return {success:true,meta:{changes:1}};},
    async all(){
     statements.push(entry);
     if(sql.includes("SELECT id,memory_key,memory_value FROM agent_memory"))return {results:[]};
     if(sql.includes("SELECT update_id FROM telegram_reply_outbox")||sql.includes("UPDATE telegram_reply_outbox SET lease_token=")){
      const insert=statements.findLast(x=>x.sql.includes("INSERT OR IGNORE INTO telegram_reply_outbox"));
      return {results:insert?[{update_id:insert.values[0],chat_id:insert.values[1],thread_id:insert.values[2],reply_text:insert.values[3],business_connection_id:insert.values[5]}]:[]};
     }
     return {results:[]};
    },
    async first(){
     statements.push(entry);
     if(sql.includes("SELECT id,status,expires_at FROM task_approvals WHERE task_id")){
      const insert=statements.findLast(x=>x.sql.includes("INSERT OR IGNORE INTO task_approvals"));
      return insert?{id:insert.values[0],status:"pending",expires_at:insert.values[4]}:null;
     }
     if(sql.includes("SELECT id,task_id,status,expires_at FROM task_approvals WHERE id"))return {id:entry.values[0],task_id:"tg-42",status:"pending",expires_at:"2099-01-01T00:00:00.000Z"};
     if(sql.includes("SELECT * FROM memory_compaction_state"))return {owner_id:entry.values[0],active_generation:1,mem0_paused_month:null,updated_at:"2026-11-10T00:00:00.000Z"};
     if(sql.includes("sqlite_master"))return {total:22};
     if(sql.includes("pragma_table_info('telegram_reply_outbox')"))return {total:3};
     if(sql.includes("pragma_table_info"))return {total:4};
     if(sql.includes("SELECT chat_id,thread_id,reply_text,status,business_connection_id")){
      const insert=statements.findLast(x=>x.sql.includes("INSERT OR IGNORE INTO telegram_reply_outbox"));
      return insert?{chat_id:insert.values[1],thread_id:insert.values[2],reply_text:insert.values[3],status:"pending",business_connection_id:insert.values[5]}:null;
     }
     return null;
    }
   };return statement;
  },
  async batch(items){statements.push(...items.map(x=>x.entry||x));return items.map((_,i)=>({success:true,meta:{changes:i===0?1:1}}));}
 };
 return {db,statements};
}
function env(db,events=[],overrides={}){return {DB:db,EVENTS:{send:async(event)=>{events.push(event);}},TELEGRAM_BOT_TOKEN:BOT,TELEGRAM_OWNER_ID:OWNER,TELEGRAM_WEBHOOK_SECRET:SECRET,TRANSACTRA_PLANNER_MODE:"d1-native",...overrides};}
function queued(text,updateId=42){let ack=false;return {message:{body:{type:"telegram.update",updateId,receivedAt:new Date().toISOString(),payload:{update_id:updateId,message:{text,from:{id:OWNER},chat:{id:OWNER,type:"private"}}}},ack(){ack=true;}},acknowledged:()=>ack};}

test("D1-native readiness checks local schema and does not call external planner",async()=>{
 const {db}=nativeDb();let externalCalls=0;const original=globalThis.fetch;globalThis.fetch=async()=>{externalCalls++;throw new Error("external planner must not be called");};
 try{const response=await worker.fetch(new Request("https://edge.test/ready"),env(db));assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,service:"transactra-edge",ready:true,planner:"d1-native",inference:{status:"disabled",configured:false,runtime_enabled:false,developer_access_verified:false,zero_cost_verified:false,billing_mode:"nvidia_developer_program_free_endpoint",models:[],reason:"developer_access_unverified"},memory:{provider:"d1-fallback",mem0:"stale",checked_at:null}});assert.equal(externalCalls,0);}finally{globalThis.fetch=original;}
});

test("D1-native task creation persists a draft, owner approval and blocked job without external planner or inference",async()=>{
 const {db,statements}=nativeDb(),item=queued("/task Prepare a deployment checklist");const sent=[];const original=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{assert.equal(String(url),"https://api.telegram.org/bot"+BOT+"/sendMessage");sent.push(JSON.parse(init.body));return new Response(JSON.stringify({ok:true,result:{message_id:1}}),{status:200,headers:{"content-type":"application/json"}});};
 try{await worker.queue({messages:[item.message]},env(db));}finally{globalThis.fetch=original;}
 assert.equal(item.acknowledged(),true);assert.match(sent[0].text,/D1-native planner/);assert.match(sent[0].text,/Approval ID:/);
 assert.ok(statements.some(x=>x.sql.includes("INSERT OR IGNORE INTO task_approvals")));
 assert.ok(statements.some(x=>x.sql.includes("INSERT OR IGNORE INTO execution_plans")&&x.values[2]==="disabled"&&x.values[3]==="none"));
 assert.ok(statements.some(x=>x.sql.includes("INSERT OR IGNORE INTO orchestrator_jobs")&&x.sql.includes("'blocked'")));
 assert.ok(statements.some(x=>x.sql.includes("INSERT INTO task_run_events")&&x.sql.includes("NOT EXISTS")),"duplicate webhook delivery must not duplicate run events");
 assert.ok(statements.some(x=>x.sql.includes("INSERT INTO orchestrator_events")&&x.sql.includes("NOT EXISTS")),"duplicate webhook delivery must not duplicate orchestrator events");
 assert.equal(statements.some(x=>x.sql.includes("TRANSACTRA_PIPELINE")),false);
});

test("D1-native approval atomically records the decision and enqueues durable dispatch without running inference in the webhook",async()=>{
 const {db,statements}=nativeDb(),item=queued("/approve 11111111-1111-4111-8111-111111111111 reviewed-and-approved");const sent=[],events=[];const original=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{assert.equal(String(url),"https://api.telegram.org/bot"+BOT+"/sendMessage");sent.push(JSON.parse(init.body));return new Response(JSON.stringify({ok:true,result:{message_id:2}}),{status:200,headers:{"content-type":"application/json"}});};
 try{await worker.queue({messages:[item.message]},env(db,events));}finally{globalThis.fetch=original;}
 assert.equal(item.acknowledged(),true);assert.match(sent[0].text,/Execution remains blocked/);assert.ok(statements.some(x=>x.sql.includes("UPDATE task_approvals SET status=?")));
 assert.ok(statements.some(x=>x.sql.includes("UPDATE tasks SET status=?")&&x.values[0]==="awaiting_provider"));
 assert.ok(statements.some(x=>x.sql.includes("UPDATE task_runs SET state=?")&&x.values[0]==="awaiting_provider"));
 assert.ok(statements.some(x=>x.sql.includes("INSERT INTO task_run_events")&&x.sql.includes("NOT EXISTS")));
 assert.ok(statements.some(x=>x.sql.includes("INSERT INTO orchestrator_events")&&x.sql.includes("NOT EXISTS")));
 assert.deepEqual(events,[{type:"orchestrator.dispatch",taskId:"tg-42"}]);
});

test("plain-language objectives are converted into durable D1-native tasks",async()=>{
 const {db,statements}=nativeDb(),item=queued("Build a staging integration checklist",43),sent=[],original=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{assert.equal(String(url),"https://api.telegram.org/bot"+BOT+"/sendMessage");sent.push(JSON.parse(init.body));return new Response(JSON.stringify({ok:true,result:{message_id:3}}),{status:200,headers:{"content-type":"application/json"}});};
 try{await worker.queue({messages:[item.message]},env(db));}finally{globalThis.fetch=original;}
 assert.equal(item.acknowledged(),true);
 assert.match(sent[0].text,/Task saved by the D1-native planner/);
 assert.ok(statements.some(x=>x.sql.includes("INSERT OR IGNORE INTO tasks")&&x.values.includes("Build a staging integration checklist")));
 assert.ok(statements.some(x=>x.sql.includes("INSERT OR IGNORE INTO task_approvals")));
});

test("owner Telegram payment commands preserve policy approval and PayPal buyer authorization boundaries",async()=>{
 const {db}=nativeDb(),approve=queued("/pay-approve 11111111-1111-4111-8111-111111111111",44),capture=queued("/pay-capture ORDER1234567890",45),sent=[],requests=[],original=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{
  const value=String(url);requests.push({url:value,options:init});
  if(value==="https://api.transactra.example/api/orders")return new Response(JSON.stringify({orderId:"ORDER1234567890",approveUrl:"https://www.paypal.com/checkoutnow?token=ORDER1234567890",risk:"medium",policyVersion:"policy-v1"}),{status:201,headers:{"content-type":"application/json"}});
  if(value==="https://api.transactra.example/api/orders/ORDER1234567890/capture")return new Response(JSON.stringify({status:"COMPLETED"}),{status:200,headers:{"content-type":"application/json"}});
  assert.equal(value,"https://api.telegram.org/bot"+BOT+"/sendMessage");
  sent.push(JSON.parse(init.body));
  return new Response(JSON.stringify({ok:true,result:{message_id:4}}),{status:200,headers:{"content-type":"application/json"}});
 };
 try{
  const paymentEnv=env(db,[],{TRANSACTRA_API_BASE_URL:"https://api.transactra.example",BACKEND_SHARED_SECRET:"s".repeat(40)});
  await worker.queue({messages:[approve.message]},paymentEnv);
  await worker.queue({messages:[capture.message]},paymentEnv);
 }finally{globalThis.fetch=original;}
 assert.equal(approve.acknowledged(),true);
 assert.equal(capture.acknowledged(),true);
 assert.match(sent[0].text,/Complete buyer authorization at this PayPal URL/);
 assert.match(sent[0].text,/No funds have been captured yet/);
 assert.match(sent[1].text,/Payment capture is confirmed by PayPal/);
 assert.equal(requests[0].options.headers["x-transactra-edge-secret"],"s".repeat(40));
 assert.equal(requests[0].options.headers["x-transactra-owner-id"],OWNER);
 assert.equal(requests[2].url,"https://api.transactra.example/api/orders/ORDER1234567890/capture");
 assert.equal(requests[2].options.method,"POST");
});

test("staging orchestrator uses the Telegram service binding for replies without copying the bot token",async()=>{
 const {db}=nativeDb(),item=queued("/task Prepare a staging release checklist",91),requests=[];
 const bridge="staging-telegram-bridge-secret-with-more-than-32-bytes";
 const gateway={async fetch(request){requests.push(request);return new Response(JSON.stringify({ok:true,result:{message_id:91}}),{status:200,headers:{"content-type":"application/json"}});}};
 const stagingEnv=env(db,[],{TELEGRAM_BOT_TOKEN:undefined,TELEGRAM_WEBHOOK_SECRET:undefined,TELEGRAM_GATEWAY:gateway,TRANSACTRA_TELEGRAM_BRIDGE_SECRET:bridge});
 const ready=await worker.fetch(new Request("https://edge.test/ready"),stagingEnv);
 assert.equal(ready.status,200,"D1 readiness must accept the authenticated Telegram gateway binding");
 await worker.queue({messages:[item.message]},stagingEnv);
 assert.equal(item.acknowledged(),true);
 assert.equal(requests.length,1);
 assert.equal(new URL(requests[0].url).pathname,"/internal/telegram/send");
 assert.equal(requests[0].headers.get("x-transactra-bridge-secret"),bridge);
 const payload=await requests[0].json();
 assert.equal(payload.chat_id,OWNER);
 assert.match(payload.text,/Task saved by the D1-native planner/);
});
