# GitHub App engineering integration

## Authentication model

Transactra uses a GitHub App installation token, not a personal access token. It signs a short-lived RS256 JWT with the App private key, exchanges it at the installation access-token endpoint, and caches the resulting installation token until shortly before expiry. Each token request is scoped to one repository from the explicit allowlist.

Official references:
- [GitHub App installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
- [Generating installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [Generating an RS256 JWT](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)

## Required runtime configuration

- GITHUB_APP_ID
- GITHUB_APP_INSTALLATION_ID
- GITHUB_APP_PRIVATE_KEY (secret PEM; never commit)
- GITHUB_REPOSITORY_ALLOWLIST (comma-separated owner/name values)
- DATABASE_URL (for audit and approvals)

The current code uses GitHub REST API version 2026-03-10. Installation tokens are not assumed to have a fixed length or format.

## Suggested App permissions

Grant only what the installed workflows need:
- Metadata: read
- Contents: read/write
- Issues: read/write
- Pull requests: read/write
- Checks: read

Do not grant organization administration, repository administration, Actions write, or other permissions unless a reviewed capability requires them. The runtime further scopes each installation token to one allowlisted repository.

## Implemented operations

- List open issues (excluding pull requests)
- Read UTF-8 repository files
- Create issues
- Commit/update UTF-8 files
- Create branches for allowlisted private project repositories
- Create draft pull requests
- Read pull-request metadata
- Submit review comments or change requests
- Merge only when the PR is open, non-draft, mergeable/clean, and all reported check runs have completed successfully

Every operation is routed through the capability-scoped ToolGateway. File writes and merges are high-risk and require a matching, single-use owner approval. Merge also performs independent GitHub-side mergeability and check-run checks.

## Transactra single-branch rule

The repository KUNDURUHIMANEESHREDDY/transactra is hard-coded as main-only in the GitHub client:
- File writes must target main.
- Branch creation is rejected.
- Pull-request creation and merge operations are rejected.

This preserves the explicit one-branch instruction. Other allowlisted private project repositories can use branches and PRs.

## Not yet verified

The App ID, installation ID, private key and actual installation permissions have not been supplied to this runtime. No live GitHub App API operation has been executed by Transactra itself. The connected ChatGPT GitHub integration used to commit this repository is separate from Transactra's future GitHub App credentials.

## Private project repository creation

Project creation uses a separate short-lived GitHub App user access token configured as `GITHUB_REPOSITORY_CREATE_TOKEN`. It is used only for `POST /user/repos`; all subsequent repository operations use installation tokens scoped to the new repository. Set `GITHUB_REPOSITORY_OWNER` to the exact expected account.

Grant the GitHub App the fine-grained **Repository creation: write** permission for user-authorized repository creation. GitHub documents that GitHub App user access tokens can use this endpoint with that permission. Do not substitute a broad personal access token.

Official reference: https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user

Repository names are deterministic per task (`transactra-project-<task-id-fragment>`) so a retried 48-hour task can discover its existing private repository rather than creating a duplicate. The description includes a task marker. New repositories are created private with an initial README. If the App installation cannot obtain an installation token for the new repository, the operation reports `installationAccess=not_installed` and subsequent writes remain blocked.

The user access token is currently supplied through the deployment secret environment and is not automatically refreshed by this implementation. If it expires, repository creation stops until a fresh authorized token is supplied. The App must be installed with access to newly created repositories.
