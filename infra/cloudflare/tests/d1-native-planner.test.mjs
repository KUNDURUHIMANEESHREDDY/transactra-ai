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
    async all(){statements.push(entry);if(sql.includes("SELECT id,memory_key,memory_value FROM agent_memory"))return {results:[]};return {results:[]};},
    async first(){
     statements.push(entry);
     if(sql.includes("SELECT id,status,expires_at FROM task_approvals WHERE task_id")){
      const insert=statements.findLast(x=>x.sql.includes("INSERT OR IGNORE INTO task_approvals"));
      return insert?{id:insert.values[0],status:"pending",expires_at:insert.values[4]}:null;
     }
     if(sql.includes("SELECT id,task_id,status,expires_at FROM task_approvals WHERE id"))return {id:entry.values[0],task_id:"tg-42",status:"pending",expires_at:"2099-01-01T00:00:00.000Z"};
     if(sql.includes("SELECT * FROM memory_compaction_state"))return {owner_id:entry.values[0],active_generation:1,mem0_paused_month:null,updated_at:"2026-11-10T00:00:00.000Z"};
     if(sql.includes("sqlite_master"))return {total:19};
     if(sql.includes("pragma_table_info('telegram_reply_outbox')"))return {total:1};
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
function env(db){return {DB:db,EVENTS:{send:async()=>{}},TELEGRAM_BOT_TOKEN:BOT,TELEGRAM_OWNER_ID:OWNER,TELEGRAM_WEBHOOK_SECRET:SECRET,TRANSACTRA_PLANNER_MODE:"d1-native"};}
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

test("D1-native approval uses an atomic local D1 batch and never dispatches execution",async()=>{
 const {db,statements}=nativeDb(),item=queued("/approve 11111111-1111-4111-8111-111111111111 reviewed-and-approved");const sent=[];const original=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{assert.equal(String(url),"https://api.telegram.org/bot"+BOT+"/sendMessage");sent.push(JSON.parse(init.body));return new Response(JSON.stringify({ok:true,result:{message_id:2}}),{status:200,headers:{"content-type":"application/json"}});};
 try{await worker.queue({messages:[item.message]},env(db));}finally{globalThis.fetch=original;}
 assert.equal(item.acknowledged(),true);assert.match(sent[0].text,/Execution remains blocked/);assert.ok(statements.some(x=>x.sql.includes("UPDATE task_approvals SET status=?")));
 assert.ok(statements.some(x=>x.sql.includes("UPDATE tasks SET status=?")&&x.values[0]==="awaiting_provider"));
 assert.ok(statements.some(x=>x.sql.includes("UPDATE task_runs SET state=?")&&x.values[0]==="awaiting_provider"));
 assert.ok(statements.some(x=>x.sql.includes("INSERT INTO task_run_events")&&x.sql.includes("NOT EXISTS")));
 assert.ok(statements.some(x=>x.sql.includes("INSERT INTO orchestrator_events")&&x.sql.includes("NOT EXISTS")));
 assert.equal(statements.some(x=>x.sql.includes("INSERT INTO EVENTS")||x.sql.includes("queue.send")),false);
});