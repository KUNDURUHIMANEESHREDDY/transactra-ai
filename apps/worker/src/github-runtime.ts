import { GitHubAppClient } from "../../../packages/github/src/app-client.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(name + " is required for GitHub engineering runtime");
  return value.trim();
}

/** Creates the real GitHub App client. Tool registration is owned by the shared worker gateway. */
export function createGitHubRuntime(): { client: GitHubAppClient; close: () => Promise<void> } {
  const allowlist = required("GITHUB_REPOSITORY_ALLOWLIST").split(",").map((value) => value.trim()).filter(Boolean);
  if (allowlist.length === 0) throw new Error("GITHUB_REPOSITORY_ALLOWLIST must contain at least one repository");
  const client = new GitHubAppClient({
    appId: required("GITHUB_APP_ID"),
    installationId: required("GITHUB_APP_INSTALLATION_ID"),
    privateKeyPem: required("GITHUB_APP_PRIVATE_KEY"),
    repositoryAllowlist: allowlist,
    ...(process.env.GITHUB_REPOSITORY_CREATE_TOKEN?.trim() ? { repositoryCreationToken: process.env.GITHUB_REPOSITORY_CREATE_TOKEN.trim() } : {}),
    ...(process.env.GITHUB_REPOSITORY_OWNER?.trim() ? { repositoryOwner: process.env.GITHUB_REPOSITORY_OWNER.trim() } : {})
  });
  return { client, close: async () => undefined };
}
