import type { DeploymentRecord, OrganizationStore } from "../../storage/src/organization.js";

export const DEPLOY_WORKFLOW_FILE = ".github/workflows/transactra-deploy.yml";

export interface WorkflowRunSummary {
  id: number;
  status: string;
  conclusion: string | null;
  head_sha: string;
  html_url: string;
  created_at: string;
  event: string;
}

/** Structural view of the real GitHub client so deployments stay testable and fail closed. */
export interface DeploymentRepository {
  getBranchHead(repository: string, branch?: string): Promise<{ sha: string; branch: string }>;
  dispatchWorkflow(input: { repository: string; workflowFile: string; ref: string; inputs?: Record<string, string> }): Promise<{ dispatched: true; workflowFile: string; ref: string }>;
  listWorkflowRuns(repository: string, workflowFile?: string, limit?: number): Promise<WorkflowRunSummary[]>;
}

export interface DeploymentDispatchInput {
  ownerId: string;
  taskId?: string;
  repository: string;
  environment: "staging" | "production";
  commitSha?: string;
  approvalId?: string;
  actorId: string;
  workflowFile?: string;
}

export interface DeploymentStatusResult {
  deployment: DeploymentRecord;
  workflowRun: WorkflowRunSummary | null;
  runs: WorkflowRunSummary[];
}

export class DeploymentEngine {
  readonly #store: OrganizationStore;
  readonly #repository: DeploymentRepository;
  readonly #defaultWorkflowFile: string;

  constructor(input: { store: OrganizationStore; repository: DeploymentRepository; workflowFile?: string }) {
    this.#store = input.store;
    this.#repository = input.repository;
    this.#defaultWorkflowFile = input.workflowFile ?? DEPLOY_WORKFLOW_FILE;
    if (!/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(this.#defaultWorkflowFile)) {
      throw new Error("Deployment workflow file must be a repository workflow path");
    }
  }

  async dispatch(input: DeploymentDispatchInput): Promise<{ deployment: DeploymentRecord; commitSha: string; environment: "staging" | "production" }> {
    const environment = input.environment;
    const workflowFile = input.workflowFile ?? this.#defaultWorkflowFile;
    const head = input.commitSha
      ? { sha: input.commitSha }
      : await this.#repository.getBranchHead(input.repository, "main");
    if (!/^[a-f0-9]{40}$/i.test(head.sha)) throw new Error("Deployment requires a full 40-character commit SHA");
    const deployment = await this.#store.createDeployment({
      ownerId: input.ownerId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      repository: input.repository,
      environment,
      workflowFile,
      commitSha: head.sha,
      ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      requestedBy: input.actorId,
      details: { requestedAt: new Date().toISOString() }
    });
    try {
      await this.#repository.dispatchWorkflow({
        repository: input.repository,
        workflowFile,
        ref: "main",
        inputs: { environment, commit_sha: head.sha }
      });
    } catch (error) {
      await this.#store.updateDeployment(input.ownerId, deployment.id, {
        status: "failed",
        details: { message: error instanceof Error ? error.message : "workflow dispatch failed" }
      });
      throw error;
    }
    const updated = await this.#store.updateDeployment(input.ownerId, deployment.id, { status: "dispatched" });
    return { deployment: updated, commitSha: head.sha, environment };
  }

  async status(ownerId: string, deploymentId: string): Promise<DeploymentStatusResult> {
    const deployment = await this.#store.getDeployment(ownerId, deploymentId);
    if (!deployment) throw new Error("Deployment not found");
    const runs = await this.#repository.listWorkflowRuns(deployment.repository, deployment.workflow_file, 30);
    const matching = deployment.commit_sha
      ? runs.filter((run) => run.head_sha === deployment.commit_sha)
      : [];
    const workflowRun = matching.find((run) => run.status !== "completed") ?? matching[0] ?? null;
    if (workflowRun && deployment.status !== "rolled_back") {
      const status = workflowRun.status === "completed"
        ? (workflowRun.conclusion === "success" ? "succeeded" : "failed")
        : "in_progress";
      if (status !== deployment.status) {
        return {
          deployment: await this.#store.updateDeployment(ownerId, deployment.id, {
            status,
            workflowRunId: String(workflowRun.id),
            details: { htmlUrl: workflowRun.html_url, conclusion: workflowRun.conclusion }
          }),
          workflowRun,
          runs: matching
        };
      }
    }
    return { deployment, workflowRun, runs: matching };
  }

  /** Re-dispatches the previous verified commit for the same repository and environment. */
  async rollback(input: {
    ownerId: string; deploymentId: string; approvalId: string; actorId: string;
  }): Promise<{ deployment: DeploymentRecord; previous: DeploymentRecord; commitSha: string }> {
    const failed = await this.#store.getDeployment(input.ownerId, input.deploymentId);
    if (!failed) throw new Error("Deployment not found");
    if (failed.status === "rolled_back") throw new Error("Deployment has already been rolled back");
    const previous = await this.#store.lastSuccessfulDeployment(input.ownerId, failed.repository, failed.environment);
    if (!previous || !previous.commit_sha) throw new Error("No successful deployment exists to roll back to");
    if (previous.commit_sha === failed.commit_sha) throw new Error("No earlier successful commit is available for rollback");
    const deployment = await this.#store.createDeployment({
      ownerId: input.ownerId,
      ...(failed.task_id ? { taskId: failed.task_id } : {}),
      repository: failed.repository,
      environment: failed.environment,
      workflowFile: failed.workflow_file,
      commitSha: previous.commit_sha,
      approvalId: input.approvalId,
      requestedBy: input.actorId,
      details: { rollbackOf: failed.id, previousDeployment: previous.id }
    });
    await this.#repository.dispatchWorkflow({
      repository: failed.repository,
      workflowFile: failed.workflow_file,
      ref: "main",
      inputs: { environment: failed.environment, commit_sha: previous.commit_sha }
    });
    await this.#store.updateDeployment(input.ownerId, failed.id, { status: "rolled_back" });
    return {
      deployment: await this.#store.updateDeployment(input.ownerId, deployment.id, { status: "dispatched" }),
      previous,
      commitSha: previous.commit_sha
    };
  }
}
