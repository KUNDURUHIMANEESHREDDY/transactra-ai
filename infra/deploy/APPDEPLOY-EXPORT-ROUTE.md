# AppDeploy migration export route — deployment-ready patch

This patch is deliberately **not deployed yet**. AppDeploy's free-tier daily deployment budget is below its 16-credit minimum until **2026-11-10 00:00 UTC (05:30 IST)**. Do not retry deployment before that reset.

## Exact route patch

In the existing `backend/index.ts`, insert the following route inside the existing `router({ ... })` route map, immediately before `'GET /api/health'`. It reuses the app's existing `guard`, `TABLES`, `db`, and SDK `json/error` helpers.

```typescript
  'GET /api/migration/export': [
    ...guard,
    async ({ query }) => {
      const table = query.table;
      if (!table || !Object.values(TABLES).includes(table as (typeof TABLES)[keyof typeof TABLES])) {
        return error('Unsupported migration table', 400);
      }

      const rawLimit = query.limit ?? '3';
      if (!/^\\d+$/.test(rawLimit)) {
        return error('limit must be a positive integer', 400);
      }
      // A deliberately small page bounds read cost and response size.
      const limit = Math.min(3, Math.max(1, Number(rawLimit)));
      if (!Number.isSafeInteger(limit)) {
        return error('Invalid page size', 400);
      }

      const nextToken = query.nextToken;
      if (nextToken && nextToken.length > 8192) {
        return error('Pagination token is too long', 400);
      }

      const page = await db.list<Record<string, unknown>>(table, {
        limit,
        ...(nextToken ? { nextToken } : {}),
      });

      return json({
        schemaVersion: 1,
        source: 'appdeploy',
        table,
        items: page.items,
        nextToken: page.nextToken ?? null,
      });
    },
  ],
```

## Security and operational properties

- The existing `requireAuth()` and `requireAdminEmailAllowlist(...)` middleware must remain in front of the handler.
- The caller can select only the seven pre-existing `TABLES` values. No arbitrary table access.
- The route is GET-only and read-only. It does not mutate records or call the secret vault.
- Page size is clamped to 1–3 records to keep each response bounded. The caller must follow `nextToken` until null.
- The route never logs record bodies or pagination tokens.
- It must not be exposed as a public/unauthenticated route.
- The AppDeploy secret vault is not read by this route. The local export verifier separately rejects secret-bearing field names.

## Deployment sequence after reset

1. Read the latest stored source and confirm the route anchor is still present exactly once.
2. Use an exact single-match diff to add the route. Do not replace the whole backend file.
3. Deploy with the existing app ID `transactra-id33aw`; preserve all existing secrets and scheduled jobs.
4. Verify the existing authenticated health endpoint and all existing dashboard integrations.
5. Call the export route as the signed-in admin for each table, follow every cursor, and assemble the complete bundle.
6. Run `infra/deploy/verify-appdeploy-export.mjs` and retain its manifest.
7. Do not import or cut over until counts, IDs, hashes, schema mapping, and restore tests are verified.

## Explicit non-goals

This route does not export AppDeploy secret values, does not copy data to Cloudflare, does not create a destination database, and does not authorize retirement of the source app.
