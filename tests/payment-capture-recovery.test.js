import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../infra/migrations/0009_capture_recovery_leases.sql", import.meta.url), "utf8");

test("capture claim reclaims only stale leases and atomically renews the lease", () => {
  assert.match(server, /status='CAPTURING' AND COALESCE\(capture_started_at,updated_at\)<NOW\(\)-INTERVAL '2 minutes'/);
  assert.match(server, /SET status='CAPTURING',capture_started_at=NOW\(\),updated_at=NOW\(\)/);
});

test("PayPal capture retries use the same transaction-scoped idempotency key", () => {
  assert.match(server, /capturePayPalOrder\(orderId,tx\.id\+"-capture"\)/);
  assert.match(server, /const order=await getPayPalOrder\(orderId\)/);
  assert.match(server, /const recovered=order\.status==="COMPLETED"/);
});

test("uncertain capture failures remain recoverable instead of being marked fresh", () => {
  assert.match(server, /SET status='CAPTURE_PENDING',capture_started_at=NULL,updated_at=NOW\(\) WHERE id=\$1 AND status='CAPTURING'/);
  assert.match(server, /SET status=\$1,paypal_capture_id=\$2,capture_started_at=NULL,updated_at=NOW\(\)/);
});

test("capture lease migration is idempotent and indexes in-flight captures", () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS capture_started_at TIMESTAMPTZ/);
  assert.match(migration, /WHERE status = 'CAPTURING' AND capture_started_at IS NULL/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS payment_transactions_capture_lease_idx/);
  assert.match(migration, /0009_capture_recovery_leases/);
});

test("payment routes fail closed unless both financial hardening migrations are applied", () => {
  assert.match(server, /migrations\.rowCount!==2/);
  assert.match(server, /0008_financial_policy_hardening/);
  assert.match(server, /0009_capture_recovery_leases/);
});
