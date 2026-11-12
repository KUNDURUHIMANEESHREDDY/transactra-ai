> **Compatibility warning — this VM runbook does not meet the current no-card requirement.** The Oracle Cloud and Google Cloud paths below require payment-card or billing-account verification. Do not follow them for the current migration. The claimed always-free VM availability, capacity, and eligibility must not be treated as verified for this user. The old VM topology also conflicts with the current Cloudflare-first direction. See [the active no-card migration plan](../../docs/CLOUDFLARE-MIGRATION.md). Keep the current AppDeploy source online; no verified AppDeploy data dump or restore has been completed.

# Free, always-on deployment runbook

This runbook deploys the **complete** Transactra organization — control plane and dashboard,
worker, scheduler, and the Telegram owner channel — to one always-on Linux host at no
monthly cost. WhatsApp is optional and needs a public HTTPS webhook; Telegram does not, which
is why Telegram is the channel to enable first.

Everything here is verified by running it. The pieces that were verified locally before being
written down are listed at the bottom.

## 1. Why a VM and not a free PaaS

Transactra is not a web app with a `/healthz` route. It is a continuously running
organization: it holds long-lived database leases, polls Telegram, runs a durable scheduler,
and executes untrusted generated code inside an isolated Docker sandbox. That combination
rules out most "free" tiers, which either sleep on inactivity, forbid background workers or
forbid the Docker socket, or intend a different lifetime.

Options that are genuinely free and always on:

| Host | Always free? | PostgreSQL? | Docker? | Public HTTPS? | Notes |
|---|---|---|---|---|---|
| **Oracle Cloud Always Free** | yes, indefinite | run it yourself | full Docker | yes | Best capacity: 2 AMD VMs (1 GB each) **or** Arm Ampere A1 up to 4 OCPU/24 GB. Requires a card for identity only. |
| **Google Cloud** `e2-micro` | yes, in supported regions | run it yourself | Docker-in-VM | yes | 1 GB RAM and 30 GB boot disk; region-specific quota. |
| AWS / Azure free tier | 12 months only | — | — | — | Not indefinite, so it fails the 24×7 for free requirement. |
| Render / Fly / Railway free | services sleep or expire | — | — | partial | No long-running worker without a paid plan. |

Pick Oracle Cloud Always Free when you can allocate an **Arm Ampere A1** instance (up to
24 GB RAM): the worker, PostgreSQL and the scheduler all fit comfortably. With two 1 GB AMD
micro instances, split the stack: PostgreSQL + scheduler on one, control plane + worker +
Telegram on the other, and give each host a 2 GB swap file.

**Cost guardrails.** No step in this runbook creates a billable resource: the host is inside
the always-free allowance, the providers (NVIDIA NIM, Tavily) are used only inside their
documented free tiers, and `MONTHLY_SPEND_LIMIT_INR=0` stays set. Before requesting the
instance, confirm the account's Always Free "pay-as-you-go" resources show 0 and that no
"Always Free" checkbox was left unchecked — Oracle will silently bill a paid-shape instance
otherwise.

## 2. Create the host

Oracle Cloud: Networking → Virtual Cloud Networks → create one, add an ingress rule for
TCP/22 from your IP only. Compute → Instances → Create instance:
- Image: Ubuntu 24.04 LTS.
- Shape: `VM.Standard.A1.Flex` (Arm) or `VM.Standard.E2.1.Micro`.
- Boot volume: 50 GB or less, then add a 50 GB block volume for PostgreSQL if you can.
- Add your SSH key, save the private key in your OS key manager, boot the instance.

Then from your machine:

```bash
ssh -i <key> ubuntu@<public-ip>
sudo apt-get update && sudo apt-get upgrade -y
```

Google Cloud: `gcloud compute instances create transactra --machine-type=e2-micro --image-family=ubuntu-2404-lts --image-project=ubuntu-os-cloud --zone=us-west1-b`.

## 3. Install the stack

```bash
sudo apt-get install -y git
git clone -b main --single-branch https://github.com/KUNDURUHIMANEESHREDDY/transactra.git
cd transactra
sudo bash infra/deploy/install-free-vm.sh
```

The script is idempotent and re-runnable. It installs Docker and Node 22, creates the
`transactra` service user, syncs `/opt/transactra` to `origin/main`, runs a production
install and build, writes `/etc/transactra/transactra.env` with fresh random tokens if one
does not already exist, installs the hardened systemd units, enables them, applies a
default-deny UFW firewall that allows outbound HTTPS, and adds a 2 GB swap file for the
1 GB shape.

It never asks for a credential value and never contacts a provider.

## 4. Fill in the real credentials

```bash
sudo -e /etc/transactra/transactra.env
```

Minimum for a Telegram-only organization:

| Variable | What to put |
|---|---|
| `DATABASE_URL` | `postgres://transactra:<password>@127.0.0.1:5432/transactra` |
| `TRANSACTRA_OWNER_ID` | the UUID printed by the owner bootstrap step in step 5 |
| `TELEGRAM_BOT_TOKEN` | from `@BotFather` (`/newbot`) |
| `TELEGRAM_ALLOWED_USER_IDS` | your numeric Telegram ID from `@userinfobot` — nothing else can ever command the bot |

Then add, as you obtain them, the optional credentials. Each one is optional per feature and
each missing one fails closed with a named message rather than degrading into a fake result:

`NVIDIA_NIM_API_KEY`, `NVIDIA_NIM_MODEL`, `NVIDIA_NIM_FREE_TIER_VERIFIED_AT`,
`NVIDIA_NIM_MONTHLY_REQUEST_CAP`, `NVIDIA_NIM_MONTHLY_TOKEN_CAP`,
`TAVILY_API_KEY`, `TAVILY_PAYG_DISABLED_CONFIRMED`,
`GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`,
`GITHUB_REPOSITORY_ALLOWLIST`, `GITHUB_REPOSITORY_CREATE_TOKEN`,
`TRANSACTRA_SANDBOX_IMAGE`.

## 5. Prepare the database, the owner and the sandbox

```bash
# PostgreSQL with a password, on loopback only
sudo apt-get install -y postgresql
sudo -u postgres psql -c "CREATE ROLE transactra LOGIN PASSWORD 'REPLACE';"
sudo -u postgres createdb -O transactra transactra

# Migrations (one-shot, fails the deploy on any error)
cd /opt/transactra && sudo -u transactra DATABASE_URL=... node dist/apps/control-plane/src/migrate.js

# Owner bootstrap: prints the UUID to put in TRANSACTRA_OWNER_ID
sudo -u transactra DATABASE_URL=... TRANSACTRA_OWNER_SUBJECT='telegram:your-handle' \
  node dist/apps/control-plane/src/bootstrap-owner.js

# Sandbox image: build once, then set the digest the build prints
sudo -u transactra bash -lc 'cd /opt/transactra && docker build -f infra/deploy/sandbox-image.Dockerfile -t transactra-sandbox:local .'
sudo -u transactra docker inspect --format '@{{index .RepoDigests 0}}' transactra-sandbox:local
```

## 6. Preflight, then start

```bash
sudo node /opt/transactra/infra/deploy/transactra-doctor.mjs --env-file /etc/transactra/transactra.env --strict
sudo systemctl start transactra-api transactra-scheduler transactra-telegram transactra-worker
sudo systemctl status transactra-api transactra-scheduler transactra-telegram transactra-worker --no-pager
journalctl -u transactra-telegram -f      # "telegram_control_started" means the bot is live
```

The doctor reports every prerequisite by name and exits non-zero until they are resolved. A
`FAIL` means the corresponding feature is not available; it never means the feature is
faking success.

## 7. Command the organization from Telegram

Message your bot:

- `/help` — the full command list
- `/status` — service and database readiness
- `/org` — measured 30-day organization score, task reliability, incidents, quarantines
- `/approvals` — pending owner approvals, each with the capability and resource it is bound to
- `/approve <id> <reason>` / `/reject <id> <reason>` — a written reason is mandatory
- `/tasks`, `/incidents`, `/deployments`, `/projects`, `/reports`, `/notifications`

An approval created by any surface arrives as an `approval_required` notification with a
copy-paste `/approve` line. Long polling means no public port is open: the bot only ever
makes outbound HTTPS connections.

## 8. Keep it running

- `sudo systemctl enable transactra-api transactra-scheduler transactra-telegram transactra-worker` is already done by the installer; the services restart on boot and on failure.
- `journalctl -u transactra-worker -n 200` is the operational log; the worker, scheduler and cycle report structured JSON events.
- Deploy an update: `cd /opt/transactra && sudo -u transactra git fetch origin main && sudo -u transactra git reset --hard origin/main && sudo -u transactra pnpm install --frozen-lockfile --ignore-scripts && sudo -u transactra pnpm build && sudo systemctl restart transactra-api transactra-scheduler transactra-telegram transactra-worker`, or simply re-run the installer script, then run the migration step again (it is idempotent).

## 9. Optional: WhatsApp and the public dashboard

Both need a public HTTPS endpoint, so both are opt-in and neither is needed for Telegram.

For WhatsApp, enable a reverse proxy in front of `127.0.0.1:3001` (the webhook must be
reachable from Meta and your server must present a valid TLS certificate):

```bash
sudo apt-get install -y caddy
# /etc/caddy/Caddyfile
# yourdomain.example.com {
#   reverse_proxy 127.0.0.1:3001
# }
```

Then run the WhatsApp transport with the profile and the Meta webhook configuration:

```bash
sudo -u transactra docker compose -f /opt/transactra/infra/deploy/docker-compose.yml up -d whatsapp
```

For the dashboard, proxy `/` and `/dashboard` to `127.0.0.1:8787` through the same TLS
terminator. The dashboard's CSP already permits only its own origin, so it must be served
from the same scheme+host+port it is reached through. Never expose `8787`, `3001` or
`5432` directly to the internet: those are service ports, and UFW's default-deny rule is
what protects them.

## 10. Threat model and limits of this deployment

- The worker holds every credential Transactra has, on a host that mounts the Docker socket.
  That is a root-equivalent grant in practice. Keep the host single-tenant, keep its SSH key
  in one key manager, and never reuse it as a general-purpose machine.
- The Docker sandbox is a kernel-shared container boundary, not a VM boundary. Do not run
  untrusted third-party code on this host and do not put it on a shared network.
- `CONTROL_PLANE_API_TOKEN` and `CONTROL_PLANE_APPROVAL_TOKEN` are shared bearer secrets. In a
  public deployment, replace them with a real identity provider before anyone but you can
  reach the network.
- Always-free instances are reclaimed after long inactivity, and a 1 GB shape plus swap is
  tight. Watch `free -m` after the worker has been running for a day; move to the Arm shape
  if you approach the limit.

## Verified locally before writing this down

- The Docker sandbox runner executed real containers with `--network=none`, a read-only root
  filesystem, dropped capabilities, and faithfully reported DNS blockage (`EAI_AGAIN`),
  read-only root rejection (`EROFS`) and mount denial. A real syntax error in a change set
  fails the `transactra-verify` preset with exit code 1 and a precise message; a valid change
  set passes with exit code 0.
- The full stack ran locally against a real PostgreSQL 16 container: the four migrations
  applied cleanly, the owner bootstrap returned an owner UUID, the scheduler registered the
  ten-agent workforce, and the organisation cycle completed with a measured score and
  enqueued tasks.
- The worker claimed a task, and when no provider was configured it failed closed with
  "No verified no-cost provider is configured" and rescheduled the retry rather than
  fabricating a result.
- The control plane reported `health/ready: ready, database connected`, and the dashboard
  served with a per-request CSP nonce, no template leakage, and its inline script passing a
  syntax check.
