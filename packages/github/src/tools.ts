import type { ToolGateway } from "../../security/src/tool-gateway.js";
import type { Action } from "../../policy/src/index.js";
import type { RiskLevel } from "../../contracts/src/index.js";
import { GitHubAppClient } from "./app-client.js";

type RepositoryInput = { repository: string };
const readAction = (): Action => ({ kind: "repository_read" });
const writeAction = (): Action => ({ kind: "repository_write" });

export function registerGitHubTools(gateway: ToolGateway, github: GitHubAppClient): void {
  gateway.register<{ name: string; description: string }, unknown>({
    capability: "github.repo.create",
    resource: (input) => "new-private-repo:" + input.name,
    action: writeAction,
    risk: (): RiskLevel => "medium",
    execute: (input, context) => {
      if (!context.taskId) throw new Error("Private project creation must be scoped to a task");
      return github.createPrivateRepository({ ...input, taskId: context.taskId });
    }
  });
  gateway.register<{ repository: string; limit?: number }, unknown>({
    capability: "github.issues.read",
    resource: (input) => "repo:" + input.repository + ":issues",
    action: readAction,
    risk: (): RiskLevel => "low",
    execute: (input) => github.listOpenIssues(input.repository, input.limit ?? 50)
  });

  gateway.register<{ repository: string; path: string; ref?: string }, unknown>({
    capability: "github.file.read",
    resource: (input) => "repo:" + input.repository + ":file:" + input.path,
    action: readAction,
    risk: (): RiskLevel => "low",
    execute: (input) => github.getFile(input.repository, input.path, input.ref ?? "main")
  });

  gateway.register<{ repository: string; title: string; body: string; labels?: string[] }, unknown>({
    capability: "github.issue.create",
    resource: (input) => "repo:" + input.repository + ":issues",
    action: writeAction,
    risk: (): RiskLevel => "medium",
    execute: (input) => github.createIssue(input)
  });

  gateway.register<{ repository: string; path: string; content: string; message: string; branch?: string; sha?: string }, unknown>({
    capability: "github.file.write",
    resource: (input) => "repo:" + input.repository + ":file:" + input.path,
    action: writeAction,
    risk: (input): RiskLevel => input.repository.toLowerCase() === "kunduruhimaneeshreddy/transactra" ? "high" : "medium",
    execute: (input) => github.putFile(input)
  });

  gateway.register<{ repository: string; branchName: string; baseBranch?: string }, unknown>({
    capability: "github.branch.create",
    resource: (input) => "repo:" + input.repository + ":branches",
    action: writeAction,
    risk: (): RiskLevel => "medium",
    execute: async (input) => { await github.createBranch(input.repository, input.branchName, input.baseBranch ?? "main"); return { created: true, branch: input.branchName }; }
  });

  gateway.register<{ repository: string; title: string; body: string; head: string; base?: string; draft?: boolean }, unknown>({
    capability: "github.pr.create",
    resource: (input) => "repo:" + input.repository + ":pull-requests",
    action: writeAction,
    risk: (): RiskLevel => "medium",
    execute: (input) => github.createPullRequest(input)
  });

  gateway.register<{ repository: string; pullNumber: number }, unknown>({
    capability: "github.pr.read",
    resource: (input) => "repo:" + input.repository + ":pull:" + input.pullNumber,
    action: readAction,
    risk: (): RiskLevel => "low",
    execute: (input) => github.getPullRequest(input.repository, input.pullNumber)
  });

  gateway.register<{ repository: string; pullNumber: number }, unknown>({
    capability: "github.pr.files.read",
    resource: (input) => "repo:" + input.repository + ":pull:" + input.pullNumber + ":files",
    action: readAction,
    risk: (): RiskLevel => "low",
    execute: (input) => github.getPullRequestFiles(input.repository, input.pullNumber)
  });

  gateway.register<{ repository: string; pullNumber: number; body: string; event: "COMMENT" | "REQUEST_CHANGES" }, unknown>({
    capability: "github.pr.review",
    resource: (input) => "repo:" + input.repository + ":pull:" + input.pullNumber,
    action: writeAction,
    risk: (): RiskLevel => "medium",
    execute: (input) => github.submitPullRequestReview(input)
  });

  gateway.register<{ repository: string; pullNumber: number; method?: "merge" | "squash" | "rebase" }, unknown>({
    capability: "github.pr.merge",
    resource: (input) => "repo:" + input.repository + ":pull:" + input.pullNumber,
    action: writeAction,
    risk: (): RiskLevel => "high",
    execute: (input) => github.mergePullRequest(input.repository, input.pullNumber, input.method ?? "squash")
  });

  gateway.register<{ repository: string; issueNumber: number; body: string }, unknown>({
    capability: "github.issue.comment",
    resource: (input) => "repo:" + input.repository + ":issue:" + input.issueNumber + ":comments",
    action: writeAction,
    risk: (): RiskLevel => "medium",
    execute: (input) => github.commentOnIssue(input)
  });

  gateway.register<{ repository: string; workflowFile?: string; limit?: number }, unknown>({
    capability: "github.actions.status",
    resource: (input) => "repo:" + input.repository + ":actions",
    action: readAction,
    risk: (): RiskLevel => "low",
    execute: (input) => github.listWorkflowRuns(input.repository, input.workflowFile, input.limit ?? 20)
  });

  gateway.register<{ repository: string; workflowFile: string; ref?: string; inputs?: Record<string, string> }, unknown>({
    capability: "github.actions.dispatch",
    resource: (input) => "repo:" + input.repository + ":workflow:" + input.workflowFile,
    action: (): Action => ({ kind: "production_deploy" }),
    risk: (): RiskLevel => "high",
    execute: (input) => github.dispatchWorkflow({
      repository: input.repository,
      workflowFile: input.workflowFile,
      ref: input.ref ?? "main",
      ...(input.inputs ? { inputs: input.inputs } : {})
    })
  });
}
