#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if (( EUID != 0 )); then
  echo "Run with: sudo bash infra/scripts/install-linux-worker.sh" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
EXPECTED_REPO="/opt/transactra"
if [[ "$REPO_ROOT" != "$EXPECTED_REPO" ]]; then
  echo "Clone the private repository to /opt/transactra before installing this worker." >&2
  exit 2
fi
cd "$REPO_ROOT"

branch="$(git branch --show-current)"
[[ "$branch" == "main" ]] || { echo "Transactra worker must be installed from the main branch only." >&2; exit 2; }
origin="$(git remote get-url origin)"
case "$origin" in
  https://github.com/KUNDURUHIMANEESHREDDY/transactra|https://github.com/KUNDURUHIMANEESHREDDY/transactra.git|git@github.com:KUNDURUHIMANEESHREDDY/transactra.git) ;;
  *) echo "Unexpected origin repository; refusing to install." >&2; exit 2 ;;
esac
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree must be clean before worker installation." >&2
  exit 2
fi

[[ -x /usr/bin/node ]] || { echo "Install Node.js 22+ at /usr/bin/node first." >&2; exit 2; }
[[ -x /usr/bin/pnpm ]] || { echo "Install pnpm 10.0.0 at /usr/bin/pnpm first." >&2; exit 2; }
node_major="$(/usr/bin/node -p 'Number(process.versions.node.split(".")[0])')"
pnpm_version="$(/usr/bin/pnpm --version)"
(( node_major >= 22 )) || { echo "Node.js 22 or newer is required." >&2; exit 2; }
[[ "$pnpm_version" == "10.0.0" ]] || { echo "pnpm 10.0.0 is required to match packageManager and CI." >&2; exit 2; }

if [[ ! -f pnpm-lock.yaml ]]; then
  echo "No committed pnpm-lock.yaml exists. Generating the repository lockfile now."
  /usr/bin/pnpm install --lockfile-only --ignore-scripts
  if [[ -n "${SUDO_USER:-}" ]]; then
    chown "$SUDO_USER:$(id -gn "$SUDO_USER")" pnpm-lock.yaml
  fi
  echo "Review and commit pnpm-lock.yaml directly to main, push it, update this clone, then rerun."
  echo "No dependencies, migrations or services were activated."
  exit 20
fi

echo "Installing locked dependencies and running the complete repository test suite..."
/usr/bin/pnpm install --frozen-lockfile --ignore-scripts
/usr/bin/pnpm test

if ! id transactra >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/transactra --create-home --shell /usr/sbin/nologin transactra
fi
install -d -o root -g root -m 0700 /etc/transactra
install -d -o transactra -g transactra -m 0750 /var/lib/transactra

ENV_FILE="/etc/transactra/transactra.env"
if [[ ! -e "$ENV_FILE" ]]; then
  install -o root -g root -m 0600 .env.example "$ENV_FILE"
  echo "Created $ENV_FILE with empty placeholders."
  echo "Populate it using: sudoedit $ENV_FILE"
  echo "Required: PostgreSQL URI, stable owner subject, NVIDIA NIM key/model, recent free-tier verification timestamp and monthly request/token caps."
  echo "The API and separate approval tokens will be generated automatically on the next run."
  echo "No database migration or service start was attempted."
  exit 21
fi
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || { echo "Environment path must be a regular file, not a symlink." >&2; exit 2; }
[[ "$(stat -c '%u' "$ENV_FILE")" == "0" ]] || { echo "Environment file must be owned by root." >&2; exit 2; }
mode="$(stat -c '%a' "$ENV_FILE")"
(( (8#$mode & 077) == 0 )) || { echo "Environment file must not grant group/other access (use chmod 600)." >&2; exit 2; }

echo "Validating secure configuration, applying migrations and bootstrapping the owner..."
bootstrap_result="$(/usr/bin/node infra/scripts/worker-bootstrap.mjs "$ENV_FILE")"
printf '%s\n' "$bootstrap_result"

chgrp -R transactra "$REPO_ROOT"
chmod -R g+rX "$REPO_ROOT"
install -o root -g root -m 0644 infra/systemd/transactra-*.service /etc/systemd/system/
systemctl daemon-reload

echo "Enabling control plane, worker and durable scheduler..."
systemctl enable --now transactra-api.service
systemctl enable --now transactra-worker.service
systemctl enable --now transactra-scheduler.service

telegram_enabled="$(printf '%s' "$bootstrap_result" | /usr/bin/node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).telegramConfigured?"true":"false"))')"
if [[ "$telegram_enabled" == "true" ]]; then
  systemctl enable --now transactra-telegram.service
else
  echo "Telegram service not started: bot token/owner allowlist not configured."
fi

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  docker_state="available"
else
  docker_state="unavailable"
fi
if [[ "$docker_state" == "available" ]]; then
  echo "Docker daemon is reachable. The sandbox runner is not yet wired into the GitHub engineering pipeline."
else
  echo "Docker daemon is not reachable. Sandbox execution remains unavailable."
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required for the final local readiness check." >&2
  exit 2
fi
ready=false
for attempt in $(seq 1 30); do
  if curl --silent --fail http://127.0.0.1:8787/health/ready >/dev/null; then ready=true; break; fi
  sleep 2
done
[[ "$ready" == "true" ]] || { echo "Control plane did not become database-ready; inspect: journalctl -u transactra-api -n 100" >&2; exit 1; }

for service in transactra-api transactra-worker transactra-scheduler; do
  systemctl is-active --quiet "$service.service" || { echo "$service is not active; inspect its local journal." >&2; exit 1; }
done

echo "Transactra Linux core services are active."
echo "Local API readiness: http://127.0.0.1:8787/health/ready"
echo "Logs: journalctl -u transactra-api -u transactra-worker -u transactra-scheduler -f"
echo "Public ingress, WhatsApp, scheduled backups and Docker engineering integration are separate activation gates."
