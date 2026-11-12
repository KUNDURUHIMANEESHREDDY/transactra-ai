import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { PostgresTaskStore } from "../../../packages/storage/src/postgres.js";
import { MemoryStore } from "../../../packages/storage/src/memory.js";
import { ApprovalStore } from "../../../packages/storage/src/approvals.js";
import { OrganizationStore } from "../../../packages/storage/src/organization.js";
import { IntelligenceStore } from "../../../packages/storage/src/intelligence.js";
import { AgentRegistry } from "../../../packages/agents/src/dynamic-registry.js";
import { assertNoLikelySecrets } from "../../../packages/security/src/secrets.js";
import { DASHBOARD_HTML, DASHBOARD_NONCE_PLACEHOLDER } from "./dashboard.js";

class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);
function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(name + " is required");
  return value;
}
const databaseUrl = requiredEnvironment("DATABASE_URL");
const apiToken = requiredEnvironment("CONTROL_PLANE_API_TOKEN");
const approvalToken = requiredEnvironment("CONTROL_PLANE_APPROVAL_TOKEN");
const ownerId = requiredEnvironment("TRANSACTRA_OWNER_ID");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer between 1 and 65535");
if (apiToken.length < 32) throw new Error("CONTROL_PLANE_API_TOKEN must be a random secret of at least 32 characters");
if (approvalToken.length < 32) throw new Error("CONTROL_PLANE_APPROVAL_TOKEN must be a separate random secret of at least 32 characters");
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ownerId)) throw new Error("TRANSACTRA_OWNER_ID must be set from the owner bootstrap command");

const tasks = new PostgresTaskStore(databaseUrl);
const memory = new MemoryStore(databaseUrl);
const approvals = new ApprovalStore(databaseUrl);
const organization = new OrganizationStore(databaseUrl);
const intelligence = new IntelligenceStore(databaseUrl);
const agents = new AgentRegistry(databaseUrl);

const DEPARTMENTS = ["orchestration","engineering","intelligence","innovation","operations","security","evolution"] as const;
type Department = (typeof DEPARTMENTS)[number];

const EVOLUTION_ACTIONS = ["validate","apply","rollback"] as const;
type EvolutionAction = (typeof EVOLUTION_ACTIONS)[number];

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(body));
}
function constantTimeMatch(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function authorized(request: IncomingMessage): boolean {
  const header = request.headers.authorization ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  return constantTimeMatch(supplied, apiToken);
}
function approvalAuthorized(request: IncomingMessage): boolean {
  const raw = request.headers["x-transactra-approval-token"];
  const supplied = Array.isArray(raw) ? raw[0] ?? "" : raw ?? "";
  return constantTimeMatch(supplied, approvalToken);
}
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) throw new ApiError(415, "Content-Type must be application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > 65536) throw new ApiError(413, "Request body exceeds 64 KB");
    chunks.push(part);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected JSON object");
    return value as Record<string, unknown>;
  } catch { throw new ApiError(400, "Invalid JSON object"); }
}
function textField(body: Record<string, unknown>, key: string, max: number): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ApiError(400, key + " is required and must be at most " + max + " characters");
  const normalized = value.trim();
  try {
    assertNoLikelySecrets(normalized, key);
  } catch (error) {
    // A client-supplied credential is a request error, not a server fault.
    throw new ApiError(400, error instanceof Error ? error.message : key + " is not accepted");
  }
  return normalized;
}
function uuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function limitParam(url: URL, fallback: number, max: number): number {
  const limit = Number(url.searchParams.get("limit") ?? String(fallback));
  if (!Number.isInteger(limit) || limit < 1 || limit > max) throw new ApiError(400, "limit must be an integer from 1 to " + max);
  return limit;
}
function statusParam<T extends string>(url: URL, allowed: readonly T[]): T | undefined {
  const value = url.searchParams.get("status");
  if (value === null || value === "") return undefined;
  if (!allowed.includes(value as T)) throw new ApiError(400, "status must be one of " + allowed.join(", "));
  return value as T;
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  if (request.method === "GET" && url.pathname === "/health/live") {
    send(response, 200, { status: "ok", service: "transactra-control-plane" }); return;
  }
  if (request.method === "GET" && url.pathname === "/health/ready") {
    try {
      const ready = await tasks.checkSchema();
      send(response, ready ? 200 : 503, { service:"transactra-control-plane",scope:"database-schema",status:ready?"ready":"not_ready",database:ready?"connected":"schema_missing" });
    } catch { send(response,503,{service:"transactra-control-plane",scope:"database-schema",status:"not_ready",database:"unavailable"}); }
    return;
  }
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
    const nonce = randomBytes(18).toString("base64");
    const html = DASHBOARD_HTML.replaceAll(DASHBOARD_NONCE_PLACEHOLDER,nonce);
    response.writeHead(200,{
      "content-type":"text/html; charset=utf-8",
      "cache-control":"no-store",
      "x-content-type-options":"nosniff",
      "referrer-policy":"no-referrer",
      "content-security-policy":"default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce + "'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    });
    response.end(html);
    return;
  }
  if (!url.pathname.startsWith("/v1/")) { send(response, 404, { error: "not_found" }); return; }
  if (!authorized(request)) { send(response, 401, { error: "unauthorized" }); return; }

  if (request.method === "POST" && url.pathname === "/v1/telegram/tasks") {
    const body = await readJson(request);
    const sourceEventId = textField(body, "sourceEventId", 128);
    if (!/^[0-9]{1,32}$/.test(sourceEventId)) throw new ApiError(400, "sourceEventId must be a Telegram update ID");
    const title = textField(body, "title", 200);
    const objective = textField(body, "objective", 4000);
    const idempotencyKey = "telegram:" + sourceEventId;
    const result = await tasks.enqueueAwaitingApproval({
      ownerId, title, objective, department: "orchestration", risk: "high",
      priority: 50, idempotencyKey,
      requestedBy: { id: ownerId, kind: "owner" }
    });
    send(response, result.created ? 201 : 200, {
      task: result.task,
      approval: { id: result.approval.id, status: result.approval.status, expires_at: result.approval.expires_at },
      created: result.created
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/tasks") {
    const limit = Number(url.searchParams.get("limit") ?? "50");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, "limit must be an integer from 1 to 100");
    send(response, 200, { tasks: await tasks.list(ownerId, limit) }); return;
  }
  if (request.method === "POST" && url.pathname === "/v1/tasks") {
    const body = await readJson(request);
    const title = textField(body, "title", 200);
    const objective = textField(body, "objective", 12000);
    const idempotencyKey = textField(body, "idempotencyKey", 200);
    const department = body.department;
    if (!DEPARTMENTS.includes(department as Department)) throw new ApiError(400, "department must be one of " + DEPARTMENTS.join(", "));
    const risk = body.risk ?? "low";
    if (!["low","medium","high","critical"].includes(String(risk))) throw new ApiError(400, "Invalid risk classification");
    const priority = body.priority === undefined ? 100 : Number(body.priority);
    if (!Number.isInteger(priority) || priority < 0 || priority > 1000) throw new ApiError(400, "priority must be an integer from 0 to 1000");
    const result = await tasks.enqueue({
      ownerId, title, objective, department: department as Department, risk: risk as "low" | "medium" | "high" | "critical",
      priority, idempotencyKey, requestedBy: { id: ownerId, kind: "owner" }
    });
    send(response, result.created ? 201 : 200, result); return;
  }
  if (parts[0] === "v1" && parts[1] === "tasks" && parts[2] && uuid(parts[2])) {
    const taskId = parts[2];
    if (request.method === "GET" && parts.length === 3) {
      const task = await tasks.get(ownerId, taskId);
      if (!task) throw new ApiError(404, "Task not found");
      send(response, 200, { task }); return;
    }
    if (request.method === "GET" && parts.length === 4 && parts[3] === "events") {
      const task = await tasks.get(ownerId, taskId);
      if (!task) throw new ApiError(404, "Task not found");
      send(response, 200, { events: await tasks.events(ownerId, taskId) }); return;
    }
  }
  if (request.method === "POST" && url.pathname === "/v1/memory") {
    const body = await readJson(request);
    const content = textField(body, "content", 20000);
    const sourceType = textField(body, "sourceType", 100);
    const sensitivity = body.sensitivity ?? "internal";
    if (!["public","internal","confidential"].includes(String(sensitivity))) throw new ApiError(400, "Invalid memory sensitivity");
    const item = await memory.add({
      ownerId, content, sourceType,
      ...(typeof body.projectId === "string" ? { projectId: body.projectId } : {}),
      ...(typeof body.sourceRef === "string" ? { sourceRef: body.sourceRef } : {}),
      sensitivity: sensitivity as "public" | "internal" | "confidential"
    });
    send(response, 201, { item }); return;
  }
  if (request.method === "POST" && url.pathname === "/v1/memory/search") {
    const body = await readJson(request);
    const query = textField(body, "query", 1000);
    const limit = body.limit === undefined ? 10 : Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ApiError(400, "limit must be an integer from 1 to 50");
    const projectId = typeof body.projectId === "string" ? body.projectId : undefined;
    send(response, 200, { items: await memory.search(ownerId, query, limit, projectId) }); return;
  }
  if (request.method === "DELETE" && parts[0] === "v1" && parts[1] === "memory" && parts[2] && uuid(parts[2])) {
    const deleted = await memory.delete(ownerId, parts[2]);
    if (!deleted) throw new ApiError(404, "Memory item not found");
    send(response, 200, { deleted: true }); return;
  }
  if (request.method === "GET" && url.pathname === "/v1/approvals") {
    const limit = Number(url.searchParams.get("limit") ?? "50");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, "limit must be an integer from 1 to 100");
    send(response, 200, { approvals: await approvals.listPending(ownerId, limit) }); return;
  }
  if (request.method === "POST" && url.pathname === "/v1/approvals") {
    const body = await readJson(request);
    if (!body.action || typeof body.action !== "object" || Array.isArray(body.action)) throw new ApiError(400, "action must be a JSON object");
    const taskId = typeof body.taskId === "string" && uuid(body.taskId) ? body.taskId : undefined;
    const approval = await approvals.request({ ownerId, ...(taskId ? { taskId } : {}), action: body.action, requestedBy: ownerId });
    send(response, 201, { approval }); return;
  }
  if (request.method === "POST" && parts[0] === "v1" && parts[1] === "approvals" && parts[2] && uuid(parts[2]) && parts[3] === "decision") {
    if (!approvalAuthorized(request)) throw new ApiError(403, "Separate approval credential required");
    const body = await readJson(request);
    if (body.decision !== "approved" && body.decision !== "rejected") throw new ApiError(400, "decision must be approved or rejected");
    const reason = textField(body, "reason", 2000);
    const approval = await approvals.decide({ ownerId, approvalId: parts[2], decision: body.decision, decidedBy: ownerId, reason });
    if (!approval) throw new ApiError(404, "Pending approval not found or already decided");
    send(response, 200, { approval }); return;
  }
  if (request.method === "GET" && parts[0] === "v1" && parts[1] === "agents") {
    const includeInactive = url.searchParams.get("includeInactive") === "true";
    send(response, 200, { agents: await agents.list(undefined, includeInactive) }); return;
  }
  if (request.method === "GET" && url.pathname === "/v1/organization") {
    const [evidence, incidents, cycles, deployments, proposals] = await Promise.all([
      organization.auditEvidence(ownerId),
      organization.openIncidentCounts(ownerId),
      organization.listCycles(ownerId,5),
      organization.listDeployments(ownerId,5),
      organization.listProposals(ownerId,10)
    ]);
    send(response, 200, {
      organization: { score: evidence.score, metrics: evidence.metrics },
      openIncidents: incidents,
      latestCycle: cycles[0] ?? null,
      recentDeployments: deployments,
      recentProposals: proposals
    }); return;
  }
  if (request.method === "GET" && url.pathname === "/v1/organization/cycles") {
    send(response, 200, { cycles: await organization.listCycles(ownerId,limitParam(url,20,100)) }); return;
  }
  if (request.method === "GET" && url.pathname === "/v1/organization/audits") {
    send(response, 200, { audits: await organization.listAudits(ownerId,limitParam(url,20,100)) }); return;
  }
  if (request.method === "GET" && url.pathname === "/v1/organization/evidence") {
    send(response, 200, { evidence: await organization.auditEvidence(ownerId) }); return;
  }
  if (request.method === "GET" && url.pathname === "/v1/incidents") {
    const status = statusParam(url,["open","acknowledged","resolved"] as const);
    send(response, 200, { incidents: await organization.listIncidents(ownerId,limitParam(url,50,100),status) }); return;
  }
  if (request.method === "POST" && parts[0] === "v1" && parts[1] === "incidents" && parts[2] && uuid(parts[2]) && parts[3] === "status") {
    const body = await readJson(request);
    const status = body.status;
    if (status !== "acknowledged" && status !== "resolved" && status !== "open") throw new ApiError(400, "status must be open, acknowledged or resolved");
    const incident = await organization.setIncidentStatus(ownerId,parts[2],status);
    if (!incident) throw new ApiError(404, "Incident not found");
    send(response, 200, { incident }); return;
  }
  if (request.method === "GET" && url.pathname === "/v1/notifications") {
    const status = statusParam(url,["queued","sent","failed"] as const);
    send(response, 200, { notifications: await organization.listNotifications(ownerId,limitParam(url,50,100),status) }); return;
  }
  if (request.method === "POST" && url.pathname === "/v1/notifications/ack") {
    const body = await readJson(request);
    if (!Array.isArray(body.ids)) throw new ApiError(400, "ids must be an array of notification ids");
    const ids = body.ids.filter((value): value is string => typeof value === "string");
    if (ids.length !== body.ids.length) throw new ApiError(400, "ids must be an array of notification ids");
    send(response, 200, { acknowledged: await organization.ackLocalNotifications(ownerId,ids) }); return;
  }
  if (request.method === "GET" && url.pathname === "/v1/reports") {
    send(response, 200, { reports: await intelligence.listReports(ownerId,limitParam(url,20,100)) }); return;
  }
  if (request.method === "GET" && parts[0] === "v1" && parts[1] === "reports" && parts[2] && uuid(parts[2])) {
    const report = await intelligence.getReport(ownerId,parts[2]);
    if (!report) throw new ApiError(404, "Report not found");
    send(response, 200, { report }); return;
  }
  if (request.method === "GET" && url.pathname === "/v1/opportunities") {
    const eligibleOnly = url.searchParams.get("eligible") === "true";
    send(response, 200, { opportunities: await intelligence.listOpportunities(ownerId,limitParam(url,50,100),eligibleOnly) }); return;
  }
  if (request.method === "GET" && url.pathname === "/v1/projects") {
    send(response, 200, { projects: await organization.listProjects(ownerId,limitParam(url,50,100)) }); return;
  }
  if (request.method === "GET" && parts[0] === "v1" && parts[1] === "projects" && parts[2] && uuid(parts[2])) {
    const project = await organization.getProject(ownerId,parts[2]);
    if (!project) throw new ApiError(404, "Project not found");
    send(response, 200, { project }); return;
  }
  if (request.method === "GET" && url.pathname === "/v1/deployments") {
    send(response, 200, { deployments: await organization.listDeployments(ownerId,limitParam(url,50,100)) }); return;
  }
  if (request.method === "GET" && parts[0] === "v1" && parts[1] === "deployments" && parts[2] && uuid(parts[2])) {
    const deployment = await organization.getDeployment(ownerId,parts[2]);
    if (!deployment) throw new ApiError(404, "Deployment not found");
    send(response, 200, { deployment }); return;
  }
  if (request.method === "GET" && url.pathname === "/v1/evolution/proposals") {
    const status = statusParam(url,["proposed","validated","validation_failed","awaiting_approval","applied","rolled_back","rejected"] as const);
    send(response, 200, { proposals: await organization.listProposals(ownerId,limitParam(url,50,100),status) }); return;
  }
  if (request.method === "GET" && parts[0] === "v1" && parts[1] === "evolution" && parts[2] === "proposals" && parts[3] && uuid(parts[3])) {
    const proposal = await organization.getProposal(ownerId,parts[3]);
    if (!proposal) throw new ApiError(404, "Proposal not found");
    send(response, 200, { proposal }); return;
  }
  /**
   * Applying or rolling back a self-evolution change is an approval-gated, sandbox-validated
   * action owned by the worker's tool gateway. The API never mutates the repository itself: it
   * enqueues one deterministic task that asks the evolution agent to run the exact tool, which
   * then requests the owner approval. Repeating the request is idempotent.
   */
  if (request.method === "POST" && parts[0] === "v1" && parts[1] === "evolution" && parts[2] === "proposals" && parts[3] && uuid(parts[3]) && parts[4] && EVOLUTION_ACTIONS.includes(parts[4] as EvolutionAction)) {
    const proposalId = parts[3];
    const action = parts[4] as EvolutionAction;
    const proposal = await organization.getProposal(ownerId,proposalId);
    if (!proposal) throw new ApiError(404, "Proposal not found");
    if (action === "validate" && !["proposed","validation_failed","validated"].includes(proposal.status)) throw new ApiError(409, "Proposal status " + proposal.status + " cannot be validated");
    if (action === "apply" && proposal.status !== "validated") throw new ApiError(409, "Only a validated proposal can be applied");
    if (action === "rollback" && proposal.status !== "applied") throw new ApiError(409, "Only an applied proposal can be rolled back");
    const result = await tasks.enqueue({
      ownerId,
      title: "Evolution " + action + ": " + proposal.title.slice(0,120),
      objective: "Call the evolution." + action + " tool with proposalId " + proposalId + " and report the real outcome. "
        + (action === "validate"
          ? "Validation must run in the isolated sandbox against the stored change set; never claim success without the sandbox result."
          : "The tool requests owner approval before touching the repository. If the approval is pending, report that the change is awaiting the owner and stop. Never bypass the approval, never force-push and never edit unrelated files."),
      department: "evolution",
      risk: "high",
      priority: 30,
      idempotencyKey: "api:evolution:" + action + ":" + proposalId,
      requestedBy: { id: ownerId, kind: "owner" }
    });
    send(response, result.created ? 201 : 200, { task: result.task, created: result.created, proposalId, action }); return;
  }
  send(response, 404, { error: "not_found" });
}

const server = createServer((request, response) => {
  void handle(request, response).catch((error: unknown) => {
    const status = error instanceof ApiError ? error.status : 500;
    if (status === 500) {
      const errorType = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error";
      process.stderr.write(JSON.stringify({ event: "api_error", errorType }) + "\n");
    }
    if (!response.headersSent) send(response, status, { error: status === 500 ? "internal_error" : error instanceof Error ? error.message : "request_error" });
    else response.destroy();
  });
});
server.listen(port, host, () => process.stdout.write(JSON.stringify({ event: "server_started", host, port }) + "\n"));
async function shutdown(): Promise<void> {
  server.close(() => {
    void Promise.all([tasks.close(), memory.close(), approvals.close(), organization.close(), intelligence.close(), agents.close()]).finally(() => process.exit(0));
  });
}
for (const signal of ["SIGINT","SIGTERM"] as const) process.on(signal, () => { void shutdown(); });
