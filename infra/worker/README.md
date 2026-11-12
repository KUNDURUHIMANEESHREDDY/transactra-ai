# Dedicated Linux worker

This runbook installs the Transactra core runtime on a dedicated Linux host. It does not claim to deploy public ingress or enable the unfinished sandbox-to-GitHub engineering integration.

## Host prerequisites

- Ubuntu 22.04/24.04 or another systemd-based Linux distribution with systemd 247 or newer.
- Dedicated host; recommended starting point 4 vCPU, 8 GB RAM and persistent encrypted storage.
- Node.js 22+ at `/usr/bin/node`, pnpm 10.0.0 at `/usr/bin/pnpm`, Git, curl and systemd.
- Network access to the private GitHub repository, the configured PostgreSQL server and the configured no-cost provider endpoints.
- A PostgreSQL database and owner identity subject.
- NVIDIA NIM account credentials and current account-specific evidence that the selected model is available at no cost. Monthly request and token caps must be finite and positive.
- A dedicated Linux host is required for the Docker sandbox. Docker is checked by the installer but is not yet connected to the GitHub engineering execution loop.

Do not expose PostgreSQL, the control plane (8787) or the WhatsApp listener (3001) directly to the Internet.

## Clone the single-branch repository

Authenticate to GitHub using the GitHub CLI or another approved credential helper. Do not put a personal access token in the clone URL.

```bash
sudo install -d -m 0755 -o "$USER" -g "$USER" /opt/transactra
gh repo clone KUNDURUHIMANEESHREDDY/transactra /opt/transactra
cd /opt/transactra
git switch main
git status --short
```

The installer rejects any branch other than `main`, any unexpected repository origin, and any dirty working tree.

## Install and configure

Run:

```bash
sudo bash infra/scripts/install-linux-worker.sh
```

The first run may stop for one of two deliberate gates:

1. **Lockfile gate:** the repository currently has no committed pnpm lockfile. The installer generates `pnpm-lock.yaml` on the Linux host using the exact package-manager version declared in `package.json`, then exits. Review it, commit it directly to `main`, push it, update the clone, and rerun the installer. No second branch is created.
2. **Secret configuration gate:** the installer creates `/etc/transactra/transactra.env` with mode 0600 and exits. Populate it with `sudoedit /etc/transactra/transactra.env`; never commit it or paste its values into ChatGPT.

Required values:
- `DATABASE_URL`: PostgreSQL connection URI.
- `TRANSACTRA_OWNER_SUBJECT`: stable, verified owner identity subject (not a password).
- `NVIDIA_NIM_API_KEY`, `NVIDIA_NIM_MODEL`, `NVIDIA_NIM_FREE_TIER_VERIFIED_AT`, `NVIDIA_NIM_MONTHLY_REQUEST_CAP`, and `NVIDIA_NIM_MONTHLY_TOKEN_CAP`.
- `NVIDIA_NIM_FREE_TIER_VERIFIED_AT` must be a recent timestamp (within 30 days); do not attest to free access unless you have checked the actual account/model terms and quotas.

The installer uses `pnpm install --frozen-lockfile`, runs the full test suite, then generates separate random API and approval tokens if they are blank, keeps them in the root-only environment file, enforces `MONTHLY_SPEND_LIMIT_INR=0`, applies versioned migrations, and bootstraps the owner record. It writes the generated owner UUID back to the protected environment file. It does not print secret values.

Optional integrations are enabled only when fully configured:
- GitHub App ID, installation ID and private key; add the repository-creation token only when its permissions and zero-cost policy are verified.
- Tavily API key only with `TAVILY_PAYG_DISABLED_CONFIRMED=true`.
- Telegram bot token plus explicit owner user-ID allowlist.
- WhatsApp Business Cloud credentials, sender allowlist and an HTTPS `PUBLIC_BASE_URL`.

The secondary provider is optional. Leave every secondary-provider field blank until its exact model, free-tier terms and request/token caps have been independently verified. The bootstrap rejects partial secondary configuration.

Rerun the installer after editing the environment file. It re-runs locked installation and tests, applies migrations, bootstraps the owner, installs hardened systemd units, and starts the API, worker and scheduler. Telegram starts only when configured. WhatsApp is deliberately not started by this installer because its public TLS ingress and Meta webhook reachability must be configured separately.

## Verify services

```bash
systemctl status transactra-api transactra-worker transactra-scheduler
curl --fail http://127.0.0.1:8787/health/ready
journalctl -u transactra-api -u transactra-worker -u transactra-scheduler -f
```

The readiness endpoint verifies the control-plane database schema only. Confirm worker and scheduler logs separately; a running process is not proof that NIM, GitHub, Tavily or messaging integrations work.

The installer verifies the configured NIM model through the provider's `/v1/models` endpoint without sending an inference request. This confirms the API key and model listing, not the account's billing entitlement; the operator must still verify and attest to current no-cost terms and quotas. The installer never enables public ingress. Configure a domain, DNS, TLS certificate and firewall using [the Nginx ingress runbook](../nginx/README.md) before enabling WhatsApp or remote public access. Keep 8787 and 3001 bound to loopback.

## Desktop Commander remote access

If you also want this host reachable for interactive diagnostics through the registered remote-computer connection, start its Desktop Commander agent on the Linux host:

```bash
npx @wonderwhy-er/desktop-commander@latest remote
```

Then ask ChatGPT to check the device connection again. This remote-computer connection is separate from Transactra's own systemd services.

## Known activation boundaries

- The complete monorepo test suite must pass before migrations or service activation.
- The installer checks whether Docker is reachable but does not mount the Docker socket into Transactra services. The sandbox runner remains a separate execution primitive until it is integrated and tested with the GitHub engineering executor.
- No live paid-provider fallback is allowed. A configured provider must be attested as no-cost and remain inside explicit request/token caps.
- This installer does not schedule encrypted backups, configure Nginx, issue TLS certificates, open firewall ports, or certify the daily/48-hour pipeline.
- The dashboard remains stage 11 and is not needed to operate the core API, worker or scheduler.
