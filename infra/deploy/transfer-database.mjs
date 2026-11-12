#!/usr/bin/env node
/**
 * Transactra database transfer.
 *
 * Moves the complete durable state — owners, the agent registry, tasks, events, approvals,
 * memory, notifications, incidents, deployments, evolution proposals and system state — from
 * one PostgreSQL instance to another. Use it to lift a locally verified organization onto an
 * always-on host without losing the owner UUID (which is bound into every credential) or the
 * workforce's history.
 *
 * Usage:
 *   node infra/deploy/transfer-database.mjs --source "$SOURCE_DATABASE_URL" --target "$TARGET_DATABASE_URL"
 *   node infra/deploy/transfer-database.mjs --source "$SOURCE" --target "$TARGET" --dry-run
 *   node infra/deploy/transfer-database.mjs --source "$SOURCE" --target "$TARGET" --data-only
 *
 * The dump never contains a credential: PostgreSQL stores no application secrets. The dump is
 * written to a path you choose, is not committed anywhere, and is deleted on request with
 * --keep-dump=false (the default).
 */
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

function parseArgs(argv) {
  const options = {
    source: null, target: null, dryRun: false, dataOnly: false, keepDump: false,
    dumpPath: null, docker: "docker", container: null, sourceContainer: null, targetContainer: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--source" && next) { options.source = next; index += 1; }
    else if (arg === "--target" && next) { options.target = next; index += 1; }
    else if (arg === "--dry-run") { options.dryRun = true; }
    else if (arg === "--data-only") { options.dataOnly = true; }
    else if (arg === "--keep-dump") { options.keepDump = true; }
    else if (arg === "--dump-path" && next) { options.dumpPath = next; index += 1; }
    else if (arg === "--docker" && next) { options.docker = next; index += 1; }
    else if (arg === "--container" && next) { options.container = next; index += 1; }
    else if (arg === "--source-container" && next) { options.sourceContainer = next; index += 1; }
    else if (arg === "--target-container" && next) { options.targetContainer = next; index += 1; }
    else if (arg === "--help" || arg === "-h") { options.help = true; }
    else throw new Error("Unknown argument: " + arg);
  }
  return options;
}

function parseDatabaseUrl(value, label) {
  if (!value) throw new Error(label + " DATABASE_URL is required");
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(label + " is not a valid connection string"); }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(label + " must be a postgres:// or postgresql:// connection string");
  }
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, "").split("?")[0] ?? "");
  if (!name) throw new Error(label + " must name a database");
  return {
    user: decodeURIComponent(parsed.username || "postgres"),
    password: decodeURIComponent(parsed.password || ""),
    host: parsed.hostname,
    port: parsed.port || "5432",
    database: name
  };
}

function redact(url) {
  return String(url).replace(/:[^:@/]+@/, ":***@");
}

function run(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    if (input !== undefined) child.stdin.end(input);
    child.once("error", (error) => reject(new Error(command + " could not be started: " + error.message)));
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(command + " " + args.join(" ") + " exited with code " + code + "\n" + stderr.trim().slice(0, 800)));
    });
  });
}

/**
 * Runs a PostgreSQL client either through `docker exec` into a container or directly against a
 * host. The container that a command runs inside is chosen per invocation: a transfer between
 * two containers on the same host must dump from one and restore into the other, so sharing a
 * single container between source and target would silently restore into the source.
 */
function clientCommand(options, target, tool, containerName) {
  if (containerName) {
    return {
      command: options.docker,
      args: ["exec", "-i", containerName, tool, "-U", target.user, "-d", target.database,
             "-h", "127.0.0.1", "-p", target.port]
    };
  }
  return {
    command: tool,
    args: ["-U", target.user, "-d", target.database, "-h", target.host, "-p", target.port],
    env: target.password ? { PGPASSWORD: target.password } : {}
  };
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write("node infra/deploy/transfer-database.mjs --source <url> --target <url> [--dry-run] [--data-only] [--container <name>]\n");
  process.exit(0);
}

const source = parseDatabaseUrl(options.source, "source");
const target = parseDatabaseUrl(options.target, "target");

process.stdout.write("source: " + redact(options.source) + "\n");
process.stdout.write("target: " + redact(options.target) + "\n");

const sourceContainer = options.sourceContainer ?? options.container;
const targetContainer = options.targetContainer ?? options.container;
const dump = clientCommand(options, source, "pg_dump", sourceContainer);
const restore = clientCommand(options, target, "psql", targetContainer);
const dumpArgs = [
  ...dump.args,
  "--no-owner", "--no-privileges", "--clean", "--if-exists",
  ...(options.dataOnly ? ["--data-only"] : [])
];

if (options.dryRun) {
  process.stdout.write("dry run: would run `" + dump.command + " " + dumpArgs.join(" ") + "` against the target `"
    + restore.command + " " + restore.args.join(" ") + "`\n");
  process.exit(0);
}

const directory = await mkdtemp(join(tmpdir(), "transactra-transfer-"));
const dumpFile = options.dumpPath ?? join(directory, "transactra-dump.sql");
try {
  const dumped = await run(dump.command, dumpArgs);
  const sql = dumped.stdout;
  if (!sql.trim()) throw new Error("The source dump was empty; check the source connection and database name");
  await writeFile(dumpFile, sql, "utf8");
  const tables = (sql.match(/CREATE TABLE ([^\s(]+)/g) ?? []).length;
  const rows = (sql.match(/^COPY /gm) ?? []).length;
  process.stdout.write("dumped " + tables + " table definition(s) and " + rows + " COPY block(s) to " + dumpFile + "\n");

  // A restore into a database that already has data must be deliberate, so require the schema
  // to be recreated by the dump itself (it carries --clean --if-exists) and report the result.
  const restored = await run(restore.command, restore.args, sql);
  if (restored.stderr && /ERROR/.test(restored.stderr)) {
    process.stderr.write("restore reported errors:\n" + restored.stderr.trim().slice(0, 1200) + "\n");
    process.exitCode = 1;
  } else {
    process.stdout.write("restored into " + redact(options.target) + "\n");
    if (!options.keepDump) process.stdout.write("(dump file kept at " + dumpFile + "; remove it after you confirm the target)\n");
  }
} finally {
  if (!options.keepDump) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}
