# Transactra

**An always-on autonomous AI engineering organization.**

Transactra is designed as a persistent, multi-agent organization that researches opportunities, plans work, executes software engineering, validates changes, operates its infrastructure, and continuously proposes improvements under explicit security and human-approval policies.

> **Delivery target:** complete production product. The implementation stages are an engineering sequence, not a feature-reduction plan.

## Non-negotiable product constraints

- ₹0 monthly operating ceiling. No paid API fallback, automatic paid upgrade, or unapproved spend.
- Private-by-default GitHub repositories and least-privilege credentials.
- Human approval for sensitive operations (production deploys, destructive changes, permission changes, external communications beyond policy, and any action that can incur cost).
- No simulated agents, fake provider calls, placeholder integrations, or hardcoded demo data presented as live capability.
- A single long-lived Git branch: `main`. Do not create feature, staging, release, or development branches.
- Telegram and WhatsApp/local-secure access must work independently of the web dashboard.
- The web dashboard is implementation stage 11 and must be built last.

## Product departments

1. **Autonomous organization:** research, planning, execution, delegation, coordination, evaluation, and continuous operation.
2. **Multi-agent workforce:** specialized agents with scoped tools, budgets, policies, delegation, and agent lifecycle management.
3. **Engineering:** repository discovery, issue planning, code changes, tests, static analysis, review, PR lifecycle, merge policy, and deployment.
4. **Intelligence:** trend discovery, competitor research, evidence collection, opportunity scoring, and daily recommendations.
5. **Innovation:** a new project candidate every 48 hours; build only when the evidence-backed quality score is at least 90/100.
6. **Self-evolution:** identify weaknesses, propose changes, implement only within policy/approval gates, validate, and rollback safely.
7. **Operations:** persistent state, scheduling, monitoring, incident response, recovery, audit, security, memory, and provider health/failover.
8. **Control center:** Telegram, WhatsApp Business Cloud API, local access, authenticated encrypted public access, and finally the web dashboard.

## Dedicated Linux worker

The hardened systemd services and secure provisioning procedure are documented in [the Linux worker runbook](infra/worker/README.md). Installation requires a dedicated Linux host; the repository does not claim that a worker is running until the installer has passed the full test suite, applied migrations, started services and verified local readiness.

## Engineering sequence

See [docs/ROADMAP.md](docs/ROADMAP.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Current implementation status

The repository now contains substantial implementation foundations across orchestration, provider routing, agent coordination, channels, security, isolated execution, ingress and operations tooling. Many capabilities remain unverified or incomplete. A documented design or interface is **not** evidence that the corresponding runtime capability is operational. See [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) for the evidence-based ledger.

## Development

The intended runtime is TypeScript on Node.js 22+, with PostgreSQL as the durable system of record and a provider adapter boundary. The exact dependency and deployment choices must be verified against the ₹0 constraint before activation.

## Security

Never commit credentials, tokens, private keys, production data, or provider secrets. Use environment variables or a managed secret store. See [SECURITY.md](SECURITY.md).

## Local setup

Requirements: Node.js 22+, npm, and a PostgreSQL instance you control. The PostgreSQL database must be persistent and reachable from the API and worker.

1. Install dependencies: `npm install`.
2. Copy `.env.example` to `.env` and configure secrets through your local environment or secret manager.
3. Apply the schema: `npm run db:migrate`.
4. Set `TRANSACTRA_OWNER_SUBJECT` and optionally `TRANSACTRA_OWNER_DISPLAY_NAME`, then run `npm run db:bootstrap-owner`. Copy the emitted UUID into `TRANSACTRA_OWNER_ID`.
5. Generate independent random values for `CONTROL_PLANE_API_TOKEN` and `CONTROL_PLANE_APPROVAL_TOKEN`.
6. Verify NVIDIA NIM's current no-cost entitlement and quotas before configuring its environment variables. Partial NIM configuration makes the worker refuse to start; with no provider configured it starts only the provider-free departments and every inference request fails closed with a "no verified no-cost provider" error instead of falling back to a paid one.
7. Configure a GitHub App installation and repository allowlist to enable engineering agents. Without it, engineering tasks remain queued; the worker does not simulate GitHub actions.
8. For research, create a Tavily free Researcher key, verify Pay As You Go is disabled, then set `TAVILY_PAYG_DISABLED_CONFIRMED=true`. The worker enforces an 800-credit monthly hard stop.
9. For private project creation, supply a GitHub App user access token with `Repository creation: write`, set `GITHUB_REPOSITORY_OWNER`, and ensure the App installation can access newly created repositories.
10. Build and test: `npm test`.
11. Start the control plane: `npm run start:api`.
12. Start the worker separately: `npm run start:worker`.
13. Start the daily/48-hour scheduler: `npm run start:scheduler`.
14. Configure production Telegram delivery through the Cloudflare Worker only (see [docs/TELEGRAM.md](docs/TELEGRAM.md)); do not start the legacy long-polling service.
15. Configure WhatsApp Business Cloud credentials, an allowlisted sender, and the signed webhook callback before starting `npm run start:whatsapp`.
16. For isolated code execution, configure a dedicated Linux Docker host and a pre-pulled, digest-pinned sandbox image in `TRANSACTRA_SANDBOX_IMAGE`. The runner uses `--pull=never` and has not yet been integrated into the GitHub engineering loop.
17. For encrypted database backups, configure `BACKUP_DIR`, `BACKUP_ENCRYPTION_RECIPIENT`, and `DATABASE_URL`, then run `bash infra/scripts/backup-postgres.sh`. Restore is destructive and requires the explicit confirmation documented in [infra/scripts/README.md](infra/scripts/README.md).

The worker only claims departments for which real executors and required provider credentials are configured. The scheduler may enqueue intelligence and innovation tasks that remain queued until their required executors are enabled. The innovation executor creates a private project scaffold and CI workflow after both quality gates pass, but it does not yet execute generated code in an isolated sandbox.

The control plane and WhatsApp webhook listener bind to loopback by default. Do not expose either port directly to the internet. A hardened Nginx TLS reverse-proxy template is provided at [infra/nginx/transactra.conf.example](infra/nginx/transactra.conf.example); domain, certificate, firewall and host configuration are still required. See [infra/nginx/README.md](infra/nginx/README.md). API bearer authentication and the separate step-up approval token remain mandatory.

## Current implementation boundary

The repository contains code foundations for durable task storage, lease-based workers, department-scoped planning, multi-agent coordination, owner approvals, persistent full-text memory, an INR 0 provider guard, NVIDIA NIM, an optional owner-verified OpenAI-compatible secondary provider, Tavily research with a hard free-tier quota, evidence-based opportunity scoring, a 90-point private-project quality gate, daily/48-hour scheduling, and GitHub App engineering/private-repository operations. Provider circuit breakers and persisted provider-health observations are implemented. Agent step lifecycle telemetry and 30-day execution-reliability scoring are implemented, but output-quality evaluation and dynamic agent lifecycle are not. Telegram and WhatsApp channel code is present, including signed webhook verification and owner allowlists, but neither channel is verified against this repository's live runtime. A digest-pinned Docker execution primitive ([sandbox requirements](packages/sandbox/README.md)), encrypted PostgreSQL backup/restore scripts, and a hardened Nginx ingress template are committed; the Docker runner is not yet wired into engineering, and backups/ingress are not deployed. Vector/graph memory, dynamic agent lifecycle management, self-evolution, full operations automation and the final dashboard remain unfinished. See [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md).
