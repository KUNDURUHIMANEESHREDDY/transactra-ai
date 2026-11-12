import { assertNoLikelySecrets } from "../../security/src/secrets.js";
import type { EvolutionProposalRecord, OrganizationAuditMetrics, OrganizationStore } from "../../storage/src/organization.js";
import type { SandboxExecutor } from "../../sandbox/src/tools.js";
import { verifyWorkspace, type SandboxVerification } from "../../sandbox/src/tools.js";

export interface EvolutionChange {
  path: string;
  content: string;
  message: string;
}
export interface EvolutionChangeSet {
  version: 1;
  changes: EvolutionChange[];
}

export interface EvolutionRepository {
  getFile(repository: string, path: string, ref?: string): Promise<{ path: string; sha: string; content: string }>;
  putFile(input: { repository: string; path: string; content: string; message: string; branch?: string; sha?: string }): Promise<{ commitSha: string; contentSha: string }>;
  deleteFile(input: { repository: string; path: string; message: string; branch?: string }): Promise<{ commitSha: string }>;
  getCommitChecks(repository: string, ref: string): Promise<{ total_count: number; check_runs: Array<{ name: string; status: string; conclusion: string | null }> }>;
  listWorkflowRuns(repository: string, workflowFile?: string, limit?: number): Promise<Array<{ id: number; status: string; conclusion: string | null; head_sha: string; html_url: string; created_at: string; event: string }>>;
}

const FORBIDDEN_SEGMENTS = [".env", ".npmrc", ".pypirc", ".netrc", ".git-credentials"];
const FORBIDDEN_PREFIXES = [".github/", "infra/"];
const ALLOWED_INFRA_PREFIX = "infra/migrations/";
const ALLOWED_ROOTS = ["apps/", "packages/", "docs/", "tests/", "infra/migrations/"];
const MAX_CHANGES = 8;
const MAX_FILE_BYTES = 200_000;
const MAX_TOTAL_BYTES = 1_000_000;

function safePath(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new Error("Evolution change path is required");
  if (value.includes("\\") || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Evolution change path must be a safe repository-relative path");
  }
  const lower = value.toLowerCase();
  const filename = lower.split("/").pop() ?? lower;
  if (FORBIDDEN_SEGMENTS.some((segment) => filename === segment || filename.startsWith(segment + "."))) throw new Error("Evolution cannot modify secret or environment files: " + value);
  if (filename.endsWith(".pem") || filename.endsWith(".key") || filename.endsWith(".p12") || filename.endsWith(".pfx")) throw new Error("Evolution cannot modify private key material: " + value);
  if (filename === "package.json" || filename.startsWith("package-lock") || filename === "pnpm-lock.yaml" || filename === "yarn.lock") throw new Error("Evolution cannot modify dependency manifests or lockfiles: " + value);
  if (FORBIDDEN_PREFIXES.some((prefix) => lower.startsWith(prefix)) && !lower.startsWith(ALLOWED_INFRA_PREFIX)) throw new Error("Evolution cannot modify CI permissions, credentials or infrastructure: " + value);
  if (!ALLOWED_ROOTS.some((root) => lower.startsWith(root))) throw new Error("Evolution changes must stay within application, package, documentation, test or migration source: " + value);
  return value;
}

export function validateEvolutionChanges(value: unknown): EvolutionChangeSet {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Evolution changes must be a JSON object");
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.changes) || raw.changes.length < 1 || raw.changes.length > MAX_CHANGES) {
    throw new Error("Evolution changes must contain 1 to " + MAX_CHANGES + " files in schema version 1");
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const changes = raw.changes.map((item): EvolutionChange => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Evolution change must be an object");
    const entry = item as Record<string, unknown>;
    const path = safePath(entry.path as string);
    if (seen.has(path)) throw new Error("Evolution change path is duplicated: " + path);
    seen.add(path);
    if (typeof entry.content !== "string") throw new Error("Evolution change content must be UTF-8 text");
    const bytes = Buffer.byteLength(entry.content,"utf8");
    if (bytes > MAX_FILE_BYTES) throw new Error("Evolution change exceeds the per-file size limit: " + path);
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Evolution change set exceeds the total size limit");
    if (typeof entry.message !== "string" || !entry.message.trim() || entry.message.length > 200) throw new Error("Evolution change message must be between 1 and 200 characters");
    assertNoLikelySecrets(entry.content, "Evolution change content");
    return { path, content: entry.content, message: entry.message.trim() };
  });
  return { version: 1, changes };
}

export interface EvolutionValidation {
  validatedAt: string;
  syntax: SandboxVerification;
}

export interface EvolutionBaselineFile {
  path: string;
  existed: boolean;
  sha: string | null;
  content: string | null;
}
export interface EvolutionBaseline {
  capturedAt: string;
  repository: string;
  files: EvolutionBaselineFile[];
}

export interface EvolutionAuditResult {
  score: number;
  findings: Array<{ key: string; severity: "info" | "warning" | "critical"; detail: string }>;
  snapshot: Record<string, unknown>;
  metrics: OrganizationAuditMetrics;
}

export class EvolutionEngine {
  readonly #store: OrganizationStore;
  readonly #repository: EvolutionRepository;
  readonly #sandbox: SandboxExecutor;
  readonly #repositoryName: string;

  constructor(input: {
    store: OrganizationStore;
    repository: EvolutionRepository;
    sandbox: SandboxExecutor;
    repositoryName: string;
  }) {
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(input.repositoryName)) throw new Error("Evolution repository must be owner/name");
    this.#store = input.store;
    this.#repository = input.repository;
    this.#sandbox = input.sandbox;
    this.#repositoryName = input.repositoryName;
  }

  async propose(input: {
    ownerId: string; taskId?: string; auditId?: string; title: string; rationale: string;
    changes: unknown; baseline?: unknown;
  }): Promise<EvolutionProposalRecord> {
    const changes = validateEvolutionChanges(input.changes);
    return this.#store.createProposal({
      ownerId: input.ownerId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.auditId ? { auditId: input.auditId } : {}),
      title: input.title,
      rationale: input.rationale,
      changes,
      baseline: input.baseline ?? {}
    });
  }

  async validate(ownerId: string, proposalId: string): Promise<{ proposal: EvolutionProposalRecord; validation: EvolutionValidation }> {
    const proposal = await this.#store.getProposal(ownerId,proposalId);
    if (!proposal) throw new Error("Evolution proposal not found");
    if (proposal.status !== "proposed" && proposal.status !== "validation_failed") throw new Error("Only proposed or previously failed proposals can be validated");
    const changes = validateEvolutionChanges(proposal.changes);
    const files: Record<string, string> = {};
    for (const change of changes.changes) files[change.path] = change.content;
    const syntax = await verifyWorkspace(this.#sandbox,{ files, preset: "transactra-verify" });
    const validation: EvolutionValidation = { validatedAt: new Date().toISOString(), syntax };
    const updated = await this.#store.updateProposal(ownerId,proposalId,{
      status: syntax.passed ? "validated" : "validation_failed",
      validation
    });
    return { proposal: updated, validation };
  }

  async apply(input: { ownerId: string; proposalId: string; approvalId: string; actorId: string }): Promise<{ proposal: EvolutionProposalRecord; commits: Array<{ path: string; commitSha: string }> }> {
    const proposal = await this.#store.getProposal(input.ownerId,input.proposalId);
    if (!proposal) throw new Error("Evolution proposal not found");
    if (proposal.status !== "validated") throw new Error("Evolution proposal must pass sandbox validation before it can be applied");
    const validation = proposal.validation as EvolutionValidation | null;
    if (!validation?.syntax.passed) throw new Error("Evolution proposal has no passing sandbox validation record");
    const changes = validateEvolutionChanges(proposal.changes);
    const baseline: EvolutionBaseline = { capturedAt: new Date().toISOString(), repository: this.#repositoryName, files: [] };
    for (const change of changes.changes) {
      let current: { sha: string; content: string } | null = null;
      try { current = await this.#repository.getFile(this.#repositoryName,change.path,"main"); }
      catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (!/HTTP 404/.test(message)) throw error;
      }
      if (current) {
        baseline.files.push({ path: change.path, existed: true, sha: current.sha, content: current.content });
      } else {
        baseline.files.push({ path: change.path, existed: false, sha: null, content: null });
      }
    }
    await this.#store.updateProposal(input.ownerId,input.proposalId,{ baseline });
    const commits: Array<{ path: string; commitSha: string }> = [];
    for (const change of changes.changes) {
      const baselineFile = baseline.files.find((file) => file.path === change.path);
      const result = await this.#repository.putFile({
        repository: this.#repositoryName,
        path: change.path,
        content: change.content,
        message: change.message + " [transactra-evolution:" + input.proposalId + "]",
        branch: "main",
        ...(baselineFile?.sha ? { sha: baselineFile.sha } : {})
      });
      commits.push({ path: change.path, commitSha: result.commitSha });
    }
    const updated = await this.#store.updateProposal(input.ownerId,input.proposalId,{
      status: "applied",
      appliedCommits: commits,
      approvalId: input.approvalId
    });
    return { proposal: updated, commits };
  }

  async rollback(input: { ownerId: string; proposalId: string; approvalId: string; actorId: string }): Promise<{ proposal: EvolutionProposalRecord; commits: Array<{ path: string; commitSha: string }> }> {
    const proposal = await this.#store.getProposal(input.ownerId,input.proposalId);
    if (!proposal) throw new Error("Evolution proposal not found");
    if (proposal.status !== "applied") throw new Error("Only an applied proposal can be rolled back");
    const baseline = proposal.baseline as Partial<EvolutionBaseline> | null;
    if (!baseline || !Array.isArray(baseline.files) || baseline.files.length === 0) throw new Error("Evolution proposal has no captured baseline to restore");
    const commits: Array<{ path: string; commitSha: string }> = [];
    for (const file of baseline.files) {
      if (file.existed && typeof file.content === "string") {
        const result = await this.#repository.putFile({
          repository: this.#repositoryName,
          path: file.path,
          content: file.content,
          message: "Rollback evolution proposal " + input.proposalId,
          branch: "main"
        });
        commits.push({ path: file.path, commitSha: result.commitSha });
      } else if (!file.existed) {
        const result = await this.#repository.deleteFile({
          repository: this.#repositoryName,
          path: file.path,
          message: "Rollback evolution proposal " + input.proposalId,
          branch: "main"
        });
        commits.push({ path: file.path, commitSha: result.commitSha });
      } else {
        throw new Error("Evolution baseline is missing original content for " + file.path);
      }
    }
    const updated = await this.#store.updateProposal(input.ownerId,input.proposalId,{
      status: "rolled_back",
      appliedCommits: commits,
      rolledBack: true,
      approvalId: input.approvalId
    });
    return { proposal: updated, commits };
  }

  async ciStatus(ownerId: string, proposalId: string): Promise<{ proposalId: string; commits: unknown; checks: unknown; workflowRuns: unknown }> {
    const proposal = await this.#store.getProposal(ownerId,proposalId);
    if (!proposal) throw new Error("Evolution proposal not found");
    const commits = Array.isArray(proposal.applied_commits) ? proposal.applied_commits as Array<{ path: string; commitSha: string }> : [];
    const last = commits.at(-1);
    if (!last) return { proposalId, commits, checks: null, workflowRuns: await this.#repository.listWorkflowRuns(this.#repositoryName,undefined,10) };
    const [checks, workflowRuns] = await Promise.all([
      this.#repository.getCommitChecks(this.#repositoryName,last.commitSha),
      this.#repository.listWorkflowRuns(this.#repositoryName,undefined,20)
    ]);
    return {
      proposalId,
      commits,
      checks,
      workflowRuns: workflowRuns.filter((run) => run.head_sha === last.commitSha)
    };
  }

  async audit(ownerId: string, taskId?: string): Promise<EvolutionAuditResult> {
    const result = await this.#store.auditEvidence(ownerId);
    const findings: EvolutionAuditResult["findings"] = [];
    const penalty = (value: number): void => { result.score -= value; };
    if (result.metrics.failedTasks30d > 0) {
      findings.push({ key: "task-failures", severity: "warning", detail: result.metrics.failedTasks30d + " task(s) failed in the last 30 days" });
      penalty(Math.min(20,result.metrics.failedTasks30d * 2));
    }
    if (result.metrics.openCriticalIncidents > 0) {
      findings.push({ key: "critical-incidents", severity: "critical", detail: result.metrics.openCriticalIncidents + " critical incident(s) remain open" });
      penalty(Math.min(30,result.metrics.openCriticalIncidents * 10));
    }
    if (result.metrics.staleLeases > 0) {
      findings.push({ key: "stale-leases", severity: "critical", detail: result.metrics.staleLeases + " expired task lease(s)" });
      penalty(Math.min(15,result.metrics.staleLeases * 5));
    }
    if (result.metrics.pendingApprovals > 10) {
      findings.push({ key: "approval-backlog", severity: "warning", detail: result.metrics.pendingApprovals + " pending owner approvals" });
      penalty(5);
    }
    if (result.metrics.quarantinedAgents > 0) {
      findings.push({ key: "quarantined-agents", severity: "warning", detail: result.metrics.quarantinedAgents + " quarantined agent(s)" });
      penalty(5);
    }
    if (result.metrics.failedNotifications > 0) {
      findings.push({ key: "notification-failures", severity: "warning", detail: result.metrics.failedNotifications + " undelivered notification(s)" });
      penalty(5);
    }
    if (result.metrics.failedProposals > 0) {
      findings.push({ key: "failed-evolution-proposals", severity: "info", detail: result.metrics.failedProposals + " evolution proposal(s) failed validation" });
      penalty(3);
    }
    const score = Math.max(0,Math.min(100,Math.round(result.score)));
    await this.#store.createAudit({
      ownerId,
      ...(taskId ? { taskId } : {}),
      score,
      findings,
      snapshot: result.snapshot
    });
    return { score, findings, snapshot: result.snapshot, metrics: result.metrics };
  }
}
