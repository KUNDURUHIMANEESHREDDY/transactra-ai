import { evaluateOrchestratorStep, replanOrchestratorFailure, validateApprovedExecutionPlan, requiresOwnerStepApproval } from "./orchestrator.mjs";
import { runAgentWorker, isAgentExecutionEnabled } from "./agent-runtime.mjs";
import { buildToolAction, hashToolAction } from "./tool-adapters.mjs";

export function hasAcceptedStepEvidence(rows) {
  return Array.isArray(rows) && rows.length > 0 && rows.every(row => {
    if (row.status !== "succeeded" || typeof row.result_text !== "string" || !row.result_text.trim()) return false;
    try {
      const evidence = JSON.parse(row.evaluation_json || "null");
      return evidence?.decision === "accepted" && evidence?.accepted === true
        && typeof evidence.rationale === "string" && evidence.rationale.trim().length > 0;
    } catch {
      return false;
    }
  });
}

export async function finalizeD1NativeCompletedJobs(env, now) {
  const ownerId = typeof env.TELEGRAM_OWNER_ID === "string" ? env.TELEGRAM_OWNER_ID.trim() : "";
  if (!ownerId) return { finalized: 0, reason: "owner_identity_unavailable" };
  const due = await env.DB.prepare(`
    SELECT j.id,j.task_id,p.plan_json
    FROM orchestrator_jobs j
    JOIN tasks t ON t.id=j.task_id
    JOIN task_approvals a ON a.task_id=j.task_id
    JOIN execution_plans p ON p.task_id=j.task_id
    WHERE a.status='approved' AND a.owner_id=? AND p.status='approved'
      AND t.status IN ('awaiting_provider','running')
      AND (j.status='blocked' OR (j.status='leased' AND j.lease_until<=?))
    ORDER BY j.created_at LIMIT 10
  `).bind(ownerId,now).all();
  let finalized = 0;
  for (const job of due?.results || []) {
    const lease = crypto.randomUUID();
    const claimed = await env.DB.prepare("UPDATE orchestrator_jobs SET status='leased',lease_token=?,lease_until=?,updated_at=? WHERE id=? AND (status='blocked' OR (status='leased' AND lease_until<=?)) AND EXISTS (SELECT 1 FROM task_approvals WHERE task_id=? AND owner_id=? AND status='approved') AND EXISTS (SELECT 1 FROM execution_plans WHERE task_id=? AND status='approved')").bind(lease,new Date(Date.parse(now)+60000).toISOString(),now,job.id,now,job.task_id,ownerId,job.task_id).run();
    if (Number(claimed?.meta?.changes || 0) !== 1) continue;
    try {
      let plan;
      try { plan = validateApprovedExecutionPlan(JSON.parse(job.plan_json)); }
      catch { throw new Error("Stored execution plan failed finalization validation"); }
      const ledger = await env.DB.prepare("SELECT step_id,sequence_no,status,attempt_count,result_text,evaluation_json FROM orchestrator_step_runs WHERE task_id=? ORDER BY sequence_no").bind(job.task_id).all();
      const rows = ledger?.results || [];
      if (rows.length !== plan.steps.length || !hasAcceptedStepEvidence(rows)) {
        await env.DB.prepare("UPDATE orchestrator_jobs SET status='blocked',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=?").bind(now,job.id,lease).run();
        continue;
      }
      await env.DB.batch([
        env.DB.prepare("UPDATE execution_plans SET status='completed',updated_at=? WHERE task_id=? AND status='approved'").bind(now,job.task_id),
        env.DB.prepare("UPDATE tasks SET status='succeeded',updated_at=? WHERE id=? AND status IN ('awaiting_provider','running')").bind(now,job.task_id),
        env.DB.prepare("UPDATE task_runs SET state='succeeded',completed_at=?,updated_at=? WHERE task_id=? AND state IN ('awaiting_provider','queued','running')").bind(now,now,job.task_id),
        env.DB.prepare("UPDATE orchestrator_jobs SET status='linked',lease_token=NULL,lease_until=NULL,last_error=NULL,completed_at=?,updated_at=? WHERE id=? AND lease_token=?").bind(now,now,job.id,lease),
        env.DB.prepare("INSERT INTO orchestrator_events (job_id,task_id,event_type,detail,created_at) VALUES (?,?,?,?,?)").bind(job.id,job.task_id,"orchestrator.completed","All approved agent steps have persisted accepted evaluator evidence.",now),
      ]);
      finalized++;
    } catch (error) {
      const message = String(error?.message || "Evidence-backed task finalization failed").slice(0,500);
      await env.DB.prepare("UPDATE orchestrator_jobs SET status='blocked',lease_token=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE id=? AND lease_token=?").bind(message,now,job.id,lease).run();
      await env.DB.prepare("INSERT INTO orchestrator_events (job_id,task_id,event_type,detail,created_at) VALUES (?,?,?,?,?)").bind(job.id,job.task_id,"orchestrator.finalization_error",message,now).run();
    }
  }
  return { finalized };
}

async function notifyStepApprovalOwner(env, approval, job, step, actionHash, now) {
  const token = typeof env.TELEGRAM_BOT_TOKEN === "string" ? env.TELEGRAM_BOT_TOKEN.trim() : "";
  if (!token) return;
  const claim = await env.DB.prepare("UPDATE orchestrator_step_approvals SET notification_attempted_at=? WHERE id=? AND notification_attempted_at IS NULL").bind(now, approval.id).run();
  if (Number(claim?.meta?.changes || 0) !== 1) return;
  const text = [
    "Transactra step approval required",
    "Task: " + job.task_id,
    "Step: " + step.id + " (" + step.agent + ")",
    "Tool: " + step.tool,
    "Approval: " + approval.id,
    "Action hash: " + actionHash,
    "Inspect with /step-approvals and /step-approval " + approval.id,
    "Approve only after inspecting the exact action: /approve-step " + approval.id + " " + actionHash.slice(0, 16) + " <reason>",
    "Reject: /reject-step " + approval.id + " " + actionHash.slice(0, 16) + " <reason>",
  ].join("\n");
  try {
    const response = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: String(env.TELEGRAM_OWNER_ID), text, disable_web_page_preview: true }),
      redirect: "error", signal: AbortSignal.timeout(12000),
    });
    const data = await response.json().catch(() => null);
    if (response.ok && data?.ok === true) {
      await env.DB.prepare("UPDATE orchestrator_step_approvals SET notified_at=? WHERE id=? AND notification_attempted_at=?").bind(now, approval.id, now).run();
    } else {
      await env.DB.prepare("INSERT INTO orchestrator_events (job_id,task_id,event_type,detail,created_at) VALUES (?,?,?,?,?)").bind(job.id,job.task_id,"orchestrator.step_approval_notification_failed","Telegram notification failed; approval remains available through /step-approvals.",now).run();
    }
  } catch {
    await env.DB.prepare("INSERT INTO orchestrator_events (job_id,task_id,event_type,detail,created_at) VALUES (?,?,?,?,?)").bind(job.id,job.task_id,"orchestrator.step_approval_notification_failed","Telegram notification outcome is unknown; no action was executed. Inspect /step-approvals.",now).run();
  }
}

async function ensureStepApproval(env, job, step, ownerId, now) {
  const action = buildToolAction(step);
  const actionHash = await hashToolAction(action);
  let approval = await env.DB.prepare("SELECT id,status,action_hash,action_json,expires_at,notification_attempted_at FROM orchestrator_step_approvals WHERE task_id=? AND step_id=? AND owner_id=?").bind(job.task_id,step.id,ownerId).first();
  if (!approval) {
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare("INSERT OR IGNORE INTO orchestrator_step_approvals (id,task_id,step_id,owner_id,status,action_hash,action_json,created_at,expires_at) VALUES (?,?,?,?,'pending',?,?,?,?)").bind(id,job.task_id,step.id,ownerId,actionHash,JSON.stringify(action),now,expiresAt).run();
    approval = await env.DB.prepare("SELECT id,status,action_hash,action_json,expires_at,notification_attempted_at FROM orchestrator_step_approvals WHERE task_id=? AND step_id=? AND owner_id=?").bind(job.task_id,step.id,ownerId).first();
  }
  if (!approval) throw new Error("Could not persist the owner step approval record");
  if (approval.action_hash !== actionHash || approval.action_json !== JSON.stringify(action)) {
    await env.DB.batch([
      env.DB.prepare("UPDATE orchestrator_step_runs SET status='needs_review',lease_token=NULL,lease_until=NULL,last_error='Approved action no longer matches the immutable plan; no tool was invoked',updated_at=? WHERE task_id=? AND step_id=? AND status IN ('queued','retry')").bind(now,job.task_id,step.id),
      env.DB.prepare("UPDATE orchestrator_jobs SET status='blocked',lease_token=NULL,lease_until=NULL,last_error='Step approval hash mismatch; owner review required',updated_at=? WHERE id=?").bind(now,job.id),
      env.DB.prepare("INSERT INTO orchestrator_events (job_id,task_id,event_type,detail,created_at) VALUES (?,?,?,?,?)").bind(job.id,job.task_id,"orchestrator.step_approval_hash_mismatch","The current plan differs from the action the owner approved. No tool was invoked.",now),
    ]);
    return { pending: true };
  }
  if (approval.expires_at <= now && (approval.status === "pending" || approval.status === "approved")) {
    await env.DB.batch([
      env.DB.prepare("UPDATE orchestrator_step_approvals SET status='expired' WHERE id=? AND owner_id=? AND status IN ('pending','approved') AND expires_at<=?").bind(approval.id,ownerId,now),
      env.DB.prepare("UPDATE orchestrator_step_runs SET status='needs_review',lease_token=NULL,lease_until=NULL,last_error='Step approval expired before execution; no tool was invoked',updated_at=? WHERE task_id=? AND step_id=? AND status IN ('queued','retry')").bind(now,job.task_id,step.id),
      env.DB.prepare("UPDATE orchestrator_jobs SET status='blocked',lease_token=NULL,lease_until=NULL,last_error='Step approval expired before execution',updated_at=? WHERE id=?").bind(now,job.id),
    ]);
    return { pending: true };
  }
  if (approval.status === "pending") {
    await env.DB.batch([
      env.DB.prepare("UPDATE orchestrator_step_runs SET status='needs_review',lease_token=NULL,lease_until=NULL,last_error='Waiting for separate owner approval of the exact step action',updated_at=? WHERE task_id=? AND step_id=? AND status IN ('queued','retry')").bind(now,job.task_id,step.id),
      env.DB.prepare("UPDATE orchestrator_jobs SET status='blocked',lease_token=NULL,lease_until=NULL,last_error='Waiting for owner step approval',updated_at=? WHERE id=?").bind(now,job.id),
      env.DB.prepare("INSERT INTO orchestrator_events (job_id,task_id,event_type,detail,created_at) VALUES (?,?,?,?,?)").bind(job.id,job.task_id,"orchestrator.step_approval_required",JSON.stringify({approval_id:approval.id,step_id:step.id,tool:step.tool,action_hash:actionHash}),now),
    ]);
    await notifyStepApprovalOwner(env,approval,job,step,actionHash,now);
    return { pending: true };
  }
  if (approval.status === "approved") return { pending: false, approvedAction: { id: approval.id, action_hash: actionHash } };
  const reason = approval.status === "consumed"
    ? "Step approval was already consumed; ambiguous side effects are never replayed"
    : "Step approval is " + approval.status + "; submit a new task for a fresh review";
  await env.DB.batch([
    env.DB.prepare("UPDATE orchestrator_step_runs SET status='needs_review',lease_token=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE task_id=? AND step_id=? AND status IN ('queued','retry')").bind(reason,now,job.task_id,step.id),
    env.DB.prepare("UPDATE orchestrator_jobs SET status='blocked',lease_token=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE id=?").bind(reason,now,job.id),
  ]);
  return { pending: true };
}

export async function processD1NativeApprovedJobs(env, scheduledTime, now) {
  const ownerId = typeof env.TELEGRAM_OWNER_ID === "string" ? env.TELEGRAM_OWNER_ID.trim() : "";
  if (!ownerId) return { dispatched: 0, reason: "owner_identity_unavailable" };
  if (!isAgentExecutionEnabled(env)) return { dispatched: 0, reason: "agent_execution_disabled" };
  const due = await env.DB.prepare(`
    SELECT j.id,j.task_id,t.description,p.plan_json
    FROM orchestrator_jobs j
    JOIN tasks t ON t.id=j.task_id
    JOIN task_approvals a ON a.task_id=j.task_id
    JOIN execution_plans p ON p.task_id=j.task_id
    WHERE a.status='approved' AND a.owner_id=?
      AND p.status='approved'
      AND t.status IN ('awaiting_provider','running')
      AND (j.status='blocked' OR (j.status='leased' AND j.lease_until<=?))
    ORDER BY j.created_at LIMIT 3
  `).bind(ownerId,now).all();
  let dispatched = 0;
  for (const job of due?.results || []) {
    const lease = crypto.randomUUID();
    const leaseUntil = new Date(scheduledTime + 4 * 60 * 1000).toISOString();
    const claimed = await env.DB.prepare("UPDATE orchestrator_jobs SET status='leased',lease_token=?,lease_until=?,updated_at=? WHERE id=? AND (status='blocked' OR (status='leased' AND lease_until<=?)) AND EXISTS (SELECT 1 FROM task_approvals WHERE task_id=? AND owner_id=? AND status='approved') AND EXISTS (SELECT 1 FROM execution_plans WHERE task_id=? AND status='approved') AND EXISTS (SELECT 1 FROM tasks WHERE id=? AND status IN ('awaiting_provider','running'))").bind(lease,leaseUntil,now,job.id,now,job.task_id,ownerId,job.task_id,job.task_id).run();
    if (Number(claimed?.meta?.changes || 0) !== 1) continue;
    try {
      let plan;
      try { plan = JSON.parse(job.plan_json); } catch { throw new Error("Stored execution plan is invalid JSON"); }
      plan = validateApprovedExecutionPlan(plan);
      for (let i=0;i<plan.steps.length;i++) {
        const step=plan.steps[i];
        await env.DB.prepare("INSERT OR IGNORE INTO orchestrator_step_runs (id,task_id,step_id,sequence_no,agent,tool,status,attempt_count,input_json,created_at,updated_at) VALUES (?,?,?,?,?,?,'queued',0,?,?,?)").bind(job.task_id+":"+step.id,job.task_id,step.id,i+1,step.agent,step.tool,JSON.stringify({description:step.description,acceptance_criteria:step.acceptance_criteria,risk:step.risk,depends_on:step.depends_on,tool_input:step.tool_input}),now,now).run();
      }
      await env.DB.prepare("UPDATE orchestrator_step_runs SET status='needs_review',lease_token=NULL,lease_until=NULL,last_error='Previous agent lease expired; replay withheld to avoid duplicate side effects',updated_at=? WHERE task_id=? AND status='leased' AND lease_until<=?").bind(now,job.task_id,now).run();
      const ledger=await env.DB.prepare("SELECT step_id,sequence_no,status,attempt_count,result_text,evaluation_json FROM orchestrator_step_runs WHERE task_id=? ORDER BY sequence_no").bind(job.task_id).all();
      const rows=ledger?.results||[];
      if(rows.length!==plan.steps.length)throw new Error("Step ledger does not match approved plan");
      if (rows.every(row => row.status === "succeeded") && !hasAcceptedStepEvidence(rows)) {
        const reason = "Step ledger is marked succeeded but lacks persisted accepted evaluator evidence; task completion withheld";
        await env.DB.batch([
          env.DB.prepare("UPDATE orchestrator_jobs SET status='blocked',lease_token=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE id=? AND lease_token=?").bind(reason,now,job.id,lease),
          env.DB.prepare("INSERT INTO orchestrator_events (job_id,task_id,event_type,detail,created_at) VALUES (?,?,?,?,?)").bind(job.id,job.task_id,"orchestrator.completion_evidence_missing",reason,now),
        ]);
        continue;
      }
      if(hasAcceptedStepEvidence(rows)) {
        await env.DB.batch([
          env.DB.prepare("UPDATE execution_plans SET status='completed',updated_at=? WHERE task_id=? AND status='approved'").bind(now,job.task_id),
          env.DB.prepare("UPDATE tasks SET status='succeeded',updated_at=? WHERE id=?").bind(now,job.task_id),
          env.DB.prepare("UPDATE task_runs SET state='succeeded',completed_at=?,updated_at=? WHERE task_id=?").bind(now,now,job.task_id),
          env.DB.prepare("UPDATE orchestrator_jobs SET status='linked',lease_token=NULL,lease_until=NULL,last_error=NULL,completed_at=?,updated_at=? WHERE id=? AND lease_token=?").bind(now,now,job.id,lease),
          env.DB.prepare("INSERT INTO orchestrator_events (job_id,task_id,event_type,detail,created_at) VALUES (?,?,?,?,?)").bind(job.id,job.task_id,"orchestrator.completed","All approved agent steps passed result evaluation.",now)
        ]);
        continue;
      }
      const pending=rows.find(row=>row.status==="queued"||row.status==="retry");
      if(!pending) {
        await env.DB.prepare("UPDATE orchestrator_jobs SET status='blocked',lease_token=NULL,lease_until=NULL,last_error='Agent steps require owner review or an adapter',updated_at=? WHERE id=? AND lease_token=?").bind(now,job.id,lease).run();
        continue;
      }
      const step=plan.steps[pending.sequence_no-1], dependencies=step.depends_on||[];
      const prior=rows.filter(row=>row.sequence_no<pending.sequence_no);
      if(dependencies.some(dep=>prior.find(row=>row.sequence_no===dep)?.status!=="succeeded")) {
        await env.DB.prepare("UPDATE orchestrator_jobs SET status='blocked',lease_token=NULL,lease_until=NULL,last_error='Step dependencies are not complete',updated_at=? WHERE id=? AND lease_token=?").bind(now,job.id,lease).run();
        continue;
      }
      let approvedAction = null;
      if (requiresOwnerStepApproval(step)) {
        const approvalState = await ensureStepApproval(env,job,step,ownerId,now);
        if (approvalState.pending) continue;
        approvedAction = approvalState.approvedAction;
      }
      if (Number(pending.attempt_count || 0) >= 5) {
        const reason="Step reached the five-attempt execution limit; owner review is required.";
        await env.DB.batch([
          env.DB.prepare("UPDATE orchestrator_step_runs SET status='needs_review',lease_token=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE task_id=? AND step_id=? AND status IN ('queued','retry')").bind(reason,now,job.task_id,pending.step_id),
          env.DB.prepare("UPDATE orchestrator_jobs SET status='blocked',lease_token=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE id=? AND lease_token=?").bind(reason,now,job.id,lease),
          env.DB.prepare("INSERT INTO orchestrator_events (job_id,task_id,event_type,detail,created_at) VALUES (?,?,?,?,?)").bind(job.id,job.task_id,"orchestrator.step_attempt_limit",reason,now)
        ]);
        continue;
      }
      const stepLease=crypto.randomUUID();
      const stepClaim=await env.DB.prepare("UPDATE orchestrator_step_runs SET status='leased',lease_token=?,lease_until=?,attempt_count=attempt_count+1,updated_at=? WHERE task_id=? AND step_id=? AND status IN ('queued','retry') AND attempt_count<5 AND EXISTS (SELECT 1 FROM task_approvals WHERE task_id=? AND owner_id=? AND status='approved') AND EXISTS (SELECT 1 FROM execution_plans WHERE task_id=? AND status='approved')").bind(stepLease,leaseUntil,now,job.task_id,pending.step_id,job.task_id,ownerId,job.task_id).run();
      if(Number(stepClaim?.meta?.changes||0)!==1)throw new Error("Agent step was concurrently claimed");
      if (approvedAction) {
        const consumed = await env.DB.prepare("UPDATE orchestrator_step_approvals SET status='consumed',consumed_at=? WHERE id=? AND owner_id=? AND status='approved' AND action_hash=? AND expires_at>?").bind(now,approvedAction.id,ownerId,approvedAction.action_hash,now).run();
        if (Number(consumed?.meta?.changes || 0) !== 1) {
          await env.DB.prepare("UPDATE orchestrator_step_runs SET status='needs_review',lease_token=NULL,lease_until=NULL,last_error='Owner approval could not be consumed atomically; no tool was invoked',updated_at=? WHERE task_id=? AND step_id=? AND lease_token=?").bind(now,job.task_id,pending.step_id,stepLease).run();
          throw new Error("Owner step approval was concurrently changed; tool invocation withheld");
        }
      }
      await env.DB.batch([
        env.DB.prepare("UPDATE tasks SET status='running',updated_at=? WHERE id=?").bind(now,job.task_id),
        env.DB.prepare("UPDATE task_runs SET state='running',started_at=COALESCE(started_at,?),attempt_count=attempt_count+1,updated_at=? WHERE task_id=?").bind(now,now,job.task_id),
        env.DB.prepare("INSERT INTO task_run_events (run_id,event_type,detail,created_at) SELECT id,?,?,? FROM task_runs WHERE task_id=?").bind("run.agent_step_started","Agent "+step.agent+" started "+pending.step_id+".",now,job.task_id)
      ]);
      const priorResults=prior.filter(row=>row.status==="succeeded").map(row=>({step_id:row.step_id,result_text:row.result_text}));
      const worker=await runAgentWorker(env,step,{objective:job.description,priorResults,taskId:job.task_id,requiresApproval:requiresOwnerStepApproval(step),approvedAction});
      if(worker.status!=="completed") {
        const stepStatus="needs_review";
        const message=String(worker.error||"Agent step blocked; owner review required and automatic replay withheld").slice(0,500);
        let recoveryProposal=null;
        // Replan only for capability/schema failures, never replay an ambiguous provider request.
        if (/Tool adapter unavailable|Unknown agent worker|failed validation/i.test(message)) {
          recoveryProposal=await replanOrchestratorFailure(env,env.DB,job.description,step,message,[]);
        }
        await env.DB.batch([
          env.DB.prepare("UPDATE orchestrator_step_runs SET status=?,lease_token=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE task_id=? AND step_id=? AND lease_token=?").bind(stepStatus,message,now,job.task_id,pending.step_id,stepLease),
          env.DB.prepare("UPDATE orchestrator_jobs SET status='blocked',lease_token=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE id=? AND lease_token=?").bind(message,now,job.id,lease),
          env.DB.prepare("INSERT INTO orchestrator_events (job_id,task_id,event_type,detail,created_at) VALUES (?,?,?,?,?)").bind(job.id,job.task_id,recoveryProposal?"orchestrator.replan_proposed":"orchestrator.agent_blocked",recoveryProposal?JSON.stringify({failure:message,plan:recoveryProposal}).slice(0,5000):message,now)
        ]);
        continue;
      }
      const evaluation=await evaluateOrchestratorStep(env,env.DB,{objective:job.description,step,result:worker.result,stepApprovalVerified:Boolean(approvedAction)});
      if(evaluation.decision!=="accepted") {
        let recoveryProposal=null;
        if (evaluation.decision==="retry" || evaluation.decision==="replan") {
          recoveryProposal=await replanOrchestratorFailure(env,env.DB,job.description,step,evaluation.rationale,priorResults);
        }
        const detail=JSON.stringify({decision:evaluation.decision,rationale:evaluation.rationale,evidence_required:evaluation.evidence_required,recovery_plan:recoveryProposal}).slice(0,5000);
        await env.DB.batch([
          env.DB.prepare("UPDATE orchestrator_step_runs SET status='needs_review',lease_token=NULL,lease_until=NULL,result_text=?,evaluation_json=?,last_error=?,updated_at=? WHERE task_id=? AND step_id=? AND lease_token=?").bind(worker.result,JSON.stringify(evaluation),detail,now,job.task_id,pending.step_id,stepLease),
          env.DB.prepare("UPDATE orchestrator_jobs SET status='blocked',lease_token=NULL,lease_until=NULL,last_error='Result evaluation requires owner review',updated_at=? WHERE id=? AND lease_token=?").bind(now,job.id,lease),
          env.DB.prepare("INSERT INTO orchestrator_events (job_id,task_id,event_type,detail,created_at) VALUES (?,?,?,?,?)").bind(job.id,job.task_id,"orchestrator.evaluation_review",detail,now)
        ]);
        continue;
      }
      await env.DB.batch([
        env.DB.prepare("UPDATE orchestrator_step_runs SET status='succeeded',lease_token=NULL,lease_until=NULL,result_text=?,evaluation_json=?,last_error=NULL,completed_at=?,updated_at=? WHERE task_id=? AND step_id=? AND lease_token=?").bind(worker.result,JSON.stringify(evaluation),now,now,job.task_id,pending.step_id,stepLease),
        env.DB.prepare("INSERT INTO task_run_events (run_id,event_type,detail,created_at) SELECT id,?,?,? FROM task_runs WHERE task_id=?").bind("run.agent_step_succeeded","Agent "+step.agent+" completed "+pending.step_id+"; evaluator accepted evidence.",now,job.task_id),
        env.DB.prepare("INSERT INTO orchestrator_events (job_id,task_id,event_type,detail,created_at) VALUES (?,?,?,?,?)").bind(job.id,job.task_id,"orchestrator.agent_succeeded","Agent "+step.agent+" completed "+pending.step_id+"; evaluator accepted evidence.",now),
        env.DB.prepare("UPDATE orchestrator_jobs SET status='blocked',lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE id=? AND lease_token=?").bind(now,job.id,lease)
      ]);
      dispatched++;
    } catch(error) {
      const message=String(error?.message||"Orchestrator dispatch failed").slice(0,500);
      await env.DB.prepare("UPDATE orchestrator_jobs SET status='blocked',lease_token=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE id=? AND lease_token=?").bind(message,now,job.id,lease).run();
      await env.DB.prepare("INSERT INTO orchestrator_events (job_id,task_id,event_type,detail,created_at) VALUES (?,?,?,?,?)").bind(job.id,job.task_id,"orchestrator.dispatch_error",message,now).run();
    }
  }
  return {dispatched};
}
