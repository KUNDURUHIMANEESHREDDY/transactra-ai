# AppDeploy export verification

This is a local, offline validation step for the AppDeploy migration bundle. It does not contact AppDeploy, read secrets, connect to PostgreSQL, or import records.

After the authenticated AppDeploy export route has been deployed and every page has been collected into one JSON file, run:

```bash
node infra/deploy/verify-appdeploy-export.mjs \
  --input ./appdeploy-export.json \
  --manifest ./appdeploy-export.manifest.json
```

The verifier requires all seven known source tables, every physical record ID, unique IDs per table, valid metadata, and no secret-bearing field names. It sorts records and object keys before computing SHA-256 so the manifest is deterministic for the same data. The manifest contains counts, byte sizes and hashes, not record bodies.

The manifest output is created with exclusive file creation and owner-only permissions. If the output path already exists, choose a new path rather than overwriting evidence.

A successful verification is **not** an import or a parity check. Destination mapping, dry-run import, count/hash reconciliation, and a restore test remain separate acceptance gates.
