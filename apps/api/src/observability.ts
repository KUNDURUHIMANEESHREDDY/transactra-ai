import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { getAuthenticatedUser } from "./request-auth.js";

function reply(res:ServerResponse,status:number,data:unknown){res.writeHead(status,{"Content-Type":"application/json","Cache-Control":"no-store","Vary":"Cookie, Authorization"});res.end(JSON.stringify(data));}
function limitFrom(url:URL){const n=Number(url.searchParams.get("limit")||50);return Number.isFinite(n)?Math.max(1,Math.min(200,Math.floor(n))):50;}
async function ownerId(db:Pool,userId:string){const r=await db.query("SELECT id FROM owners WHERE external_subject=$1 AND status='active' LIMIT 1",[userId]);return r.rows[0]?.id as string|undefined;}

/** Read-only, identity-scoped observability endpoints. No action in this module can move money or mutate agent state. */
export async function handleObservabilityRoute(req:IncomingMessage,res:ServerResponse,url:URL,db:Pool|null):Promise<boolean>{
 if(!url.pathname.startsWith("/api/observability/"))return false;
 if(req.method!=="GET"){reply(res,405,{error:"Observability endpoints are read-only."});return true;}
 const userId=getAuthenticatedUser(req);
 if(!userId){reply(res,401,{error:"An authenticated Transactra workspace session is required."});return true;}
 if(!db){reply(res,503,{error:"PostgreSQL is not configured."});return true;}
 try{
  const owner=await ownerId(db,userId),limit=limitFrom(url),path=url.pathname;
  if(path==="/api/observability/overview"){
   const tx=await db.query("SELECT COUNT(*)::int AS transactions,COUNT(*) FILTER(WHERE status='COMPLETED')::int AS completed,COUNT(*) FILTER(WHERE status IN ('FAILED','DENIED','POLICY_BLOCKED'))::int AS failed,COALESCE(SUM(amount) FILTER(WHERE status='COMPLETED'),0)::text AS volume FROM payment_transactions WHERE user_id=$1",[userId]);
   let tasks={running:0,failed:0,pending:0,activeAgents:0};
   if(owner){const q=await db.query("SELECT COUNT(*) FILTER(WHERE status='running')::int AS running,COUNT(*) FILTER(WHERE status='failed')::int AS failed,COUNT(*) FILTER(WHERE status='waiting_approval')::int AS pending,COUNT(DISTINCT assigned_agent_id) FILTER(WHERE status='running')::int AS active_agents FROM tasks WHERE owner_id=$1",[owner]);tasks={running:q.rows[0].running,failed:q.rows[0].failed,pending:q.rows[0].pending,activeAgents:q.rows[0].active_agents};}
   const t=tx.rows[0],successRate=Number(t.transactions)>0?Math.round(Number(t.completed)/Number(t.transactions)*100):0;
   reply(res,200,{transactions:t.transactions,completed:t.completed,failed:t.failed,volume:t.volume,activeAgents:tasks.activeAgents,runningTasks:tasks.running,failedTasks:tasks.failed,pendingApprovals:tasks.pending,successRate,database:true});return true;
  }
  if(path==="/api/observability/transactions"){
   const q=await db.query("SELECT id,recipient,purpose,amount::text,currency,status,paypal_order_id,created_at FROM payment_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2",[userId,limit]);
   reply(res,200,{transactions:q.rows});return true;
  }
  if(path==="/api/observability/agents"){
   if(!owner){reply(res,200,{agents:[]});return true;}
   const q=await db.query("SELECT a.id,a.name,a.department,a.lifecycle_status,COUNT(t.id) FILTER(WHERE t.status='running')::int AS active_tasks,COUNT(t.id) FILTER(WHERE t.status='succeeded')::int AS succeeded,COUNT(t.id) FILTER(WHERE t.status='failed')::int AS failed FROM agents a LEFT JOIN tasks t ON t.assigned_agent_id=a.id AND t.owner_id=$1 GROUP BY a.id,a.name,a.department,a.lifecycle_status ORDER BY a.department,a.name",[owner]);
   reply(res,200,{agents:q.rows});return true;
  }
  if(path==="/api/observability/logs"){
   if(!owner){reply(res,200,{events:[]});return true;}
   const q=await db.query(`SELECT * FROM (
    SELECT e.id::text AS id,e.event_type,e.actor_id,e.task_id::text AS task_id,NULL::text AS correlation_id,NULL::text AS outcome,e.payload->>'message' AS message,e.created_at,'task_event'::text AS source
    FROM task_events e JOIN tasks t ON t.id=e.task_id WHERE t.owner_id=$1
    UNION ALL
    SELECT i.id::text,i.capability,i.actor_id,i.task_id::text,i.correlation_id,i.outcome,i.resource,i.created_at,'tool_invocation'::text
    FROM tool_invocations i JOIN tasks t ON t.id=i.task_id WHERE t.owner_id=$1
    UNION ALL
    SELECT a.id::text,a.action,a.actor_id,NULL::text,a.correlation_id,a.outcome,a.resource,a.created_at,'audit_event'::text
    FROM audit_events a WHERE a.owner_id=$1
   ) events ORDER BY created_at DESC LIMIT $2`,[owner,limit]);
   reply(res,200,{events:q.rows});return true;
  }
  if(path==="/api/observability/traces"){
   if(!owner){reply(res,200,{traces:[]});return true;}
   const q=await db.query("SELECT i.id::text AS id,i.task_id::text AS task_id,i.actor_id,i.capability,i.resource,i.input_hash,i.policy_version,i.allowed,i.approval_id::text AS approval_id,i.outcome,i.correlation_id,i.created_at,i.completed_at,CASE WHEN i.completed_at IS NOT NULL THEN GREATEST(0,ROUND(EXTRACT(EPOCH FROM(i.completed_at-i.created_at))*1000))::int ELSE NULL END AS duration_ms FROM tool_invocations i JOIN tasks t ON t.id=i.task_id WHERE t.owner_id=$1 ORDER BY i.created_at DESC LIMIT $2",[owner,limit]);
   reply(res,200,{traces:q.rows});return true;
  }
  if(path==="/api/observability/policies"){
   const q=await db.query("SELECT id,event_type,allowed,reason,policy_version,risk_level,payload_hash,created_at FROM financial_policy_audit WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2",[userId,limit]);
   reply(res,200,{decisions:q.rows});return true;
  }
  if(path==="/api/observability/integrations"){
   const q=await db.query("SELECT DISTINCT ON(provider) provider,model,status,latency_ms,failure_reason,observed_at FROM provider_health ORDER BY provider,observed_at DESC");
   reply(res,200,{providers:q.rows,database:true,paypalConfigured:Boolean(process.env.PAYPAL_CLIENT_ID&&process.env.PAYPAL_CLIENT_SECRET),telegramConfigured:Boolean(process.env.TELEGRAM_BOT_TOKEN),cloudPilotConfigured:Boolean(process.env.CLOUDPILOT_INFERENCE_URL)});return true;
  }
  reply(res,404,{error:"Unknown observability endpoint."});return true;
 }catch(error){
  console.error("Observability query failed:",error instanceof Error?error.message:"unknown error");
  reply(res,500,{error:"Unable to load observability data."});return true;
 }
}
