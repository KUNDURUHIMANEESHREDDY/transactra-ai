export const DEMO_TASK_PROMPT = "Research the latest developments in artificial intelligence, analyze the most important trends, compare their business impact, and prepare a concise executive report with recommendations.";

function normalizePrompt(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isDemoTaskPrompt(value) {
  return normalizePrompt(value) === normalizePrompt(DEMO_TASK_PROMPT);
}

const MODEL_PENDING = "Awaiting the owner's approved model catalogue; no model has been selected.";

export function buildDemoTaskEvents(taskId, prompt, startedAt = Date.now()) {
  const rows = [
    ["demo.task_received", "ORCHESTRATOR", "Task received: " + prompt],
    ["demo.task_analyzed", "ORCHESTRATOR", "Analyzed the objective and decomposed it into five specialist stages."],
    ["demo.agent_assigned.research", "Research Agent", "Assigned: gather key AI development themes and evidence categories. Model: " + MODEL_PENDING],
    ["demo.agent_assigned.analysis", "Analysis Agent", "Assigned: synthesize findings into strategic trends. Model: " + MODEL_PENDING],
    ["demo.agent_assigned.comparison", "Comparison Agent", "Assigned: compare potential business impact across sectors. Model: " + MODEL_PENDING],
    ["demo.agent_assigned.writing", "Writing Agent", "Assigned: prepare the executive summary and recommendations. Model: " + MODEL_PENDING],
    ["demo.agent_assigned.verification", "Verification Agent", "Assigned: check completeness, consistency, and unsupported claims. Model: " + MODEL_PENDING],
    ["demo.agent_completed.research", "Research Agent", "SIMULATED OUTPUT: research themes prepared for downstream analysis. No live web research was performed."],
    ["demo.handoff.research_analysis", "Research Agent → Analysis Agent", "Handoff: research summary passed to Analysis Agent."],
    ["demo.agent_completed.analysis", "Analysis Agent", "SIMULATED OUTPUT: trends grouped by capability, adoption, efficiency, and governance."],
    ["demo.handoff.analysis_comparison", "Analysis Agent → Comparison Agent", "Handoff: trend analysis passed to Comparison Agent."],
    ["demo.agent_completed.comparison", "Comparison Agent", "SIMULATED OUTPUT: business-impact comparison prepared across productivity, customer experience, operations, and risk."],
    ["demo.handoff.comparison_writing", "Comparison Agent → Writing Agent", "Handoff: comparison findings passed to Writing Agent."],
    ["demo.agent_completed.writing", "Writing Agent", "SIMULATED OUTPUT: executive report and recommendations drafted."],
    ["demo.handoff.writing_verification", "Writing Agent → Verification Agent", "Handoff: draft report passed to Verification Agent."],
    ["demo.agent_completed.verification", "Verification Agent", "SIMULATED OUTPUT: completeness and consistency checks passed for the scripted demo output."],
    ["demo.orchestrator_verified", "ORCHESTRATOR", "Orchestrator collected all five agent outputs and verified the scripted workflow."],
    ["demo.task_completed", "ORCHESTRATOR", "DEMO COMPLETED: all scripted stages and handoffs recorded. No live model inference or external action was executed."]
  ];
  return rows.map(([event_type, actor, detail], index) => ({
    task_id: taskId,
    event_type,
    detail: "[" + actor + "] " + detail,
    created_at: new Date(startedAt - (rows.length - index - 1) * 750).toISOString()
  }));
}

export async function runDemoTask(env, update, prompt) {
  if (!env?.DB || typeof env.DB.prepare !== "function") {
    throw new Error("demo_task_database_unavailable");
  }
  const updateId = String(update?.update_id ?? "");
  const ownerId = String(env.TELEGRAM_OWNER_ID || "");
  if (!/^\\d{1,20}$/.test(updateId) || !/^\\d{1,20}$/.test(ownerId)) {
    throw new Error("demo_task_identity_invalid");
  }
  const taskId = "demo-tg-" + updateId;
  const sourceEventId = "demo:" + updateId;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tasks (id,source,source_event_id,owner_id,description,status,created_at,updated_at) VALUES (?,'telegram',?,?,?,'cancelled',?,?)"
  ).bind(taskId, sourceEventId, ownerId, String(prompt).slice(0, 4000), now, now).run();

  const events = buildDemoTaskEvents(taskId, String(prompt).slice(0, 4000));
  const statements = events.map((event) =>
    env.DB.prepare("INSERT OR IGNORE INTO task_events (task_id,event_type,detail,created_at) VALUES (?,?,?,?)")
      .bind(event.task_id, event.event_type, event.detail, event.created_at)
  );
  await env.DB.batch(statements);

  return [
    "TRANSACTRA · MULTI-AGENT DEMO",
    "DEMO MODE — SCRIPTED EXECUTION",
    "",
    "Task received: " + String(prompt).slice(0, 350),
    "",
    "The orchestrator decomposed the task and coordinated five specialist agents:",
    "1. Research Agent — prepared research themes.",
    "2. Analysis Agent — grouped the key trends.",
    "3. Comparison Agent — compared business impact.",
    "4. Writing Agent — drafted the executive report.",
    "5. Verification Agent — checked the scripted output.",
    "",
    "EXECUTIVE SUMMARY",
    "The demonstration report groups AI developments into five areas: increasingly capable foundation models, multimodal interfaces, agentic workflow automation, more efficient inference, and enterprise governance.",
    "",
    "BUSINESS IMPLICATIONS",
    "• Productivity: automate repeatable knowledge-work steps while keeping human review for consequential decisions.",
    "• Customer experience: use multimodal assistants to make support and service interactions more contextual.",
    "• Operations: coordinate specialist agents around bounded tasks with observable handoffs.",
    "• Risk: apply evaluation, access controls, audit trails, and clear human approval boundaries.",
    "",
    "RECOMMENDATIONS",
    "1. Start with a narrow workflow that has measurable success criteria.",
    "2. Assign specialist agents explicit responsibilities and acceptance checks.",
    "3. Track model selection, inputs, outputs, latency, and handoffs.",
    "4. Require human approval for sensitive or irreversible actions.",
    "",
    "MODEL ROUTING: pending your approved model catalogue.",
    "The website's Agent Logs now contain the scripted assignments, handoffs, and verification events.",
    "",
    "DEMO DISCLOSURE: agent actions and report content above are predefined demonstration output. No live research, model inference, or external action was performed."
  ].join("\n");
}
