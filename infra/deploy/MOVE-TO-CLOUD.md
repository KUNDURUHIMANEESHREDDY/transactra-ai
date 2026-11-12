# Cloud migration status — previous VM instructions withdrawn

> **Do not execute the old VM migration steps below.** They do not satisfy the owner's hard requirement of ₹0/month with no credit card.

The previous version of this document recommended Oracle Cloud and Google Cloud VMs. Those providers require payment-card or billing-account verification and are therefore disqualified for this project. The earlier text also claimed that a live PostgreSQL dump of 34 tables had been created and verified. That claim is not supported by the current evidence: the implementation ledger says no production `DATABASE_URL` was supplied and no live database migration/restore was verified. Treat that claimed dump, table count, owner UUID, and restore as unverified; do not rely on them.

The current migration decision is an event-driven Cloudflare-first architecture with explicit limits and a separate AppDeploy data export. It is **not** a drop-in VM lift-and-shift. Cloudflare Workers do not provide a persistent Node.js process, PostgreSQL server, or Docker daemon. The existing worker and sandbox must be adapted or replaced before they can run there.

Read the active plan: [Cloudflare migration and data preservation](../../docs/CLOUDFLARE-MIGRATION.md).

## Current safety state

- The existing AppDeploy application remains deployed and is not being retired.
- Its seven application-data tables have not yet been exported.
- Its secret values have not been exported or copied.
- No Cloudflare account, Worker, D1 database, Queue, Workflow, or Cron Trigger has been provisioned.
- No destination data has been imported.
- No production cutover has occurred.
- Do not run `docker compose down -v`, delete the AppDeploy app, revoke credentials, or remove source records as part of this preparation.

The repository's main-only policy remains in force: commit directly to `main`; do not create migration branches.
