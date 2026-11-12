const DEFAULT_REPOSITORY = "KUNDURUHIMANEESHREDDY/transactra";
const MAX_RESEARCH_RESULTS = 3;
const MAX_REPOSITORY_FILE_BYTES = 128 * 1024;
const MAX_APPROVAL_PREVIEW_BYTES = 1800;

function rejectCredentialText(value) {
  if (/(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|[0-9]{8,12}:[A-Za-z0-9_-]{30,}|AKIA[0-9A-Z]{16})/.test(value)) {
    throw new Error("Tool input appears to contain a credential or private key; it was rejected");
  }
}

function boundedText(value, label, min = 1, max = 2000) {
  if (typeof value !== "string" || value.trim().length < min || value.length > max) {
    throw new Error(label + " must be a string between " + min + " and " + max + " characters");
  }
  return value.trim();
}

function validateRepositoryPath(value) {
  const path = boundedText(value, "Repository path", 1, 240).replace(/^\/+/, "");
  if (path.split("/").some((part) => !part || part === "." || part === "..")
      || /[\\\\\u0000-\u001f]/.test(path)
      || /(^|\/)(\.env(?:\.|$)|secrets?(?:\/|$)|credentials?(?:\/|$))/i.test(path)
      || /\.(?:pem|key|p12|pfx)$/i.test(path)
      || /^(?:infra\/cloudflare\/wrangler(?:\.staging)?\.toml|\.github\/workflows\/)/i.test(path)) {
    throw new Error("Repository path is outside the approved source-file scope");
  }
  if (!/^(?:apps|packages|tests|infra\/cloudflare\/src|infra\/cloudflare\/tests|docs|scripts)\//.test(path)
      && !/^(?:README\.md|CHANGELOG\.md)$/.test(path)) {
    throw new Error("Repository path must be inside an approved source, test, documentation, or script directory");
  }
  return path;
}

export function validateToolInput(tool, raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Tool input must be an object");
  switch (tool) {
    case "none":
    case "data_analysis":
      return {};
    case "web_research": {
      const query = boundedText(raw.query, "Research query", 3, 300);
      rejectCredentialText(query);
      return { query };
    }
    case "repository_read":
      return { path: validateRepositoryPath(raw.path) };
    case "repository_write": {
      const path = validateRepositoryPath(raw.path);
      const content = boundedText(raw.content, "Repository content", 1, MAX_APPROVAL_PREVIEW_BYTES);
      if (new TextEncoder().encode(content).byteLength > MAX_APPROVAL_PREVIEW_BYTES) {
        throw new Error("Repository content exceeds the 1,800-byte approval preview limit");
      }
      rejectCredentialText(content);
      const message = boundedText(raw.message, "Commit message", 5, 120);
      rejectCredentialText(message);
      if (!Object.prototype.hasOwnProperty.call(raw, "expected_sha")) throw new Error("Repository write must bind to the exact SHA observed during the read/review step");
      const expectedSha = raw.expected_sha === null ? null : boundedText(raw.expected_sha, "Expected file SHA", 40, 40);
      if (expectedSha !== null && !/^[0-9a-f]{40}$/i.test(expectedSha)) throw new Error("Expected file SHA must be a 40-character Git blob SHA or null for a new file");
      if (raw.branch !== undefined && raw.branch !== "main") throw new Error("Transactra repository writes are restricted to main");
      return { path, content, message, branch: "main", expected_sha: expectedSha };
    }
    case "cloudflare_staging": {
      if (raw.environment !== "staging") throw new Error("Only the isolated staging environment can be dispatched");
      const operation = raw.operation === undefined ? "deploy" : raw.operation;
      if (!["deploy", "verify"].includes(operation)) throw new Error("Staging operation must be deploy or verify");
      return { environment: "staging", operation };
    }
    case "telegram_notify": {
      const message = boundedText(raw.message, "Telegram message", 1, 1000);
      rejectCredentialText(message);
      return { message };
    }
    default:
      throw new Error("No authorized tool adapter is registered for " + String(tool));
  }
}

export async function hashToolAction(action) {
  const bytes = new TextEncoder().encode(JSON.stringify(action));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function isSideEffectStep(step) {
  return step?.tool === "repository_write"
    || step?.tool === "telegram_notify"
    || (step?.tool === "cloudflare_staging" && (step?.tool_input?.operation || "deploy") === "deploy");
}

export function buildToolAction(step) {
  return {
    version: 1,
    step_id: boundedText(step.id, "Step ID", 1, 80),
    agent: boundedText(step.agent, "Agent", 1, 40),
    description: boundedText(step.description, "Step description", 1, 500),
    acceptance_criteria: boundedText(step.acceptance_criteria, "Step acceptance criteria", 1, 500),
    risk: step.risk,
    tool: step.tool,
    input: validateToolInput(step.tool, step.tool_input || {}),
  };
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("=", "").replaceAll("+", "-").replaceAll("/", "_");
}

function derLength(length) {
  if (length < 128) return Uint8Array.of(length);
  const bytes = [];
  for (let value = length; value > 0; value = Math.floor(value / 256)) bytes.unshift(value & 255);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function joinBytes(...parts) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

function pemBytes(pem) {
  const normalized = String(pem || "").replaceAll("\r", "").replaceAll("\\r", "").replaceAll("\\n", "\n").trim();
  const pkcs8Prefix = "-----BEGIN " + "PRIVATE KEY-----";
  const pkcs1Prefix = "-----BEGIN RSA " + "PRIVATE KEY-----";
  const suffix = normalized.startsWith(pkcs1Prefix)
    ? "-----END RSA " + "PRIVATE KEY-----"
    : "-----END " + "PRIVATE KEY-----";
  if (!normalized.startsWith(pkcs8Prefix) && !normalized.startsWith(pkcs1Prefix)) {
    throw new Error("GitHub App private key must be an unencrypted RSA PEM");
  }
  if (!normalized.endsWith(suffix)) throw new Error("GitHub App private key PEM footer is invalid");
  const body = normalized.slice(normalized.startsWith(pkcs1Prefix) ? pkcs1Prefix.length : pkcs8Prefix.length, -suffix.length)
    .replaceAll(" ", "").replaceAll("\r", "").replaceAll("\n", "").replaceAll("\t", "");
  const binary = atob(body);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (normalized.startsWith(pkcs8Prefix)) return bytes;
  const algorithm = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00);
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const privateKeyOctets = joinBytes(Uint8Array.of(0x04), derLength(bytes.length), bytes);
  const inner = joinBytes(version, algorithm, privateKeyOctets);
  return joinBytes(Uint8Array.of(0x30), derLength(inner.length), inner);
}

async function githubInstallationToken(env) {
  const repository = String(env.TRANSACTRA_GITHUB_REPOSITORY || DEFAULT_REPOSITORY).trim();
  if (repository !== DEFAULT_REPOSITORY) throw new Error("GitHub adapter is restricted to the configured Transactra repository");
  const appId = String(env.GITHUB_APP_ID || "").trim();
  const installationId = String(env.GITHUB_APP_INSTALLATION_ID || "").trim();
  const privateKey = typeof env.GITHUB_APP_PRIVATE_KEY === "string" ? env.GITHUB_APP_PRIVATE_KEY : "";
  if (!/^[0-9]+$/.test(appId) || !/^[0-9]+$/.test(installationId) || !privateKey.trim()) {
    throw new Error("GitHub App ID, installation ID and private key are required; repository adapter remains unavailable");
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })));
  const signingInput = header + "." + payload;
  const key = await crypto.subtle.importKey(
    "pkcs8", pemBytes(privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  const jwt = signingInput + "." + base64Url(new Uint8Array(signature));
  const response = await fetch("https://api.github.com/app/installations/" + installationId + "/access_tokens", {
    method: "POST",
    headers: {
      authorization: "Bearer " + jwt,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      repositories: ["transactra"],
      permissions: { contents: "write", actions: "write" },
    }),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("GitHub App installation-token exchange returned HTTP " + response.status);
  const data = await response.json();
  const grantedRepositories = Array.isArray(data.repositories)
    ? data.repositories.map((item) => item?.full_name).filter((name) => typeof name === "string")
    : [];
  if (typeof data.token !== "string" || !data.token || !data.permissions
      || data.permissions.contents !== "write" || data.permissions.actions !== "write"
      || grantedRepositories.length !== 1 || grantedRepositories[0] !== DEFAULT_REPOSITORY) {
    throw new Error("GitHub App installation token did not grant the exact repository and required permissions");
  }
  return { repository, token: data.token };
}

async function githubRequest(env, path, method = "GET", body, tokenOverride) {
  const { token } = tokenOverride ? { token: tokenOverride } : await githubInstallationToken(env);
  const response = await fetch("https://api.github.com/repos/" + DEFAULT_REPOSITORY + path, {
    method,
    headers: {
      authorization: "Bearer " + token,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 240);
    throw new Error("GitHub API returned HTTP " + response.status + (detail ? ": " + detail : ""));
  }
  if (response.status === 204) return { accepted: true };
  return response.json();
}

function decodeBase64Utf8(value) {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function encodeBase64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function research(query) {
  const url = new URL("https://en.wikipedia.org/w/rest.php/v1/search/page");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(MAX_RESEARCH_RESULTS));
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "Transactra/1.0 (read-only research adapter)" },
    redirect: "error",
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error("Public research source returned HTTP " + response.status);
  const data = await response.json();
  const pages = Array.isArray(data.pages) ? data.pages.slice(0, MAX_RESEARCH_RESULTS) : [];
  return {
    source: "Wikimedia public search",
    query,
    results: pages.map((page) => ({
      title: String(page.title || "").slice(0, 180),
      excerpt: String(page.excerpt || page.description || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 450),
      url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(String(page.title || "").replace(/ /g, "_")),
    })),
    limitation: "Read-only public encyclopedia search; this adapter is not a general web search engine.",
  };
}


export async function executeToolAdapter(env, tool, rawInput, context = {}) {
  const input = validateToolInput(tool, rawInput || {});
  if (tool === "none") return { tool, status: "not_requested", output: "" };
  if (tool === "data_analysis") {
    const rows = (Array.isArray(context.priorResults) ? context.priorResults : []).slice(0, 6);
    const normalized = rows.map((item) => ({
      step_id: String(item.step_id || "").slice(0, 80),
      result: String(item.result_text || "").slice(0, 700),
    }));
    const nonEmpty = normalized.filter((item) => item.result.trim());
    return {
      tool, status: "completed",
      output: JSON.stringify({
        evidence_items: normalized.length,
        non_empty_results: nonEmpty.length,
        total_characters: normalized.reduce((sum, item) => sum + item.result.length, 0),
        completed_step_ids: nonEmpty.map((item) => item.step_id),
        evidence_excerpt: nonEmpty.map((item) => ({ step_id: item.step_id, excerpt: item.result.slice(0, 240) })),
        limitation: "Deterministic read-only analysis of supplied prior-step text only; no external data source was accessed.",
      }),
    };
  }
  if (tool === "web_research") return { tool, status: "completed", output: JSON.stringify(await research(input.query)) };
  if (tool === "repository_read") {
    const { repository, token } = await githubInstallationToken(env);
    const encodedPath = input.path.split("/").map(encodeURIComponent).join("/");
    const response = await fetch("https://api.github.com/repos/" + repository + "/contents/" + encodedPath + "?ref=main", {
      headers: { authorization: "Bearer " + token, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      redirect: "error", signal: AbortSignal.timeout(15000),
    });
    if (response.status === 404) return { tool, status: "not_found", output: JSON.stringify({ repository, path: input.path, exists: false, expected_sha: null }) };
    if (!response.ok) throw new Error("GitHub repository read returned HTTP " + response.status);
    const data = await response.json();
    if (data.type !== "file" || data.encoding !== "base64" || typeof data.content !== "string") throw new Error("GitHub path is not a regular UTF-8 file");
    const content = decodeBase64Utf8(data.content);
    const totalBytes = new TextEncoder().encode(content).byteLength;
    if (totalBytes > MAX_REPOSITORY_FILE_BYTES) throw new Error("Repository file exceeds the 128 KiB read limit");
    return {
      tool, status: "completed",
      output: JSON.stringify({
        repository, path: input.path, sha: data.sha,
        content: content.slice(0, 3000),
        total_bytes: totalBytes,
        truncated: content.length > 3000,
      }),
    };
  }
  if (tool === "repository_write") {
    const encodedPath = input.path.split("/").map(encodeURIComponent).join("/");
    let sha;
    const { token } = await githubInstallationToken(env);
    const existing = await fetch("https://api.github.com/repos/" + DEFAULT_REPOSITORY + "/contents/" + encodedPath + "?ref=main", {
      method: "GET",
      headers: { authorization: "Bearer " + token, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      redirect: "error", signal: AbortSignal.timeout(15000),
    });
    if (existing.ok) {
      const current = await existing.json();
      if (current.type !== "file" || typeof current.sha !== "string") throw new Error("Existing GitHub path is not a regular file");
      if (!input.expected_sha || current.sha !== input.expected_sha) throw new Error("Repository file changed since owner approval; no write was made");
      sha = current.sha;
    } else if (existing.status === 404) {
      if (input.expected_sha !== null) throw new Error("Approved repository file no longer exists; no write was made");
    } else throw new Error("GitHub pre-write check returned HTTP " + existing.status);
    const body = { message: "[Transactra approved] " + input.message, content: encodeBase64Utf8(input.content), branch: "main", ...(sha ? { sha } : {}) };
    const result = await githubRequest(env, "/contents/" + encodedPath, "PUT", body, token);
    return { tool, status: "completed", output: JSON.stringify({ repository: DEFAULT_REPOSITORY, path: input.path, commit: result.commit?.sha || null, html_url: result.content?.html_url || null }) };
  }
  if (tool === "cloudflare_staging" && input.operation === "verify") {
    const rawBase = typeof env.TRANSACTRA_STAGING_BASE_URL === "string" ? env.TRANSACTRA_STAGING_BASE_URL.trim() : "";
    let base;
    try { base = new URL(rawBase); } catch { throw new Error("Staging verification URL is not configured"); }
    if (base.protocol !== "https:" || base.hostname !== "transactra-edge-staging.himaneeshreddyk.workers.dev" || base.username || base.password || base.search || base.hash) {
      throw new Error("Staging verification is restricted to an HTTPS workers.dev hostname");
    }
    const healthResponse = await fetch(new URL("/health", base), { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10000) });
    const readyResponse = await fetch(new URL("/ready", base), { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10000) });
    if (!healthResponse.ok || !readyResponse.ok) throw new Error("Staging health or readiness endpoint returned a non-success status");
    const health = await healthResponse.json().catch(() => null);
    const ready = await readyResponse.json().catch(() => null);
    if (health?.ok !== true || health?.service !== "transactra-edge" || ready?.ok !== true || ready?.ready !== true || ready?.planner !== "d1-native" || ready?.inference !== "disabled") {
      throw new Error("Staging verification failed its service, D1-native readiness, or inference-lock assertions");
    }
    return { tool, status: "completed", output: JSON.stringify({ environment: "staging", health: "ok", ready: true, planner: "d1-native", inference: "disabled", base: base.origin }) };
  }
  if (tool === "cloudflare_staging" && input.operation === "deploy") {
    const taskId = boundedText(context.taskId, "Task ID", 1, 120);
    const stepId = boundedText(context.stepId, "Step ID", 1, 80);
    const approvalId = boundedText(context.approvalId, "Step approval ID", 1, 80);
    const actionHash = boundedText(context.actionHash, "Approved action hash", 64, 64);
    const approvalDatabaseId = boundedText(env.TRANSACTRA_D1_DATABASE_ID, "Approval database ID", 36, 36);
    if (approvalDatabaseId !== "e7292f55-c90e-4d34-8b77-c97c3e5ec15a") {
      throw new Error("Staging dispatch is restricted to the dedicated transactra-staging D1 database");
    }
    const result = await githubRequest(env, "/actions/workflows/deploy-staging.yml/dispatches", "POST", {
      ref: "main",
      inputs: {
        mode: "approved_action",
        task_id: taskId, step_id: stepId, approval_id: approvalId,
        action_hash: actionHash, approval_database_id: approvalDatabaseId,
      },
    });
    return { tool, status: "dispatched", output: JSON.stringify({ repository: DEFAULT_REPOSITORY, workflow: "deploy-staging.yml", environment: "staging", dispatch: "accepted", deployment_complete: false, ...result }) };
  }
  if (tool === "telegram_notify") {
    const token = typeof env.TELEGRAM_BOT_TOKEN === "string" ? env.TELEGRAM_BOT_TOKEN.trim() : "";
    const ownerId = typeof env.TELEGRAM_OWNER_ID === "string" ? env.TELEGRAM_OWNER_ID.trim() : "";
    if (!token || !ownerId) throw new Error("Owner-only Telegram notification credentials are unavailable");
    const response = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: ownerId, text: input.message, disable_web_page_preview: true }),
      redirect: "error", signal: AbortSignal.timeout(12000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.ok !== true) throw new Error("Owner Telegram notification failed with HTTP " + response.status);
    return { tool, status: "completed", output: JSON.stringify({ delivered_to_owner: true, message_id: data.result?.message_id || null }) };
  }
  throw new Error("No authorized tool adapter is registered for " + String(tool));
}
