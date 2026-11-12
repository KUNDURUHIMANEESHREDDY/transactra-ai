import { readFile, writeFile, rename, chmod, lstat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { Pool } from "pg";

const envPath = process.argv[2] ?? "/etc/transactra/transactra.env";
const fileInfo = await lstat(envPath);
if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error("Environment file must be a regular, non-symlink file");
if ((fileInfo.mode & 0o077) !== 0) throw new Error("Environment file permissions must be 0600 or stricter");

function parseEnvironment(source) {
  const values = Object.create(null);
  for (const [index,line] of source.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) throw new Error("Invalid environment-file syntax on line " + (index + 1));
    const [,key,raw] = match;
    if (Object.hasOwn(values,key)) throw new Error("Duplicate environment key: " + key);
    let value = raw;
    if (raw.startsWith('"')) {
      try { value = JSON.parse(raw); } catch { throw new Error("Invalid quoted value for " + key); }
      if (typeof value !== "string") throw new Error("Invalid value for " + key);
    } else if (raw.startsWith("'")) {
      if (!raw.endsWith("'") || raw.length < 2) throw new Error("Invalid quoted value for " + key);
      value = raw.slice(1,-1);
    }
    values[key] = value;
  }
  return values;
}

function serializeValue(value) { return JSON.stringify(String(value)); }
async function persist(values) {
  const original = await readFile(envPath,"utf8");
  const keys = new Set();
  const lines = original.split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=/);
    if (!match || !Object.hasOwn(values,match[1])) return line;
    keys.add(match[1]);
    return match[1] + "=" + serializeValue(values[match[1]]);
  });
  for (const [key,value] of Object.entries(values)) if (!keys.has(key)) lines.push(key + "=" + serializeValue(value));
  const temporary = join(dirname(envPath),".transactra-env-" + process.pid);
  await writeFile(temporary,lines.join("\n").replace(/\n*$/,"\n"),{ encoding:"utf8",mode:0o600,flag:"wx" });
  await chmod(temporary,0o600);
  await rename(temporary,envPath);
}

const values = parseEnvironment(await readFile(envPath,"utf8"));
const required = [
  "DATABASE_URL","TRANSACTRA_OWNER_SUBJECT","NVIDIA_NIM_API_KEY","NVIDIA_NIM_MODEL",
  "NVIDIA_NIM_FREE_TIER_VERIFIED_AT","NVIDIA_NIM_MONTHLY_REQUEST_CAP","NVIDIA_NIM_MONTHLY_TOKEN_CAP"
];
for (const key of required) if (!values[key]?.trim()) throw new Error("Required configuration is missing: " + key);
if (!/^postgres(?:ql)?:\/\//i.test(values.DATABASE_URL)) throw new Error("DATABASE_URL must be a PostgreSQL connection URI");
if (values.TRANSACTRA_OWNER_SUBJECT.length > 256) throw new Error("TRANSACTRA_OWNER_SUBJECT exceeds 256 characters");

for (const key of ["NVIDIA_NIM_MONTHLY_REQUEST_CAP","NVIDIA_NIM_MONTHLY_TOKEN_CAP"]) {
  if (!/^[1-9][0-9]*$/.test(values[key]) || !Number.isSafeInteger(Number(values[key]))) throw new Error(key + " must be a positive integer");
}
const verifiedAt = Date.parse(values.NVIDIA_NIM_FREE_TIER_VERIFIED_AT);
if (!Number.isFinite(verifiedAt) || verifiedAt > Date.now() + 300000 || Date.now() - verifiedAt > 30 * 86400000) {
  throw new Error("NVIDIA_NIM_FREE_TIER_VERIFIED_AT must be a valid verification from the last 30 days");
}
if (values.MONTHLY_SPEND_LIMIT_INR && values.MONTHLY_SPEND_LIMIT_INR !== "0") throw new Error("MONTHLY_SPEND_LIMIT_INR must remain 0");
values.MONTHLY_SPEND_LIMIT_INR = "0";
values.NODE_ENV = "production";
values.HOST = "127.0.0.1";
values.PORT = values.PORT || "8787";
values.WHATSAPP_PORT = values.WHATSAPP_PORT || "3001";
for (const [key,port] of [["PORT",values.PORT],["WHATSAPP_PORT",values.WHATSAPP_PORT]]) {
  if (!/^[1-9][0-9]*$/.test(port) || Number(port) > 65535) throw new Error(key + " must be a valid TCP port");
}
for (const key of ["CONTROL_PLANE_API_TOKEN","CONTROL_PLANE_APPROVAL_TOKEN"]) {
  if (!values[key]) values[key] = randomBytes(32).toString("base64url");
  if (values[key].length < 32) throw new Error(key + " must contain at least 32 characters");
}
if (values.CONTROL_PLANE_API_TOKEN === values.CONTROL_PLANE_APPROVAL_TOKEN) throw new Error("API and approval credentials must be different");

const secondary = ["SECONDARY_PROVIDER_ID","SECONDARY_PROVIDER_BASE_URL","SECONDARY_PROVIDER_API_KEY","SECONDARY_PROVIDER_MODEL","SECONDARY_PROVIDER_FREE_TIER_VERIFIED_AT","SECONDARY_PROVIDER_MONTHLY_REQUEST_CAP","SECONDARY_PROVIDER_MONTHLY_TOKEN_CAP"];
const secondaryCount = secondary.filter((key) => Boolean(values[key]?.trim())).length;
if (secondaryCount !== 0 && secondaryCount !== secondary.length) throw new Error("Secondary provider configuration is partial; fill every field or leave all fields blank");
if (secondaryCount === secondary.length) {
  const secondaryDate = Date.parse(values.SECONDARY_PROVIDER_FREE_TIER_VERIFIED_AT);
  if (!Number.isFinite(secondaryDate) || secondaryDate > Date.now() + 300000 || Date.now() - secondaryDate > 30 * 86400000) {
    throw new Error("Secondary provider free-tier verification must be from the last 30 days");
  }
  if (!/^https:\/\//i.test(values.SECONDARY_PROVIDER_BASE_URL) && !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/v1\/?$/i.test(values.SECONDARY_PROVIDER_BASE_URL)) {
    throw new Error("Secondary provider endpoint must use HTTPS or loopback HTTP");
  }
  if (!values.SECONDARY_PROVIDER_BASE_URL.replace(/\/+$/,"").endsWith("/v1")) throw new Error("Secondary provider base URL must end in /v1");
  for (const key of ["SECONDARY_PROVIDER_MONTHLY_REQUEST_CAP","SECONDARY_PROVIDER_MONTHLY_TOKEN_CAP"]) {
    if (!/^[1-9][0-9]*$/.test(values[key]) || !Number.isSafeInteger(Number(values[key]))) throw new Error(key + " must be a positive integer");
  }
}
const github = ["GITHUB_APP_ID","GITHUB_APP_INSTALLATION_ID","GITHUB_APP_PRIVATE_KEY"];
const githubCount = github.filter((key) => Boolean(values[key]?.trim())).length;
if (githubCount !== 0 && githubCount !== github.length) throw new Error("GitHub App configuration is partial; fill all App fields or leave all blank");
if (values.GITHUB_REPOSITORY_CREATE_TOKEN && githubCount !== github.length) throw new Error("Repository creation token requires a complete GitHub App configuration");
if (values.TAVILY_API_KEY && values.TAVILY_PAYG_DISABLED_CONFIRMED !== "true") throw new Error("TAVILY_PAYG_DISABLED_CONFIRMED must be true before enabling Tavily");
if (Boolean(values.TELEGRAM_BOT_TOKEN) !== Boolean(values.TELEGRAM_ALLOWED_USER_IDS)) throw new Error("Telegram token and owner allowlist must be configured together");
const whatsapp = ["WHATSAPP_APP_SECRET","WHATSAPP_VERIFY_TOKEN","WHATSAPP_ACCESS_TOKEN","WHATSAPP_PHONE_NUMBER_ID","WHATSAPP_GRAPH_API_VERSION","WHATSAPP_ALLOWED_USERS","PUBLIC_BASE_URL"];
const whatsappCount = whatsapp.filter((key) => Boolean(values[key]?.trim())).length;
if (whatsappCount !== 0 && whatsappCount !== whatsapp.length) throw new Error("WhatsApp requires all credentials, sender allowlist and PUBLIC_BASE_URL");
if (values.PUBLIC_BASE_URL && !/^https:\/\//i.test(values.PUBLIC_BASE_URL)) throw new Error("PUBLIC_BASE_URL must use HTTPS");

await persist(values);
const runtimeEnv = { ...process.env,...values };
async function verifyProviderModel(label,baseUrl,apiKey,model) {
  let endpoint;
  try { endpoint = new URL(baseUrl); } catch { throw new Error(label + " base URL is invalid"); }
  const localHttp = endpoint.protocol === "http:" && ["localhost","127.0.0.1","::1"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !localHttp) throw new Error(label + " model endpoint must use HTTPS");
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error(label + " base URL must not contain credentials or URL parameters");
  let response;
  try {
    response = await fetch(new URL("/v1/models",endpoint),{
      headers:{ authorization:"Bearer " + apiKey,accept:"application/json" },
      signal:AbortSignal.timeout(15000)
    });
  } catch {
    throw new Error(label + " model discovery request failed; check network, DNS and endpoint reachability");
  }
  if (!response.ok) throw new Error(label + " model discovery returned HTTP " + response.status);
  const payload = await response.json();
  if (!(payload?.data?.some((item) => item?.id === model) ?? false)) throw new Error(label + " configured model is not listed by the provider endpoint");
}
const nimBaseUrl = values.NVIDIA_NIM_BASE_URL?.trim() || "https://integrate.api.nvidia.com";
await verifyProviderModel("NVIDIA NIM",nimBaseUrl,values.NVIDIA_NIM_API_KEY,values.NVIDIA_NIM_MODEL);
if (secondaryCount === secondary.length) {
  await verifyProviderModel("Secondary provider",values.SECONDARY_PROVIDER_BASE_URL,values.SECONDARY_PROVIDER_API_KEY,values.SECONDARY_PROVIDER_MODEL);
}
function runNode(file) {
  const result = spawnSync(process.execPath,["--experimental-strip-types",file],{
    cwd:process.cwd(),env:runtimeEnv,encoding:"utf8",maxBuffer:4*1024*1024
  });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").split(/\r?\n/).filter(Boolean);
    const safeLines = stderr.filter((line) => /migration_(?:applied|skipped)|^Error: (?:DATABASE_URL|TRANSACTRA_OWNER_SUBJECT|NVIDIA_NIM|CONTROL_PLANE|TAVILY|GitHub|WhatsApp|Telegram)/.test(line));
    for (const line of safeLines) process.stderr.write(line + "\n");
    throw new Error(file + " failed (exit " + (result.status ?? "signal") + "); inspect the service operator's local logs");
  }
  return result.stdout ?? "";
}

runNode("apps/control-plane/src/migrate.ts");
const pool = new Pool({ connectionString:values.DATABASE_URL,max:1,application_name:"transactra-worker-bootstrap" });
try {
  await pool.query("SELECT 1");
  if (values.TRANSACTRA_OWNER_ID) {
    const found = await pool.query("SELECT id FROM owners WHERE id=$1 AND external_subject=$2 AND status='active'",[values.TRANSACTRA_OWNER_ID,values.TRANSACTRA_OWNER_SUBJECT]);
    if (found.rowCount !== 1) throw new Error("Configured TRANSACTRA_OWNER_ID does not match the active owner subject in PostgreSQL");
  } else {
    const output = runNode("apps/control-plane/src/bootstrap-owner.ts");
    const ownerLine = output.split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).find((item) => item?.event === "owner_ready" && typeof item.ownerId === "string");
    if (!ownerLine) throw new Error("Owner bootstrap did not return an owner ID");
    values.TRANSACTRA_OWNER_ID = ownerLine.ownerId;
    await persist(values);
  }
} finally {
  await pool.end();
}
process.stdout.write(JSON.stringify({
  database:"connected",
  migrations:"applied-or-current",
  owner:"ready",
  apiCredentials:"generated-or-validated",
  telegramConfigured:Boolean(values.TELEGRAM_BOT_TOKEN),
  whatsappConfigured:Boolean(values.WHATSAPP_ACCESS_TOKEN),
  githubConfigured:Boolean(values.GITHUB_APP_PRIVATE_KEY),
  researchConfigured:Boolean(values.TAVILY_API_KEY),
  spendLimitInr:0
}) + "\n");
