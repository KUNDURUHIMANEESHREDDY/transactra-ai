import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile as read, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const workflow = await readFile(new URL("../.github/workflows/production-d1-backup.yml", import.meta.url), "utf8");

test("production D1 backup is manual, main-only, and protected by the production environment", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /confirm_backup == 'BACKUP'/);
  assert.match(workflow, /environment: transactra-production/);
  assert.ok(workflow.includes("runs-on: [self-hosted, Windows, X64, transactra]"));
  assert.ok(workflow.includes('shell: powershell -ExecutionPolicy Bypass -File {0}'));
  assert.ok(workflow.includes("d1-restore-drill.mjs"));
  assert.ok(workflow.includes("pnpm install --frozen-lockfile"));
  assert.ok(workflow.includes("pnpm exec wrangler"));
  assert.ok(workflow.includes("if: always()"));
  assert.match(workflow, /secrets\.CLOUDFLARE_D1_BACKUP_TOKEN/);
  assert.match(workflow, /secrets\.D1_BACKUP_ENCRYPTION_PASSPHRASE/);
});

test("backup exports only the fixed production D1 and never migrates or deploys", () => {
  assert.match(workflow, /d1 export transactra --remote/);
  assert.match(workflow, /35047d34-b8f4-4a2a-9321-fb5b5e48e409/);
  assert.doesNotMatch(workflow, /d1 migrations apply|wrangler@4 deploy|setWebhook/i);
  assert.match(workflow, /transactra-staging/);
  assert.doesNotMatch(workflow, /pnpm dlx wrangler/);
});

test("backup encrypts before artifact upload and records hashes with bounded retention", () => {
  assert.match(workflow, /d1-backup-crypto\.mjs encrypt/);
  assert.match(workflow, /plaintext_sha256/);
  assert.match(workflow, /encrypted_sha256/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /retention-days: 30/);
  assert.match(workflow, /Remove-Item "production\.sql" -Force/);
  assert.ok(workflow.indexOf("Report backup metadata") < workflow.indexOf("Remove local backup files"));
});

test("backup encryption utility authenticates ciphertext and detects tampering", async () => {
  const dir = await mkdtemp(join(tmpdir(), "transactra-d1-backup-"));
  const input = join(dir, "source.sql");
  const encrypted = join(dir, "source.sql.enc");
  const decrypted = join(dir, "restored.sql");
  const tampered = join(dir, "tampered.enc");
  const passphrase = "a-long-test-passphrase-that-is-at-least-32-chars";
  const script = fileURLToPath(new URL("../scripts/d1-backup-crypto.mjs", import.meta.url));
  const run = (args, phrase = passphrase) => spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, D1_BACKUP_ENCRYPTION_PASSPHRASE: phrase },
  });
  try {
    await writeFile(input, "CREATE TABLE sample(id INTEGER PRIMARY KEY);\nINSERT INTO sample VALUES (7);\n");
    const enc = run(["encrypt", input, encrypted]);
    assert.equal(enc.status, 0, enc.stderr);
    const digest = run(["sha256", input]);
    assert.equal(digest.status, 0, digest.stderr);
    const dec = run(["decrypt", encrypted, decrypted, digest.stdout.trim()]);
    assert.equal(dec.status, 0, dec.stderr);
    assert.deepEqual(await read(decrypted), await read(input));
    const bytes = await read(encrypted);
    bytes[bytes.length - 1] ^= 1;
    await writeFile(tampered, bytes);
    const bad = run(["decrypt", tampered, join(dir, "bad.sql")]);
    assert.notEqual(bad.status, 0);
    const wrongKey = run(["decrypt", encrypted, join(dir, "wrong.sql")], "different-long-passphrase-that-is-at-least-32-chars");
    assert.notEqual(wrongKey.status, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("backup verification plaintext is removed even when round-trip verification fails", () => {
  const decrypt = workflow.indexOf("d1-backup-crypto.mjs decrypt production.sql.enc backup-verification.sql");
  const tryBlock = workflow.lastIndexOf("try {", decrypt);
  const finallyBlock = workflow.indexOf("finally {", decrypt);
  const cleanup = workflow.indexOf('Remove-Item "backup-verification.sql" -Force', finallyBlock);
  const manifest = workflow.indexOf("$manifest = @{", cleanup);

  assert.ok(decrypt >= 0, "authenticated decryption must run");
  assert.ok(tryBlock >= 0 && tryBlock < decrypt, "decryption must be inside try");
  assert.ok(finallyBlock > decrypt, "cleanup must be in finally");
  assert.ok(cleanup > finallyBlock, "finally must remove the decrypted dump");
  assert.ok(manifest > cleanup, "manifest creation and upload preparation must follow cleanup");
  assert.ok(workflow.slice(finallyBlock, manifest).includes('if (Test-Path "backup-verification.sql")'));
});
