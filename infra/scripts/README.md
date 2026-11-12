# PostgreSQL backup and restore

These scripts provide encrypted, local-disk PostgreSQL backups without introducing a paid storage provider.

## Backup

Required tools: `pg_dump`, `pg_restore`, and [age](https://age-encryption.org/).

Required environment:
- `DATABASE_URL`: PostgreSQL connection string.
- `BACKUP_DIR`: directory on a durable, access-controlled volume.
- `BACKUP_ENCRYPTION_RECIPIENT`: age public recipient (never a private key).
- `RETENTION_DAYS`: optional retention from 1 to 365 days; default 30.

Run `bash infra/scripts/backup-postgres.sh`. The script creates a custom-format dump, verifies its archive directory, encrypts it, writes the final file atomically, applies restrictive permissions and prunes old Transactra backup files.

Schedule it with the host's scheduler only after the host, persistent volume and retention policy are configured. Keep the encryption identity offline or in a separate secure location; do not store it in the repository or beside the backups. The restore script rejects identity files readable by group or other users (use mode 400 or 600).

## Restore

Restore is destructive and must be performed against an explicitly selected target database. Required environment:
- `DATABASE_URL`: target PostgreSQL connection string.
- `BACKUP_FILE`: encrypted backup file.
- `AGE_IDENTITY_FILE`: readable age private identity file.
- `TRANSACTRA_RESTORE_CONFIRM=I_UNDERSTAND_THIS_OVERWRITES_DATABASE`: explicit destructive-operation acknowledgement.

Run `bash infra/scripts/restore-postgres.sh`. It decrypts into a private temporary directory, validates the dump, then performs a single-transaction restore with ownership and ACL restoration disabled.

Always perform restore drills against an isolated disposable database before relying on backups for production recovery. These scripts are not yet scheduled or runtime-verified by Transactra.

## Dedicated Linux worker

For the production worker host, systemd units, secure environment bootstrap and runtime activation procedure, follow [the dedicated Linux worker runbook](../worker/README.md) and run `sudo bash infra/scripts/install-linux-worker.sh` from `/opt/transactra`. The installer requires a committed lockfile and a clean `main` checkout; it will stop before migration or service start when either prerequisite or secure configuration is missing.
