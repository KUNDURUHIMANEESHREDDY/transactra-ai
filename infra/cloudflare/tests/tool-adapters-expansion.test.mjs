import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { executeToolAdapter, isSideEffectStep, validateToolInput } from "../src/tool-adapters.mjs";
import { isAgentToolAllowed } from "../src/orchestrator.mjs";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const baseEnv = {
  GITHUB_APP_ID: "12345",
  GITHUB_APP_INSTALLATION_ID: "98765",
  GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }),
  TRANSACTRA_GITHUB_REPOSITORY: "KUNDURUHIMANEESHREDDY/transactra",
};
const repoPermissions = { contents: "write", actions: "write" };
function installResponse(extra = {}) {
  return new Response(JSON.stringify({
    token: "scoped-token",
    permissions: { ...repoPermissions, ...extra },
    repositories: [{ full_name: "KUNDURUHIMANEESHREDDY/transactra" }],
  }), { status: 201 });
}

test("expanded tool inputs are bounded and side effects are approval-gated", () => {
  assert.deepEqual(validateToolInput("github_issues_read", { state: "closed", limit: 10 }), { state: "closed", limit: 10 });
  assert.deepEqual(validateToolInput("github_pr_read", { number: 12 }), { number: 12 });
  assert.deepEqual(validateToolInput("github_actions_read", { workflow_file: "ci.yml", limit: 5 }), { workflow_file: "ci.yml", limit: 5 });
  assert.throws(() => validateToolInput("github_actions_read", { workflow_file: "../secrets.yml" }), /valid workflow filename/);
  assert.equal(isSideEffectStep({ tool: "github_issue_create" }), true);
  assert.equal(isSideEffectStep({ tool: "financial_policy_prepare" }), true);
  assert.equal(isSideEffectStep({ tool: "cloudflare_observe" }), false);
  assert.equal(isSideEffectStep({ tool: "sandbox_verify" }), false);
});

test("GitHub issue read uses a scoped installation token and returns source URLs", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("/app/installations/")) return installResponse({ issues: "read" });
    return new Response(JSON.stringify([
      { number: 7, title: "Improve worker health checks", state: "open", html_url: "https://github.com/KUNDURUHIMANEESHREDDY/transactra/issues/7", updated_at: "2026-11-12T00:00:00Z", labels: [{ name: "operations" }] },
      { number: 8, title: "PR item", pull_request: { url: "https://api.github.com/pulls/8" } },
    ]), { status: 200 });
  };
  try {
    const result = await executeToolAdapter(baseEnv, "github_issues_read", { state: "open", limit: 10 });
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.issues.length, 1);
    assert.equal(parsed.issues[0].number, 7);
    assert.match(parsed.issues[0].url, /issues\/7$/);
    assert.match(calls[1].url, /issues\?state=open&per_page=10$/);
  } finally { globalThis.fetch = originalFetch; }
});

test("GitHub issue creation returns the created issue and uses the write permission", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("/app/installations/")) return installResponse({ issues: "write" });
    request = { url: String(url), options };
    return new Response(JSON.stringify({ number: 21, title: "Create integration tests", state: "open", html_url: "https://github.com/KUNDURUHIMANEESHREDDY/transactra/issues/21" }), { status: 201 });
  };
  try {
    const result = await executeToolAdapter(baseEnv, "github_issue_create", { title: "Create integration tests", body: "Add coverage.", labels: ["quality"] });
    assert.equal(JSON.parse(result.output).issue_number, 21);
    assert.equal(request.options.method, "POST");
    assert.deepEqual(JSON.parse(request.options.body), { title: "Create integration tests", body: "Add coverage.", labels: ["quality"] });
  } finally { globalThis.fetch = originalFetch; }
});

test("GitHub PR and Actions tools retrieve real metadata with read scopes", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("/app/installations/")) return installResponse({ pull_requests: "read" });
    requested.push(value);
    if (value.includes("/pulls/12/files")) return new Response(JSON.stringify([{ filename: "src/index.mjs", status: "modified", additions: 4, deletions: 1, changes: 5, patch: "@@ diff @@" }]), { status: 200 });
    return new Response(JSON.stringify({ number: 12, title: "Fix worker", state: "open", draft: false, html_url: "https://github.com/KUNDURUHIMANEESHREDDY/transactra/pull/12", base: { ref: "main" }, head: { ref: "fix", sha: "abc" }, mergeable_state: "clean" }), { status: 200 });
  };
  try {
    const pr = await executeToolAdapter(baseEnv, "github_pr_read", { number: 12 });
    const parsed = JSON.parse(pr.output);
    assert.equal(parsed.pull_request.number, 12);
    assert.equal(parsed.files[0].filename, "src/index.mjs");
  } finally { globalThis.fetch = originalFetch; }

  globalThis.fetch = async (url) => {
    if (String(url).includes("/app/installations/")) return installResponse({ actions: "read" });
    return new Response(JSON.stringify({ total_count: 1, workflow_runs: [{ id: 9, name: "CI", run_number: 4, status: "completed", conclusion: "success", html_url: "https://github.com/actions/runs/9" }] }), { status: 200 });
  };
  try {
    const actions = await executeToolAdapter(baseEnv, "github_actions_read", { workflow_file: "ci.yml", limit: 5 });
    assert.equal(JSON.parse(actions.output).workflow_runs[0].conclusion, "success");
  } finally { globalThis.fetch = originalFetch; }
});

test("Cloudflare infrastructure observation is read-only and redacts unneeded fields", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url, options) => {
    requested.push({ url: String(url), method: options?.method || "GET" });
    if (String(url).endsWith("/workers/scripts")) return new Response(JSON.stringify({ success: true, result: [{ id: "transactra-edge", modified_on: "2026-11-12" }] }), { status: 200 });
    if (String(url).endsWith("/queues")) return new Response(JSON.stringify({ success: true, result: [{ queue_name: "transactra-events", consumers: [{}], producers: [{}] }] }), { status: 200 });
    return new Response(JSON.stringify({ success: true, result: [{ name: "transactra", uuid: "db-id", version: "production" }] }), { status: 200 });
  };
  try {
    const result = await executeToolAdapter({ CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_READONLY_API_TOKEN: "read-only-token" }, "cloudflare_observe", { scope: "all" });
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.read_only, true);
    assert.equal(parsed.workers[0].name, "transactra-edge");
    assert.equal(parsed.queues[0].name, "transactra-events");
    assert.equal(parsed.databases[0].name, "transactra");
    assert.ok(requested.every(item => item.method === "GET"));
  } finally { globalThis.fetch = originalFetch; }
});

test("sandbox verification uses a no-network Dynamic Worker with bounded CPU and wall time", async () => {
  let configuration;
  const env = { LOADER: { load(value) {
    configuration = value;
    return { getEntrypoint(name) { assert.equal(name, "Code"); return { run: async () => ({ result: "42", logs: ["safe"] }) }; } };
  } } };
  const result = await executeToolAdapter(env, "sandbox_verify", { code: "return 6 * 7;" });
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.result, "42");
  assert.equal(configuration.globalOutbound, null);
  assert.equal(configuration.limits.cpuMs, 10);
  assert.equal(configuration.limits.subRequests, 0);
  assert.match(configuration.modules["code.js"], /return 6 \* 7/);
});

test("financial payment preparation is routed through the authenticated policy API and does not execute payment", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify({ ok: true, approvalId: "approval-123", intent: { amount: "25.00", currency: "USD", recipient: "Alex" }, risk: "medium", policyVersion: "2026-11-12.1", expiresInSeconds: 600 }), { status: 201 });
  };
  try {
    const result = await executeToolAdapter({
      TRANSACTRA_API_BASE_URL: "https://api.transactra.example",
      BACKEND_SHARED_SECRET: "s".repeat(40),
      TELEGRAM_OWNER_ID: "8593447241",
    }, "financial_policy_prepare", { text: "Pay $25 to Alex for lunch" });
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.approval_id, "approval-123");
    assert.equal(parsed.payment_executed, false);
    assert.equal(request.url, "https://api.transactra.example/api/payments/prepare");
    assert.equal(request.options.headers["x-transactra-owner-id"], "8593447241");
    assert.equal(JSON.parse(request.options.body).text, "Pay $25 to Alex for lunch");
  } finally { globalThis.fetch = originalFetch; }
});

test("Tavily research returns source-linked evidence when configured", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify({ results: [{ title: "Cloudflare docs", content: "Dynamic Workers are isolated.", url: "https://developers.cloudflare.com/dynamic-workers/", score: 0.91 }] }), { status: 200 });
  };
  try {
    const result = await executeToolAdapter({ TAVILY_API_KEY: "tavily-test-key" }, "web_research", { query: "Cloudflare Dynamic Workers" });
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.source, "Tavily web search");
    assert.equal(parsed.results[0].url, "https://developers.cloudflare.com/dynamic-workers/");
    assert.equal(request.url, "https://api.tavily.com/search");
    assert.equal(request.options.headers.authorization, "Bearer tavily-test-key");
  } finally { globalThis.fetch = originalFetch; }
});

test("new integrations fail closed when credentials or sandbox bindings are missing", async () => {
  await assert.rejects(executeToolAdapter({}, "cloudflare_observe", { scope: "all" }), /Cloudflare read-only account token/);
  await assert.rejects(executeToolAdapter({}, "sandbox_verify", { code: "return 1;" }), /Loader binding is not configured/);
  await assert.rejects(executeToolAdapter({}, "financial_policy_prepare", { text: "Pay 10 USD to Alex" }), /base URL is not configured/);
});

test("agent memory search is owner-scoped and falls back to durable D1 memory", async () => {
  const statements = [];
  const db = { prepare(sql) {
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async run() { statements.push({ sql, values }); return { meta: { changes: 1 } }; },
      async first() {
        if (sql.includes("SELECT * FROM memory_compaction_state")) return { active_generation: 1 };
        return null;
      },
      async all() {
        if (sql.includes("SELECT memory_key,memory_value,updated_at FROM agent_memory")) {
          return { results: [{ memory_key: "project.goal", memory_value: "Build evidence-backed agent workflows.", updated_at: "2026-11-12T00:00:00.000Z" }] };
        }
        return { results: [] };
      },
    };
  } };
  const result = await executeToolAdapter({
    DB: db,
    TELEGRAM_OWNER_ID: "8593447241",
  }, "memory_search", { query: "Transactra agent architecture" });
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.owner_scoped, true);
  assert.equal(parsed.provider, "d1");
  assert.equal(parsed.local_memories[0].key, "project.goal");
  assert.ok(statements.some(item => item.sql.includes("memory_compaction_state") && item.values[0] === "8593447241"));
});

test("agent memory writes persist to D1, enqueue Mem0 sync, and require owner approval", async () => {
  const statements = [], events = [];
  const db = { prepare(sql) {
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async run() { statements.push({ sql, values }); return { meta: { changes: 1 } }; },
    };
  } };
  const result = await executeToolAdapter({
    DB: db,
    TELEGRAM_OWNER_ID: "8593447241",
    EVENTS: { send: async event => events.push(event) },
  }, "memory_write", { key: "architecture.preference", value: "Keep task plans evidence-backed and owner-approved." }, {
    taskId: "tg-99",
    stepId: "step-2",
  });
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.stored_in, "D1");
  assert.equal(parsed.mem0_sync, "queued");
  assert.ok(statements.some(item => item.sql.includes("INSERT INTO agent_memory") && item.values[1] === "8593447241"));
  assert.ok(statements.some(item => item.sql.includes("INSERT OR IGNORE INTO memory_sync_outbox")));
  assert.deepEqual(events, [{ type: "memory.sync", ownerId: "8593447241", queuedAt: events[0].queuedAt }]);
  assert.equal(isSideEffectStep({ tool: "memory_write" }), true);
  assert.equal(isAgentToolAllowed("engineering-lead", "memory_write"), true);
  assert.equal(isAgentToolAllowed("security-officer", "memory_write"), false);
  assert.equal(isAgentToolAllowed("verifier", "memory_search"), true);
});
