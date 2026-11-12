import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required to run migrations");
const migrationDirectory = resolve(process.cwd(),"infra/migrations");
const pool = new Pool({ connectionString, max: 1, application_name: "transactra-migrator" });
const client = await pool.connect();
try {
  await client.query("SELECT pg_advisory_lock(246813579)");
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const files = (await readdir(migrationDirectory))
    .filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/i.test(file))
    .sort((a,b) => a.localeCompare(b));
  for (const file of files) {
    const version = file.replace(/\.sql$/i,"");
    const existing = await client.query("SELECT 1 FROM schema_migrations WHERE version=$1",[version]);
    if (existing.rowCount === 1) {
      process.stdout.write(JSON.stringify({ event: "migration_skipped", migration: version }) + "\n");
      continue;
    }
    const sql = await readFile(resolve(migrationDirectory,file),"utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT(version) DO NOTHING",[version]);
      await client.query("COMMIT");
      process.stdout.write(JSON.stringify({ event: "migration_applied", migration: version }) + "\n");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  try { await client.query("SELECT pg_advisory_unlock(246813579)"); } finally {
    client.release();
    await pool.end();
  }
}
