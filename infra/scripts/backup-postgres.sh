#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_DIR:?BACKUP_DIR is required}"
: "${BACKUP_ENCRYPTION_RECIPIENT:?BACKUP_ENCRYPTION_RECIPIENT must be an age recipient}"

[[ "$BACKUP_DIR" = /* ]] || { echo "BACKUP_DIR must be an absolute path" >&2; exit 2; }
command -v pg_dump >/dev/null 2>&1 || { echo "pg_dump is required" >&2; exit 127; }
command -v pg_restore >/dev/null 2>&1 || { echo "pg_restore is required" >&2; exit 127; }
command -v age >/dev/null 2>&1 || { echo "age is required" >&2; exit 127; }

retention_days="${RETENTION_DAYS:-30}"
if ! [[ "$retention_days" =~ ^[1-9][0-9]{0,2}$ ]] || (( retention_days > 365 )); then
  echo "RETENTION_DAYS must be an integer from 1 to 365" >&2
  exit 2
fi

mkdir -p -- "$BACKUP_DIR"
chmod 700 -- "$BACKUP_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
final_file="$BACKUP_DIR/transactra-$timestamp-$$.dump.age"
work_dir="$(mktemp -d "$BACKUP_DIR/.transactra-backup.XXXXXX")"
chmod 700 "$work_dir"
dump_tmp="$work_dir/dump"
encrypted_tmp="$work_dir/encrypted"
cleanup() { rm -rf -- "$work_dir"; }
trap cleanup EXIT

pg_dump --format=custom --compress=6 --no-owner --no-acl --lock-wait-timeout=10s "$DATABASE_URL" > "$dump_tmp"
pg_restore --list "$dump_tmp" >/dev/null
age --recipient "$BACKUP_ENCRYPTION_RECIPIENT" --output "$encrypted_tmp" "$dump_tmp"
test -s "$encrypted_tmp"
chmod 600 "$encrypted_tmp"
mv -- "$encrypted_tmp" "$final_file"

find "$BACKUP_DIR" -maxdepth 1 -type f -name 'transactra-*.dump.age' -mtime "+$retention_days" -delete
printf 'Encrypted backup created: %s\n' "$final_file"
