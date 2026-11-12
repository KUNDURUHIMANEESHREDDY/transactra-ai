import { createApprovalDecisionHeaders } from "./control-plane-headers.js";

interface TaskSummary { id: string; title: string; department: string; status: string; risk: string; attempt: number; }
interface ApprovalSummary { id: string; task_id: string | null; action: unknown; expires_at: string | Date; }
interface OrganizationStatus {
  organization?: { score?: number; metrics?: Record<string, number> };
  openIncidents?: Record<string, number>;
  latestCycle?: { cycle_key?: string; status?: string; completed_at?: string | null } | null;
}
interface IncidentSummary { id: string; severity: string; status: string; title: string; }
interface DeploymentSummary { id: string; repository: string; environment: string; status: string; commit_sha: string | null; }
interface ProjectSummary { id: string; name: string; status: string; repository_full_name: string; }
interface ReportSummary { id: string; summary: string; created_at: string | Date; }

const APPROVAL_ID = /^[0-9a-f-]{36}$/i;

/**
 * Plain HTTP is only acceptable when the control plane cannot be reached by the public
 * internet: loopback, a private RFC1918 address, an IPv6 link-local/loopback address, or a
 * single-label hostname with no dot (which cannot be a real public DNS name — it only
 * resolves inside a private network such as a Docker Compose service name). Every other
 * hostname must use HTTPS, because that request carries the owner's bearer token.
 */
export function allowsPlaintextControlPlane(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (/^10(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(host)) return true;
  if (/^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/.test(host)) return true;
  if (/^169\.254(?:\.\d{1,3}){2}$/.test(host)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (!host.includes(".")) return true;
  return false;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(name + " is required");
  return value.trim();
}

/**
 * One shared command surface for every owner channel (Telegram, WhatsApp, local CLI).
 *
 * The surface is transport-agnostic: it turns a slash command into the exact control-plane
 * request and returns the text the owner receives. Channels only move bytes, so adding a
 * channel cannot drift the commands the owner can run.
 */
export class ControlSurface {
  readonly #baseUrl: URL;
  readonly #apiToken: string;
  readonly #approvalToken: string;

  constructor(input: { controlPlaneUrl: string; apiToken: string; approvalToken: string }) {
    if (!input.apiToken.trim() || !input.approvalToken.trim()) throw new Error("Control-plane credentials are required");
    this.#baseUrl = new URL(input.controlPlaneUrl);
    if (this.#baseUrl.protocol !== "https:"
      && !(this.#baseUrl.protocol === "http:" && allowsPlaintextControlPlane(this.#baseUrl.hostname))) {
      throw new Error("Control-plane URL must use HTTPS, or HTTP to a host that is not reachable from the public internet (loopback, a private RFC1918 address, or a single-label hostname)");
    }
    this.#apiToken = input.apiToken;
    this.#approvalToken = input.approvalToken;
  }

  /** Returns the reply text, or null when the command is not a control command. */
  async execute(command: string, args: readonly string[]): Promise<string | null> {
    switch (command) {
      case "/start":
      case "/help":
        return this.#help();
      case "/status": {
        const status = await this.#get<{ status?: string }>("/health/ready");
        return "Transactra readiness: " + String(status.status ?? "response received");
      }
      case "/org": {
        const status = await this.#get<OrganizationStatus>("/v1/organization");
        const metrics = status.organization?.metrics ?? {};
        const incidents = status.openIncidents ?? {};
        const cycle = status.latestCycle;
        return [
          "Transactra organisation",
          "score " + String(status.organization?.score ?? "unknown") + "/100",
          "tasks 30d " + String(metrics.succeededTasks30d ?? 0) + " ok / " + String(metrics.failedTasks30d ?? 0) + " failed",
          "agents " + String(metrics.activeAgents ?? 0) + " active / " + String(metrics.quarantinedAgents ?? 0) + " quarantined",
          "incidents " + String(incidents.critical ?? 0) + " critical / " + String(incidents.warning ?? 0) + " warning",
          "pending approvals " + String(metrics.pendingApprovals ?? 0),
          cycle ? "last cycle " + String(cycle.cycle_key ?? "") + " " + String(cycle.status ?? "") : "no cycle recorded"
        ].join("\n");
      }
      case "/tasks": {
        const result = await this.#get<{ tasks: TaskSummary[] }>("/v1/tasks?limit=10");
        const lines = result.tasks.map((task) => "[" + task.status + "] " + task.title + "\n" + task.department + " · " + task.id.slice(0,8) + " · attempt " + task.attempt);
        return lines.length ? "Recent Transactra tasks\n\n" + lines.join("\n\n") : "No tasks found.";
      }
      case "/approvals": {
        const result = await this.#get<{ approvals: ApprovalSummary[] }>("/v1/approvals?limit=10");
        const lines = result.approvals.map((approval) => {
          const action = approval.action as { capability?: string; resource?: string };
          return approval.id + "\n" + String(action.capability ?? "unknown action") + "\n" + String(action.resource ?? "resource unavailable");
        });
        return lines.length ? "Pending approvals\n\n" + lines.join("\n\n") : "No pending approvals.";
      }
      case "/approve":
      case "/reject": {
        const id = args[0];
        const reason = args.slice(1).join(" ").trim();
        if (!id || !APPROVAL_ID.test(id) || !reason) return "Usage: " + command + " <approval-id> <reason>";
        const decision = command === "/approve" ? "approved" : "rejected";
        await this.#post("/v1/approvals/" + id + "/decision",{ decision,reason },createApprovalDecisionHeaders(this.#approvalToken));
        return "Approval " + decision + ": " + id;
      }
      case "/incidents": {
        const result = await this.#get<{ incidents: IncidentSummary[] }>("/v1/incidents?limit=10");
        const lines = result.incidents.map((incident) => "[" + incident.status + "] " + incident.severity + " · " + incident.title + "\n" + incident.id);
        return lines.length ? "Incidents\n\n" + lines.join("\n\n") : "No incidents recorded.";
      }
      case "/deployments": {
        const result = await this.#get<{ deployments: DeploymentSummary[] }>("/v1/deployments?limit=10");
        const lines = result.deployments.map((deployment) => "[" + deployment.status + "] " + deployment.environment + " · " + deployment.repository + "\n" + (deployment.commit_sha ?? "no commit") + " · " + deployment.id.slice(0,8));
        return lines.length ? "Deployments\n\n" + lines.join("\n\n") : "No deployments recorded.";
      }
      case "/projects": {
        const result = await this.#get<{ projects: ProjectSummary[] }>("/v1/projects?limit=10");
        const lines = result.projects.map((project) => "[" + project.status + "] " + project.name + "\n" + project.repository_full_name);
        return lines.length ? "Innovation projects\n\n" + lines.join("\n\n") : "No projects recorded.";
      }
      case "/reports": {
        const result = await this.#get<{ reports: ReportSummary[] }>("/v1/reports?limit=5");
        const lines = result.reports.map((report) => new Date(report.created_at).toISOString().slice(0,16).replace("T"," ") + "\n" + report.summary.slice(0,600));
        return lines.length ? "Intelligence reports\n\n" + lines.join("\n\n") : "No intelligence reports recorded.";
      }
      case "/notifications": {
        const result = await this.#get<{ notifications: Array<{ status: string; kind: string; message: string; created_at: string | Date }> }>("/v1/notifications?limit=10");
        const lines = result.notifications.map((notification) => "[" + notification.status + "] " + notification.kind + "\n" + notification.message.slice(0,400));
        return lines.length ? "Notifications\n\n" + lines.join("\n\n") : "No notifications recorded.";
      }
      default:
        return null;
    }
  }

  #help(): string {
    return [
      "Transactra control",
      "/status — service readiness",
      "/org — organisation score and open work",
      "/tasks — recent tasks",
      "/approvals — pending approvals",
      "/approve <id> <reason> — approve a sensitive action",
      "/reject <id> <reason> — reject a sensitive action",
      "/incidents — open and recent incidents",
      "/deployments — recent deployments",
      "/projects — innovation projects",
      "/reports — latest intelligence reports",
      "/notifications — recent notifications"
    ].join("\n");
  }

  async #get<T>(path: string): Promise<T> {
    return this.#request<T>(path,{ method: "GET" });
  }
  async #post<T>(path: string, body: unknown, headers: Record<string,string> = {}): Promise<T> {
    return this.#request<T>(path,{ method: "POST", body: JSON.stringify(body) },headers);
  }
  async #request<T>(path: string, init: RequestInit, headers: Record<string,string> = {}): Promise<T> {
    const merged = new Headers(init.headers);
    merged.set("authorization","Bearer " + this.#apiToken);
    if (init.body) merged.set("content-type","application/json");
    for (const [key,value] of Object.entries(headers)) merged.set(key,value);
    const response = await fetch(new URL(path,this.#baseUrl),{ ...init,headers: merged,signal: init.signal ?? AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error("Transactra control plane returned HTTP " + response.status);
    return await response.json() as T;
  }
}

export function createControlSurface(): ControlSurface {
  return new ControlSurface({
    controlPlaneUrl: required("CONTROL_PLANE_URL"),
    apiToken: required("CONTROL_PLANE_API_TOKEN"),
    approvalToken: required("CONTROL_PLANE_APPROVAL_TOKEN")
  });
}
