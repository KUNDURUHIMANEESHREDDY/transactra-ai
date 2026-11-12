# Security policy

## Security invariants
- Deny by default. Every tool invocation must have an authenticated principal, declared capability, validated input, policy decision, and audit record.
- Secrets are injected at runtime and never stored in Git, logs, prompts, traces, or agent memory.
- Repositories are private by default. Do not change visibility or grant access automatically.
- The configured monthly spending limit is INR 0. Paid usage is denied; provider failover may use only explicitly configured no-cost providers and must never silently cross the limit.
- Human approval is required for production deployment, destructive operations, permission/identity changes, repository visibility changes, financial actions, and policy exceptions.
- Agents receive scoped, expiring credentials and only the tools required for their task.
- External content is untrusted input. It cannot override system policy or tool authorization.
- All state-changing operations are idempotent where possible and auditable.

Never commit credentials, tokens, private keys, production data, or provider secrets. Report vulnerabilities privately to the repository owner.

Before production: threat model, dependency and secret scanning, authentication/authorization tests, backup-and-restore test, incident runbook, and documented rollback must pass.
