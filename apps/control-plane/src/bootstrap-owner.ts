import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
const subject = process.env.TRANSACTRA_OWNER_SUBJECT;
const displayName = process.env.TRANSACTRA_OWNER_DISPLAY_NAME ?? null;
if (!connectionString) throw new Error("DATABASE_URL is required");
if (!subject?.trim()) throw new Error("TRANSACTRA_OWNER_SUBJECT is required; use a stable verified identity subject");

const pool = new Pool({ connectionString, max: 1, application_name: "transactra-owner-bootstrap" });
try {
  const result = await pool.query<{ id: string }>(
    "INSERT INTO owners(external_subject,display_name) VALUES($1,$2) ON CONFLICT(external_subject) DO UPDATE SET display_name=COALESCE(EXCLUDED.display_name,owners.display_name), status='active' RETURNING id",
    [subject.trim(), displayName]
  );
  process.stdout.write(JSON.stringify({ event: "owner_ready", ownerId: result.rows[0]?.id }) + "\n");
} finally { await pool.end(); }
