import { createSign } from "node:crypto";

export interface GitHubAppConfig {
  appId: string;
  installationId: string;
  privateKeyPem: string;
  repositoryAllowlist: readonly string[];
  repositoryCreationToken?: string;
  repositoryOwner?: string;
}
interface InstallationTokenResponse { token: string; expires_at: string; }
interface RepositoryInfo { full_name: string; private: boolean; default_branch: string; }
interface GitHubContent {
  type: string; path: string; sha: string; encoding?: string; content?: string;
}
interface GitHubIssue { number: number; title: string; body: string | null; state: string; html_url: string; pull_request?: unknown; }
interface GitHubPullRequest { number: number; html_url: string; state: string; merged: boolean; draft?: boolean; mergeable?: boolean | null; mergeable_state?: string; head?: { sha: string }; }
interface CachedToken { token: string; expiresAt: number; }
class GitHubApiError extends Error { constructor(readonly status: number) { super("GitHub API request failed with HTTP " + status); } }

const API_ROOT = "https://api.github.com";
const API_VERSION = "2026-03-10";
const TRANSACTRA_REPO = "kunduruhimaneeshreddy/transactra";

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}
function splitRepository(fullName: string): { owner: string; name: string; canonical: string } {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)\/([A-Za-z0-9_.-]{1,100})$/.exec(fullName);
  if (!match) throw new Error("Repository must be supplied as owner/name");
  return { owner: match[1]!, name: match[2]!, canonical: (match[1] + "/" + match[2]).toLowerCase() };
}
function assertWorkflowFile(workflowFile: string): void {
  if (!/^[A-Za-z0-9._/-]{1,200}\.ya?ml$/.test(workflowFile) || workflowFile.startsWith("/") || workflowFile.split("/").includes("..")) {
    throw new Error("Workflow file must be a safe repository-relative YAML path");
  }
}

export class GitHubAppClient {
  readonly #appId: string;
  readonly #installationId: string;
  readonly #privateKey: string;
  readonly #allowedRepos: Set<string>;
  readonly #repositoryCreationToken: string | undefined;
  readonly #repositoryOwner: string | undefined;
  readonly #tokens = new Map<string, CachedToken>();

  constructor(config: GitHubAppConfig) {
    if (!/^\d+$/.test(config.appId)) throw new Error("GITHUB_APP_ID must be numeric");
    if (!/^\d+$/.test(config.installationId)) throw new Error("GITHUB_APP_INSTALLATION_ID must be numeric");
    if (!config.privateKeyPem.includes("BEGIN") || !config.privateKeyPem.includes("PRIVATE KEY")) throw new Error("GITHUB_APP_PRIVATE_KEY must be a PEM private key");
    if (config.repositoryAllowlist.length === 0) throw new Error("GitHub repository allowlist cannot be empty");
    this.#appId = config.appId;
    this.#installationId = config.installationId;
    this.#privateKey = config.privateKeyPem.replace(/\\n/g, "\n");
    this.#allowedRepos = new Set(config.repositoryAllowlist.map((item) => splitRepository(item).canonical));
    this.#repositoryCreationToken = config.repositoryCreationToken?.trim();
    this.#repositoryOwner = config.repositoryOwner?.trim().toLowerCase();
    if (this.#repositoryCreationToken && !this.#repositoryOwner) throw new Error("GITHUB_REPOSITORY_OWNER is required when repository creation is enabled");
  }

  #assertAllowed(repository: string): { owner: string; name: string; canonical: string } {
    const parsed = splitRepository(repository);
    if (!this.#allowedRepos.has(parsed.canonical)) throw new Error("Repository is outside the configured GitHub allowlist");
    return parsed;
  }

  #jwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.#appId }));
    const unsigned = header + "." + payload;
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    signer.end();
    return unsigned + "." + signer.sign(this.#privateKey).toString("base64url");
  }

  async #installationToken(repository: { owner: string; name: string; canonical: string }, forceRefresh = false): Promise<string> {
    const cached = this.#tokens.get(repository.canonical);
    if (!forceRefresh && cached && cached.expiresAt > Date.now() + 5 * 60 * 1000) return cached.token;
    const response = await fetch(API_ROOT + "/app/installations/" + this.#installationId + "/access_tokens", {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: "Bearer " + this.#jwt(),
        "content-type": "application/json",
        "x-github-api-version": API_VERSION
      },
      body: JSON.stringify({ repositories: [repository.name] }),
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new GitHubApiError(response.status);
    const payload = await response.json() as InstallationTokenResponse;
    const expiresAt = Date.parse(payload.expires_at);
    if (!payload.token || !Number.isFinite(expiresAt)) throw new Error("GitHub returned an invalid installation token response");
    this.#tokens.set(repository.canonical, { token: payload.token, expiresAt });
    return payload.token;
  }

  async #request<T>(repository: { owner: string; name: string; canonical: string }, path: string, init: RequestInit = {}, retry = true): Promise<T> {
    const url = new URL(path, API_ROOT);
    if (url.origin !== API_ROOT) throw new Error("GitHub API request escaped the trusted API origin");
    const token = await this.#installationToken(repository);
    const headers = new Headers(init.headers);
    headers.set("accept", "application/vnd.github+json");
    headers.set("authorization", "Bearer " + token);
    headers.set("x-github-api-version", API_VERSION);
    headers.set("user-agent", "Transactra-Autonomous-Engineering");
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetch(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(30000) });
    if (response.status === 401 && retry) {
      this.#tokens.delete(repository.canonical);
      return this.#request<T>(repository, path, init, false);
    }
    if (!response.ok) throw new GitHubApiError(response.status);
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  async createPrivateRepository(input: { name: string; description: string; taskId: string }): Promise<{ fullName: string; htmlUrl: string; defaultBranch: string; private: true; installationAccess: "ready" | "not_installed" }> {
    if (!this.#repositoryCreationToken || !this.#repositoryOwner) throw new Error("GitHub App user access token with Repository creation: write permission is not configured");
    if (!input.taskId.trim()) throw new Error("Task ID is required for idempotent repository creation");
    const suffix = input.taskId.replace(/-/g,"").slice(0,12).toLowerCase();
    const name = "transactra-project-" + suffix;
    const marker = "[transactra-task:" + input.taskId + "]";
    const description = (input.name.trim().slice(0,80) + ": " + input.description.trim().slice(0,160) + " " + marker).trim();
    const baseUrl = API_ROOT + "/repos/" + this.#repositoryOwner + "/" + name;
    const headers = {
      accept: "application/vnd.github+json",
      authorization: "Bearer " + this.#repositoryCreationToken,
      "content-type": "application/json",
      "x-github-api-version": API_VERSION,
      "user-agent": "Transactra-Autonomous-Engineering"
    };
    const existingResponse = await fetch(baseUrl, { headers, signal: AbortSignal.timeout(20000) });
    let created: { full_name: string; html_url: string; private: boolean; default_branch: string; owner?: { login: string }; description?: string };
    if (existingResponse.ok) {
      const existing = await existingResponse.json() as typeof created;
      if (existing.private !== true || existing.owner?.login.toLowerCase() !== this.#repositoryOwner || !existing.description?.includes(marker)) {
        throw new Error("Deterministic project repository name is already occupied by an unrelated repository");
      }
      created = existing;
    } else if (existingResponse.status === 404) {
      const response = await fetch(API_ROOT + "/user/repos", {
        method: "POST", headers,
        body: JSON.stringify({ name, description, private: true, auto_init: true, has_issues: true, has_projects: false, has_wiki: false, allow_auto_merge: false }),
        signal: AbortSignal.timeout(30000)
      });
      if (!response.ok) throw new Error("Private GitHub repository creation failed with HTTP " + response.status);
      created = await response.json() as typeof created;
    } else {
      throw new Error("GitHub repository preflight failed with HTTP " + existingResponse.status);
    }
    if (created.private !== true || !created.owner?.login || created.owner.login.toLowerCase() !== this.#repositoryOwner || !created.full_name || !created.html_url) {
      throw new Error("GitHub repository is not private or does not belong to the configured owner");
    }
    const parsed = splitRepository(created.full_name);
    this.#allowedRepos.add(parsed.canonical);
    let installationAccess: "ready" | "not_installed" = "not_installed";
    try { await this.#installationToken(parsed); installationAccess = "ready"; }
    catch (error) {
      if (!(error instanceof GitHubApiError) || ![403,404].includes(error.status)) throw error;
      installationAccess = "not_installed";
    }
    return { fullName: created.full_name, htmlUrl: created.html_url, defaultBranch: created.default_branch, private: true, installationAccess };
  }

  async getRepository(repository: string): Promise<RepositoryInfo> {
    const parsed = this.#assertAllowed(repository);
    return this.#request<RepositoryInfo>(parsed, "/repos/" + parsed.owner + "/" + parsed.name);
  }

  async #assertPrivate(repository: string): Promise<{ owner: string; name: string; canonical: string }> {
    const parsed = this.#assertAllowed(repository);
    const info = await this.getRepository(repository);
    if (!info.private) throw new Error("Transactra only writes to private repositories");
    return parsed;
  }

  async listBranches(repository: string): Promise<string[]> {
    const parsed = this.#assertAllowed(repository);
    const branches = await this.#request<Array<{ name: string }>>(parsed, "/repos/" + parsed.owner + "/" + parsed.name + "/branches?per_page=100");
    return branches.map((branch) => branch.name);
  }

  async listOpenIssues(repository: string, limit = 50): Promise<GitHubIssue[]> {
    const parsed = this.#assertAllowed(repository);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Issue limit must be between 1 and 100");
    const issues = await this.#request<GitHubIssue[]>(parsed, "/repos/" + parsed.owner + "/" + parsed.name + "/issues?state=open&per_page=" + limit);
    return issues.filter((issue) => !issue.pull_request);
  }

  async createIssue(input: { repository: string; title: string; body: string; labels?: string[] }): Promise<GitHubIssue> {
    const parsed = await this.#assertPrivate(input.repository);
    if (!input.title.trim() || input.title.length > 256) throw new Error("Issue title must be between 1 and 256 characters");
    return this.#request<GitHubIssue>(parsed, "/repos/" + parsed.owner + "/" + parsed.name + "/issues", {
      method: "POST",
      body: JSON.stringify({ title: input.title, body: input.body, ...(input.labels ? { labels: input.labels } : {}) })
    });
  }

  async getPullRequest(repository: string, pullNumber: number): Promise<GitHubPullRequest> {
    const parsed = this.#assertAllowed(repository);
    return this.#request<GitHubPullRequest>(parsed, "/repos/" + parsed.owner + "/" + parsed.name + "/pulls/" + pullNumber);
  }

  async getFile(repository: string, path: string, ref = "main"): Promise<{ path: string; sha: string; content: string }> {
    const parsed = this.#assertAllowed(repository);
    if (!path.trim() || path.startsWith("/") || path.split("/").includes("..")) throw new Error("Invalid repository file path");
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const content = await this.#request<GitHubContent>(parsed, "/repos/" + parsed.owner + "/" + parsed.name + "/contents/" + encodedPath + "?ref=" + encodeURIComponent(ref));
    if (content.type !== "file" || content.encoding !== "base64" || typeof content.content !== "string") throw new Error("Requested GitHub path is not a supported text file");
    return { path: content.path, sha: content.sha, content: Buffer.from(content.content.replace(/\n/g, ""), "base64").toString("utf8") };
  }

  async putFile(input: { repository: string; path: string; content: string; message: string; branch?: string; sha?: string }): Promise<{ commitSha: string; contentSha: string }> {
    const parsed = await this.#assertPrivate(input.repository);
    const branch = input.branch ?? "main";
    if (parsed.canonical === TRANSACTRA_REPO && branch !== "main") throw new Error("Transactra repository is main-only; non-main writes are prohibited");
    if (!input.path.trim() || input.path.startsWith("/") || input.path.split("/").includes("..")) throw new Error("Invalid repository file path");
    if (!input.message.trim()) throw new Error("Commit message is required");
    if (Buffer.byteLength(input.content, "utf8") > 1_000_000) throw new Error("GitHub file write is limited to 1 MB per operation");
    const encodedPath = input.path.split("/").map(encodeURIComponent).join("/");
    let currentSha = input.sha;
    try {
      const existing = await this.getFile(input.repository,input.path,branch);
      if (existing.content === input.content) return { commitSha: "already_present", contentSha: existing.sha };
      if (currentSha && currentSha !== existing.sha) throw new Error("GitHub file SHA changed; refusing to overwrite concurrent edits");
      currentSha = existing.sha;
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
      if (currentSha) throw new Error("Specified file SHA no longer exists");
    }
    const body = {
      message: input.message,
      content: Buffer.from(input.content, "utf8").toString("base64"),
      branch,
      ...(currentSha ? { sha: currentSha } : {})
    };
    const result = await this.#request<{ commit: { sha: string }; content: { sha: string } }>(
      parsed, "/repos/" + parsed.owner + "/" + parsed.name + "/contents/" + encodedPath,
      { method: "PUT", body: JSON.stringify(body) }
    );
    return { commitSha: result.commit.sha, contentSha: result.content.sha };
  }

  async createBranch(repository: string, branchName: string, baseBranch = "main"): Promise<void> {
    const parsed = await this.#assertPrivate(repository);
    if (parsed.canonical === TRANSACTRA_REPO) throw new Error("Transactra is restricted to its single main branch");
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(branchName) || branchName === "main" || branchName.includes("..")) throw new Error("Invalid new branch name");
    const base = await this.#request<{ object: { sha: string } }>(parsed, "/repos/" + parsed.owner + "/" + parsed.name + "/git/ref/heads/" + encodeURIComponent(baseBranch));
    await this.#request(parsed, "/repos/" + parsed.owner + "/" + parsed.name + "/git/refs", {
      method: "POST",
      body: JSON.stringify({ ref: "refs/heads/" + branchName, sha: base.object.sha })
    });
  }

  async createPullRequest(input: { repository: string; title: string; body: string; head: string; base?: string; draft?: boolean }): Promise<GitHubPullRequest> {
    const parsed = await this.#assertPrivate(input.repository);
    if (parsed.canonical === TRANSACTRA_REPO) throw new Error("Transactra is main-only; pull requests requiring extra branches are disabled for this repository");
    return this.#request<GitHubPullRequest>(parsed, "/repos/" + parsed.owner + "/" + parsed.name + "/pulls", {
      method: "POST",
      body: JSON.stringify({ title: input.title, body: input.body, head: input.head, base: input.base ?? "main", draft: input.draft ?? false })
    });
  }

  async getPullRequestFiles(repository: string, pullNumber: number): Promise<Array<{ filename: string; status: string; additions: number; deletions: number; patch?: string }>> {
    const parsed = this.#assertAllowed(repository);
    if (!Number.isInteger(pullNumber) || pullNumber < 1) throw new Error("Invalid pull request number");
    return this.#request(parsed, "/repos/" + parsed.owner + "/" + parsed.name + "/pulls/" + pullNumber + "/files?per_page=100");
  }

  async submitPullRequestReview(input: { repository: string; pullNumber: number; body: string; event: "COMMENT" | "REQUEST_CHANGES" }): Promise<{ id: number; state: string; html_url: string }> {
    const parsed = await this.#assertPrivate(input.repository);
    if (parsed.canonical === TRANSACTRA_REPO) throw new Error("Transactra main-only policy prohibits pull-request review workflows");
    if (!Number.isInteger(input.pullNumber) || input.pullNumber < 1) throw new Error("Invalid pull request number");
    if (!input.body.trim() || input.body.length > 20000) throw new Error("Review body must be between 1 and 20000 characters");
    return this.#request(parsed, "/repos/" + parsed.owner + "/" + parsed.name + "/pulls/" + input.pullNumber + "/reviews", {
      method: "POST",
      body: JSON.stringify({ body: input.body, event: input.event })
    });
  }

  async commentOnIssue(input: { repository: string; issueNumber: number; body: string }): Promise<{ id: number; html_url: string; body: string }> {
    const parsed = await this.#assertPrivate(input.repository);
    if (!Number.isInteger(input.issueNumber) || input.issueNumber < 1) throw new Error("Invalid issue number");
    if (!input.body.trim() || input.body.length > 65536) throw new Error("Issue comment must be between 1 and 65536 characters");
    return this.#request(parsed, "/repos/" + parsed.owner + "/" + parsed.name + "/issues/" + input.issueNumber + "/comments", {
      method: "POST",
      body: JSON.stringify({ body: input.body })
    });
  }

  async getBranchHead(repository: string, branch = "main"): Promise<{ sha: string; branch: string }> {
    const parsed = this.#assertAllowed(repository);
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(branch) || branch.includes("..")) throw new Error("Invalid branch name");
    const ref = await this.#request<{ object: { sha: string } }>(
      parsed, "/repos/" + parsed.owner + "/" + parsed.name + "/git/ref/heads/" + encodeURIComponent(branch)
    );
    if (!/^[a-f0-9]{40}$/i.test(ref.object.sha)) throw new Error("GitHub returned an invalid commit SHA");
    return { sha: ref.object.sha, branch };
  }

  async deleteFile(input: { repository: string; path: string; message: string; branch?: string }): Promise<{ commitSha: string }> {
    const parsed = await this.#assertPrivate(input.repository);
    const branch = input.branch ?? "main";
    if (parsed.canonical === TRANSACTRA_REPO && branch !== "main") throw new Error("Transactra repository is main-only; non-main deletes are prohibited");
    if (!input.path.trim() || input.path.startsWith("/") || input.path.split("/").includes("..")) throw new Error("Invalid repository file path");
    if (!input.message.trim()) throw new Error("Commit message is required");
    const encodedPath = input.path.split("/").map(encodeURIComponent).join("/");
    const existing = await this.getFile(input.repository, input.path, branch);
    const result = await this.#request<{ commit: { sha: string } }>(
      parsed, "/repos/" + parsed.owner + "/" + parsed.name + "/contents/" + encodedPath,
      { method: "DELETE", body: JSON.stringify({ message: input.message, sha: existing.sha, branch }) }
    );
    return { commitSha: result.commit.sha };
  }

  async dispatchWorkflow(input: { repository: string; workflowFile: string; ref: string; inputs?: Record<string, string> }): Promise<{ dispatched: true; workflowFile: string; ref: string }> {
    const parsed = await this.#assertPrivate(input.repository);
    assertWorkflowFile(input.workflowFile);
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(input.ref) || input.ref.includes("..")) throw new Error("Invalid workflow ref");
    const inputs = input.inputs ?? {};
    for (const [key, value] of Object.entries(inputs)) {
      if (!/^[A-Za-z0-9_]{1,64}$/.test(key) || typeof value !== "string" || value.length > 1000) throw new Error("Workflow dispatch inputs are invalid");
    }
    const encoded = input.workflowFile.split("/").map(encodeURIComponent).join("/");
    await this.#request(parsed, "/repos/" + parsed.owner + "/" + parsed.name + "/actions/workflows/" + encoded + "/dispatches", {
      method: "POST",
      body: JSON.stringify({ ref: input.ref, inputs })
    });
    return { dispatched: true, workflowFile: input.workflowFile, ref: input.ref };
  }

  async listWorkflowRuns(repository: string, workflowFile?: string, limit = 20): Promise<Array<{ id: number; status: string; conclusion: string | null; head_sha: string; html_url: string; created_at: string; event: string }>> {
    const parsed = this.#assertAllowed(repository);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Workflow run limit must be between 1 and 100");
    const path = workflowFile
      ? (assertWorkflowFile(workflowFile), "/repos/" + parsed.owner + "/" + parsed.name + "/actions/workflows/" + workflowFile.split("/").map(encodeURIComponent).join("/") + "/runs?per_page=" + limit)
      : "/repos/" + parsed.owner + "/" + parsed.name + "/actions/runs?per_page=" + limit;
    const result = await this.#request<{ workflow_runs: Array<{ id: number; status: string; conclusion: string | null; head_sha: string; html_url: string; created_at: string; event: string }> }>(parsed, path);
    return result.workflow_runs;
  }

  async getWorkflowRun(repository: string, runId: number): Promise<{ id: number; status: string; conclusion: string | null; head_sha: string; html_url: string; created_at: string; event: string }> {
    const parsed = this.#assertAllowed(repository);
    if (!Number.isInteger(runId) || runId < 1) throw new Error("Invalid workflow run ID");
    return this.#request(parsed, "/repos/" + parsed.owner + "/" + parsed.name + "/actions/runs/" + runId);
  }

  async getCommitChecks(repository: string, ref: string): Promise<{ total_count: number; check_runs: Array<{ name: string; status: string; conclusion: string | null; html_url?: string }> }> {
    const parsed = this.#assertAllowed(repository);
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(ref) || ref.includes("..")) throw new Error("Invalid commit ref");
    return this.#request(parsed, "/repos/" + parsed.owner + "/" + parsed.name + "/commits/" + encodeURIComponent(ref) + "/check-runs?per_page=100");
  }

  async mergePullRequest(repository: string, pullNumber: number, method: "merge" | "squash" | "rebase" = "squash"): Promise<{ merged: boolean; sha: string }> {
    const parsed = await this.#assertPrivate(repository);
    if (parsed.canonical === TRANSACTRA_REPO) throw new Error("Transactra main-only policy prohibits PR branch merges");
    if (!Number.isInteger(pullNumber) || pullNumber < 1) throw new Error("Invalid pull request number");
    const pull = await this.getPullRequest(repository, pullNumber);
    if (pull.state !== "open" || pull.merged || pull.draft !== false || pull.mergeable !== true || pull.mergeable_state !== "clean" || !pull.head?.sha) {
      throw new Error("Pull request is not clean, ready, open and mergeable");
    }
    const checks = await this.#request<{ total_count: number; check_runs: Array<{ name: string; status: string; conclusion: string | null }> }>(
      parsed, "/repos/" + parsed.owner + "/" + parsed.name + "/commits/" + pull.head.sha + "/check-runs?per_page=100"
    );
    if (checks.total_count < 1 || checks.check_runs.some((check) => check.status !== "completed" || check.conclusion !== "success")) {
      throw new Error("Pull request checks are missing or not all successful; merge blocked");
    }
    const result = await this.#request<{ merged: boolean; sha: string; message: string }>(parsed, "/repos/" + parsed.owner + "/" + parsed.name + "/pulls/" + pullNumber + "/merge", {
      method: "PUT",
      body: JSON.stringify({ merge_method: method })
    });
    if (!result.merged) throw new Error("GitHub did not confirm the pull request merge");
    return { merged: result.merged, sha: result.sha };
  }
}
