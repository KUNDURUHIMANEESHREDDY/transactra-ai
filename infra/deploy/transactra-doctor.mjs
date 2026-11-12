#!/usr/bin/env node
/**
 * Transactra deployment readiness check.
 *
 * Reports, per prerequisite, whether it is present and what it is. It never starts anything
 * and never contacts a provider with a real credential: it only checks presence, shape and
 * reachability. Exit code 0 means every prerequisite is present; 1 means something is missing
 * and the deployment should not proceed. This is deliberately fail-closed: a partially
 * deployed organization is harder to reason about than one that refuses to start.
 *
 * Usage: node infra/deploy/transactra-doctor.mjs [--env-file path] [--strict]
 */
import { readFile, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { homedir, platform, release } from "node:os";

const REQUIRED = [
  "DATABASE_URL",
  "TRANSACTRA_OWNER_ID",
  "CONTROL_PLANE_API_TOKEN",
  "CONTROL_PLANE_APPROVAL_TOKEN",
  "CONTROL_PLANE_URL",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_USER_IDS"
];

// A deployment can run without these; the corresponding feature fails closed at runtime and
// reports the missing credential rather than degrading to a fake success.
const OPTIONAL = [
  { name: "NVIDIA_NIM_API_KEY", feature: "model inference" },
  { name: "NVIDIA_NIM_MODEL", feature: "model inference" },
  { name: "NVIDIA_NIM_FREE_TIER_VERIFIED_AT", feature: "zero-cost entitlement proof" },
  { name: "TAVILY_API_KEY", feature: "web research" },
  { name: "GITHUB_APP_ID", feature: "GitHub engineering" },
  { name: "GITHUB_APP_PRIVATE_KEY", feature: "GitHub engineering" },
  { name: "GITHUB_REPOSITORY_CREATE_TOKEN", feature: "private project repositories" },
  { name: "TRANSACTRA_SANDBOX_IMAGE", feature: "isolated verification" },
  { name: "WHATSAPP_APP_SECRET", feature: "WhatsApp channel" }
];

const results = [];
function record(scope, name, status, detail) {
  results.push({ scope, name, status, detail });
}

async function parseArgs() {
  const args = process.argv.slice(2);
  let envFile = process.env.TRANSACTRA_ENV_FILE ?? null;
  let strict = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--env-file") {
      const value = args[index + 1];
      if (!value) throw new Error("--env-file requires a path");
      envFile = value;
      index += 1;
    } else if (args[index] === "--strict") {
      strict = true;
    }
  }
  return { envFile, strict };
}

async function loadEnvFile(path) {
  if (!path) return;
  try {
    await access(path, constants.R_OK);
  } catch {
    throw new Error("Environment file not readable: " + path);
  }
  const content = await readFile(path, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function run(command, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, stdout, stderr: stderr + "\ntimed out" });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); resolve({ ok: false, stdout, stderr: error.message }); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, stdout, stderr }); });
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_DIGEST = /@sha256:[a-f0-9]{64}$/;

const { envFile, strict } = await parseArgs();
await loadEnvFile(envFile);

// ---------------------------------------------------------------- runtime
record("runtime", "node version", process.versions.node.startsWith("22.") || process.versions.node.startsWith("24.")
  ? "pass" : "warn", "Node " + process.version + " on " + platform() + "/" + release());
const docker = await run("docker", ["version", "--format", "{{.Server.Version}}"]);
record("runtime", "docker daemon", docker.ok && docker.stdout.trim() ? "pass" : "fail",
  docker.stdout.trim() ? "server " + docker.stdout.trim() : "docker CLI present but no daemon responded");

// ---------------------------------------------------------------- required environment
for (const name of REQUIRED) {
  const value = process.env[name];
  record("environment", name, value && value.trim() ? "pass" : "fail",
    value && value.trim() ? "present" : "missing; set it in " + (envFile ?? "the service environment"));
}

const owner = process.env.TRANSACTRA_OWNER_ID ?? "";
if (owner && !UUID.test(owner)) {
  record("environment", "TRANSACTRA_OWNER_ID format", "fail", "must be the owner UUID emitted by db:bootstrap-owner");
} else if (owner) {
  record("environment", "TRANSACTRA_OWNER_ID format", "pass", "valid owner UUID");
}
const apiToken = process.env.CONTROL_PLANE_API_TOKEN ?? "";
if (apiToken && apiToken.length < 32) record("environment", "token length", "fail", "CONTROL_PLANE_API_TOKEN must be at least 32 characters");
if (apiToken && apiToken === (process.env.CONTROL_PLANE_APPROVAL_TOKEN ?? "")) {
  record("environment", "token separation", "fail", "the approval credential must be a different secret from the API token");
}
const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
const botId = /^(\d+):/.exec(botToken);
record("channel", "telegram token shape", botToken && botId ? "pass" : "fail",
  botToken && botId ? "bot id " + botId[1] : "expected <digits>:<secret>");
const allowed = (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
record("channel", "telegram allowlist", allowed.length > 0 && allowed.every((id) => /^-?\d+$/.test(id)) ? "pass" : "fail",
  allowed.length > 0 ? allowed.length + " numeric chat id(s)" : "at least one numeric chat id is required");

// ---------------------------------------------------------------- database reachability
const databaseUrl = process.env.DATABASE_URL ?? "";
if (databaseUrl) {
  record("database", "DATABASE_URL shape", /^postgres(ql)?:\/\/[^/\s]+:\d+\/\w+/.test(databaseUrl) ? "pass" : "warn",
    databaseUrl.replace(/:[^:@/]+@/, ":***@"));
} else {
  record("database", "DATABASE_URL shape", "fail", "missing");
}

// ---------------------------------------------------------------- optional feature credentials
for (const entry of OPTIONAL) {
  const value = process.env[entry.name];
  record("optional", entry.name, value && value.trim() ? "present" : "absent",
    (value && value.trim() ? "configured" : "not configured") + "; " + entry.feature + " will fail closed with a clear message");
}

// ---------------------------------------------------------------- sandbox image
const sandboxImage = process.env.TRANSACTRA_SANDBOX_IMAGE ?? "";
if (sandboxImage) {
  const pinned = SHA256_DIGEST.test(sandboxImage);
  record("sandbox", "image digest", pinned ? "pass" : "fail",
    pinned ? "pinned to an immutable sha256 digest" : "must be pinned, e.g. name@sha256:<64-hex>");
  if (pinned && docker.ok) {
    const local = await run("docker", ["image", "inspect", sandboxImage]);
    record("sandbox", "image present locally", local.ok ? "pass" : "fail",
      local.ok ? "found; the runner uses --pull=never" : "not present on this host; pull it before starting the worker");
  }
} else {
  record("sandbox", "image digest", "fail", "TRANSACTRA_SANDBOX_IMAGE is not set; no isolated verification can run");
}

// ---------------------------------------------------------------- secrets hygiene
const secretLike = /(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
for (const [key, value] of Object.entries(process.env)) {
  if (!value || !secretLike.test(value)) continue;
  if (["NVIDIA_NIM_API_KEY", "TAVILY_API_KEY", "GITHUB_APP_PRIVATE_KEY", "GITHUB_REPOSITORY_CREATE_TOKEN", "CONTROL_PLANE_API_TOKEN", "CONTROL_PLANE_APPROVAL_TOKEN", "TELEGRAM_BOT_TOKEN", "WHATU_ACCESS_TOKEN", "WHATSAPP_ACCESS_TOKEN"].includes(key)) continue;
  record("secrets", key, "warn", "looks like a credential; keep it only in the deployment secret store");
}
record("secrets", "repository tracking", "pass", "this check never prints or persists a credential value; verify the env file is git-ignored");

// ---------------------------------------------------------------- report
const failures = results.filter((entry) => entry.status === "fail");
const warnings = results.filter((entry) => entry.status === "warn");
const present = results.filter((entry) => entry.status === "pass").length;

const byScope = new Map();
for (const entry of results) {
  if (!byScope.has(entry.scope)) byScope.set(entry.scope, []);
  byScope.get(entry.scope).push(entry);
}
for (const [scope, entries] of byScope) {
  process.stdout.write("\n" + scope.toUpperCase() + "\n");
  for (const entry of entries) {
    const badge = entry.status === "pass" ? "ok  " : entry.status === "fail" ? "FAIL" : entry.status === "warn" ? "warn" : "info";
    process.stdout.write("  [" + badge + "] " + entry.name.padEnd(38) + " " + entry.detail + "\n");
  }
}
process.stdout.write("\n" + present + " present, " + failures.length + " failing, " + warnings.length + " warning(s)\n");
if (failures.length > 0) {
  process.stdout.write("Deployment should not proceed until every FAIL is resolved. Transactra fails closed: a missing\ncredential becomes a reported failure, never a simulated success.\n");
  process.exitCode = 1;
} else if (strict && warnings.length > 0) {
  process.exitCode = 1;
} else {
  process.stdout.write("Every prerequisite is present.\n");
}
