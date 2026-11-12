#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_FILE:?BACKUP_FILE must point to an encrypted Transactra backup}"
: "${AGE_IDENTITY_FILE:?AGE_IDENTITY_FILE must point to the age private identity file}"

if [[ "${TRANSACTRA_RESTORE_CONFIRM:-}" != "I_UNDERSTAND_THIS_OVERWRITES_DATABASE" ]]; then
  echo "Refusing restore. Set TRANSACTRA_RESTORE_CONFIRM=I_UNDERSTAND_THIS_OVERWRITES_DATABASE after reviewing the target database." >&2
  exit 2
fi
[[ -r "$BACKUP_FILE" ]] || { echo "Backup file is not readable" >&2; exit 2; }
[[ -r "$AGE_IDENTITY_FILE" ]] || { echo "Age identity file is not readable" >&2; exit 2; }
identity_mode="$(stat -c %a "$AGE_IDENTITY_FILE")"
if (( (8#$identity_mode & 077) != 0 )); then
  echo "Age identity file must not be accessible by group or other users" >&2
  exit 2
fi
command -v age >/dev/null 2>&1 || { echo "age is required" >&2; exit 127; }
command -v pg_restore >/dev/null 2>&1 || { echo "pg_restore is required" >&2; exit 127; }

restore_dir="$(mktemp -d "${TMPDIR:-/tmp}/transactra-restore.XXXXXX")"
chmod 700 "$restore_dir"
cleanup() { rm -rf -- "$restore_dir"; }
trap cleanup EXIT
dump_file="$restore_dir/transactra.dump"

age --decrypt --identity "$AGE_IDENTITY_FILE" --output "$dump_file" "$BACKUP_FILE"
pg_restore --list "$dump_file" >/dev/null
pg_restore --clean --if-exists --no-owner --no-acl --exit-on-error --single-transaction --dbname="$DATABASE_URL" "$dump_file"
printf 'Restore completed from encrypted backup: %s\n' "$BACKUP_FILE"
