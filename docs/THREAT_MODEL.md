# Transactra threat model

## Assets
Owner identity and sessions; GitHub installation credentials; provider credentials; messaging tokens; source repositories and code; project memory; approvals; audit history; deployments; private research; budget authorization state.

## Trust boundaries
1. Public network to API/webhook edge.
2. Messaging providers to inbound webhook handlers.
3. Agent runtime to tool gateway.
4. Tool gateway to GitHub, model providers, research sources and execution sandboxes.
5. Worker processes to PostgreSQL and artifact storage.
6. External research content and repository content to agent prompts.

## Principal threats and controls
| Threat | Required controls |
|---|---|
| Prompt injection in issues, webpages, source code or messages | Treat external content as data; isolate instructions; tool authorization outside model; no policy override from retrieved text |
| Credential theft or leakage | Runtime secret injection, least privilege, rotation, redaction, no secret memory, scanning |
| Unauthorized commands via Telegram/WhatsApp | Verify provider signatures/tokens, owner allowlist, replay protection, rate limiting, approval challenge |
| Agent privilege escalation | Per-agent capability grants, scoped tokens, short-lived credentials, deny-by-default gateway |
| Accidental or malicious spend | Pre-dispatch cost authorization, hard INR 0 limit, provider allowlist, no automatic paid fallback |
| Destructive GitHub changes | Explicit approval, immutable audit, protected main, no force push, private-by-default |
| Supply-chain compromise | Lockfile, dependency review, pinned CI actions, vulnerability scanning, isolated build workers |
| Data loss or corruption | Transactional writes, backups, restore drills, idempotent jobs, retention controls |
| Public endpoint abuse | TLS, authentication, origin/CSRF policy, rate limits, request size limits, security headers |
| Unsafe self-modification | Separate sandbox, regression suite, signed approval, staged rollout and rollback |

## Residual risks
Free-tier infrastructure can sleep, throttle, change quotas or remove persistence. Provider availability and free entitlements may change. These risks must be measured and documented before production activation; they must not be hidden by synthetic health responses.

The Docker coding runner is defense-in-depth, not a virtual-machine boundary: containers share the host kernel. Run it only on a dedicated Linux worker with a rootless Docker daemon; the runner checks Docker's explicit `name=rootless` security option and refuses rootful or unrecognized daemons before creating a workspace. The command uses UID/GID `0:0` inside the rootless user namespace, where it maps to the unprivileged daemon owner on the host; this is not a non-root UID inside the container namespace. Keep the image digest-pinned, do not expose the Docker socket to agents, and do not mount host credentials into the container. A stronger VM/microVM isolation boundary remains preferable for executing hostile third-party code. The source-level preflight does not replace a real-container test of effective UID/GID mapping and host-workspace permissions.

## Required verification before launch
Threat-model review; authentication and authorization tests; webhook signature tests; secret scanning; dependency scanning; restore test; incident simulation; approval replay/expiry tests; zero-spend enforcement test; and security review of each tool adapter.
