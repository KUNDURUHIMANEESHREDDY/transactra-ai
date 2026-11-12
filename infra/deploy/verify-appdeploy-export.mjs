#!/usr/bin/env node
/**
 * Validate a complete, read-only AppDeploy export before any import is attempted.
 *
 * Input contract:
 * {
 *   "schemaVersion": 1,
 *   "source": "appdeploy",
 *   "exportedAt": "ISO-8601 timestamp",
 *   "tables": {
 *     "cp_agents": [{ "id": "source-id", "...": "..." }],
 *     ...
 *   }
 * }
 *
 * This tool never connects to a source or destination database and never imports data.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE_TABLES = Object.freeze([
  "cp_agents",
  "cp_tasks",
  "cp_events",
  "cp_projects",
  "cp_recommendations",
  "cp_approvals",
  "cp_state",
]);

const SECRET_FIELD = /(?:token|secret|privatekey|apikey|password|authorization)$/i;

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function inspectForSecrets(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectForSecrets(item, path + "[" + index + "]"));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD.test(key.replace(/[^a-z0-9]/gi, ""))) {
      throw new Error("Possible secret-bearing field found at " + path + "." + key + "; remove secrets before migration");
    }
    inspectForSecrets(child, path + "." + key);
  }
}

export function verifyBundle(bundle) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new Error("Export bundle must be a JSON object");
  }
  if (bundle.schemaVersion !== 1) throw new Error("Unsupported export schemaVersion");
  if (bundle.source !== "appdeploy") throw new Error('Export source must be "appdeploy"');
  if (typeof bundle.exportedAt !== "string" || !Number.isFinite(Date.parse(bundle.exportedAt))) {
    throw new Error("exportedAt must be a valid ISO-8601 timestamp");
  }
  if (!bundle.tables || typeof bundle.tables !== "object" || Array.isArray(bundle.tables)) {
    throw new Error("tables must be an object keyed by source table name");
  }

  const actualNames = Object.keys(bundle.tables).sort();
  const expectedNames = [...SOURCE_TABLES].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error("Export must contain exactly these seven tables: " + SOURCE_TABLES.join(", "));
  }

  const tables = {};
  for (const tableName of SOURCE_TABLES) {
    const records = bundle.tables[tableName];
    if (!Array.isArray(records)) throw new Error(tableName + " must contain a complete records array");
    const ids = new Set();
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        throw new Error(tableName + "[" + index + "] must be an object");
      }
      if (typeof record.id !== "string" || record.id.trim() === "") {
        throw new Error(tableName + "[" + index + "] is missing its physical source id");
      }
      if (ids.has(record.id)) throw new Error(tableName + " contains duplicate source id " + record.id);
      ids.add(record.id);
      inspectForSecrets(record, tableName + "[" + index + "]");
    }
    const normalized = [...records].sort((a, b) => a.id.localeCompare(b.id)).map(canonicalize);
    const payload = JSON.stringify(normalized);
    tables[tableName] = {
      recordCount: records.length,
      canonicalBytes: Buffer.byteLength(payload, "utf8"),
      sha256: createHash("sha256").update(payload).digest("hex"),
    };
  }

  return {
    schemaVersion: 1,
    source: "appdeploy",
    exportedAt: bundle.exportedAt,
    verifiedAt: new Date().toISOString(),
    totalRecords: Object.values(tables).reduce((sum, table) => sum + table.recordCount, 0),
    tables,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--input", "--manifest"].includes(flag) || !argv[index + 1]) {
      throw new Error("Usage: node infra/deploy/verify-appdeploy-export.mjs --input <bundle.json> --manifest <manifest.json>");
    }
    args[flag.slice(2)] = argv[++index];
  }
  if (!args.input || !args.manifest) {
    throw new Error("Both --input and --manifest are required");
  }
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const bundle = JSON.parse(await readFile(args.input, "utf8"));
    const manifest = verifyBundle(bundle);
    await writeFile(args.manifest, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    process.stdout.write("Verified " + manifest.totalRecords + " records across " + SOURCE_TABLES.length + " tables.\n");
    for (const [name, info] of Object.entries(manifest.tables)) {
      process.stdout.write(name + ": " + info.recordCount + " records, sha256 " + info.sha256 + "\n");
    }
    process.stdout.write("Manifest written to " + resolve(args.manifest) + "\n");
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  }
}
