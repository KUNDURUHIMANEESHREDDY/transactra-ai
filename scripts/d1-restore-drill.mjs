import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const dump = resolve(process.argv[2] ?? "backup-verification.sql");
const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
const root = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "transactra-d1-restore-"));
const state = join(root, "state");
const config = join(root, "wrangler.toml");
const importFile = join(root, "restore-import.sql");

function wrangler(args) {
  const argv = ["exec", "wrangler", "d1", "execute", "transactra-d1-restore-drill", ...args, "--config", config, "--persist-to", state];
  const command = process.platform === "win32" ? "powershell.exe" : "pnpm";
  const commandArgs = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-Command", "& pnpm " + argv.map((arg) => "'" + arg.replaceAll("'", "''") + "'").join(" ") + "; exit $LASTEXITCODE"]
    : argv;
  const result = spawnSync(command, commandArgs, { cwd: workspace, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error("Local D1 restore command failed (" + result.status + "): " + (result.error?.message || result.stderr || result.stdout));
  }
  return result.stdout;
}

try {
  let sql = await readFile(dump, "utf8");
  sql = sql.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim().toUpperCase();
    return !trimmed.startsWith("PRAGMA FOREIGN_KEYS") &&
      trimmed !== "BEGIN;" && trimmed !== "BEGIN TRANSACTION;" && trimmed !== "COMMIT;";
  }).join("\n");
  await writeFile(importFile, sql, { mode: 0o600 });

  const main = join(workspace, "infra/cloudflare/src/index.mjs").split(String.fromCharCode(92)).join("/");
  await writeFile(config, [
    'name = "transactra-d1-restore-drill"',
    'main = "' + main + '"',
    'compatibility_date = "2026-11-09"',
    "",
    "[[d1_databases]]",
    'binding = "DB"',
    'database_name = "transactra-d1-restore-drill"',
    'database_id = "00000000-0000-4000-8000-000000000001"',
    "",
  ].join(String.fromCharCode(10)), { mode: 0o600 });

  wrangler(["--local", "--file", importFile]);
  const tables = [
    "inbound_events", "runtime_heartbeats", "telegram_reply_outbox", "tasks",
    "task_events", "task_runs", "task_run_events", "execution_plans",
    "inference_quota_daily", "agent_memory", "task_memory", "orchestrator_jobs",
    "orchestrator_events", "task_approvals", "orchestrator_step_runs",
    "orchestrator_step_approvals", "memory_usage_monthly", "memory_compaction_state",
    "memory_archives", "memory_sync_outbox",
  ];
  const query = tables.map((table) => "SELECT COUNT(*) AS row_count FROM " + table).join(";");
  const results = JSON.parse(wrangler(["--local", "--command", query, "--json"]));
  if (!Array.isArray(results) || results.length !== tables.length ||
      results.some((item) => item.success !== true || item.results?.length !== 1 ||
        !Number.isInteger(item.results[0].row_count) || item.results[0].row_count < 0)) {
    throw new Error("Restored D1 did not pass all 20 application-table read checks.");
  }
  console.log("ISOLATED_D1_RESTORE_DRILL_PASSED: all 20 application tables are readable in a disposable local D1 database.");
} finally {
  await rm(root, { recursive: true, force: true });
}
