import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { buildToolAction, executeToolAdapter, hashToolAction, isSideEffectStep, validateToolInput } from "../src/tool-adapters.mjs";

const { privateKey: githubPrivateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const env = {
  GITHUB_APP_ID: "12345",
  GITHUB_APP_INSTALLATION_ID: "98765",
  GITHUB_APP_PRIVATE_KEY: githubPrivateKey.export({ type: "pkcs8", format: "pem" }),
  TRANSACTRA_GITHUB_REPOSITORY: "KUNDURUHIMANEESHREDDY/transactra",
  TRANSACTRA_D1_DATABASE_ID: "e7292f55-c90e-4d34-8b77-c97c3e5ec15a",
  TELEGRAM_BOT_TOKEN: "test-telegram-token",
  TELEGRAM_OWNER_ID: "8593447241",
};

test("tool input validation restricts repository paths and deployment targets", () => {
  assert.deepEqual(validateToolInput("repository_read", { path: "packages/agents/src/workforce.ts" }), { path: "packages/agents/src/workforce.ts" });
  assert.throws(() => validateToolInput("repository_read", { path: "../../.env" }), /approved source-file scope/);
  assert.throws(() => validateToolInput("repository_read", { path: "infra/cloudflare/wrangler.toml" }), /approved source-file scope/);
  assert.throws(() => validateToolInput("repository_write", { path: "packages/a.ts", content: "x", message: "change", expected_sha: null, branch: "production" }), /restricted to main/);
  assert.throws(() => validateToolInput("cloudflare_staging", { environment: "production" }), /Only the isolated staging/);
});

test("approval action hashes are deterministic and bind tool plus exact input", async () => {
  const step = { id: "step-1", agent: "builder", description: "Write a source file", acceptance_criteria: "The source file is committed", risk: "high", tool: "repository_write", tool_input: { path: "packages/a.ts", content: "export const a=1;", message: "Add a", expected_sha: null } };
  const action = buildToolAction(step);
  assert.equal(action.version, 1);
  assert.equal(action.tool, "repository_write");
  assert.equal(await hashToolAction(action), await hashToolAction(action));
  assert.notEqual(
    await hashToolAction(action),
    await hashToolAction({ ...action, input: { ...action.input, content: "export const a=2;" } }),
  );
});

test("web research uses only the fixed public Wikimedia search endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let requested;
  globalThis.fetch = async (url) => {
    requested = String(url);
    return new Response(JSON.stringify({ pages: [{ title: "Cloud computing", excerpt: "A cloud computing model" }] }), { status: 200 });
  };
  try {
    const result = await executeToolAdapter({}, "web_research", { query: "cloud computing" });
    assert.match(requested, /^https:\/\/en\.wikipedia\.org\/w\/rest\.php\/v1\/search\/page\?/);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.source, "Wikimedia public search");
    assert.equal(parsed.results[0].title, "Cloud computing");
    assert.equal(parsed.results[0].url, "https://en.wikipedia.org/wiki/Cloud_computing");
  } finally { globalThis.fetch = originalFetch; }
});

test("repository read is scoped to the private Transactra repository and returns decoded UTF-8", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl, headers;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("/app/installations/")) return new Response(JSON.stringify({ token: "test-installation-token", permissions: { contents: "write", actions: "write" }, repositories: [{ full_name: "KUNDURUHIMANEESHREDDY/transactra" }] }), { status: 201 });
    requestUrl = String(url); headers = options.headers;
    return new Response(JSON.stringify({
      type: "file", encoding: "base64", sha: "blob-sha",
      content: btoa(unescape(encodeURIComponent("export const value = '✓';"))),
    }), { status: 200 });
  };
  try {
    const result = await executeToolAdapter(env, "repository_read", { path: "packages/example.ts" });
    assert.match(requestUrl, /api\.github\.com\/repos\/KUNDURUHIMANEESHREDDY\/transactra\/contents\/packages\/example\.ts\?ref=main$/);
    assert.equal(headers.authorization, "Bearer test-installation-token");
    const output = JSON.parse(result.output);
    assert.match(output.content, /✓/);
    assert.equal(output.sha, "blob-sha");
  } finally { globalThis.fetch = originalFetch; }
});

test("GitHub App authentication converts downloaded PKCS1 keys and requests a repository-scoped RS256 installation token", async () => {
  const originalFetch = globalThis.fetch;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let claims, exchangeUrl, exchangeBody;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("/app/installations/")) {
      exchangeUrl = String(url);
      const jwt = options.headers.authorization.slice("Bearer ".length);
      claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
      exchangeBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ token: "scoped-token", permissions: { contents: "write", actions: "write" }, repositories: [{ full_name: "KUNDURUHIMANEESHREDDY/transactra" }] }), { status: 201 });
    }
    return new Response("Not Found", { status: 404 });
  };
  try {
    const result = await executeToolAdapter({
      ...env,
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }),
    }, "repository_read", { path: "README.md" });
    assert.equal(result.status, "not_found");
    assert.equal(exchangeUrl, "https://api.github.com/app/installations/98765/access_tokens");
    assert.equal(claims.iss, "12345");
    assert.equal(claims.exp - claims.iat, 600);
    assert.deepEqual(exchangeBody, {
      repositories: ["transactra"],
      permissions: { contents: "write", actions: "write" },
    });
  } finally { globalThis.fetch = originalFetch; }
});

test("repository write performs a SHA preflight and writes only the approved main-branch action", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("/app/installations/")) return new Response(JSON.stringify({ token: "test-installation-token", permissions: { contents: "write", actions: "write" }, repositories: [{ full_name: "KUNDURUHIMANEESHREDDY/transactra" }] }), { status: 201 });
    if (options.method === "GET") return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ content: { html_url: "https://github.com/KUNDURUHIMANEESHREDDY/transactra/blob/main/packages/new.ts" }, commit: { sha: "commit-sha" } }), { status: 201 });
  };
  try {
    const result = await executeToolAdapter(env, "repository_write", {
      path: "packages/new.ts", content: "export const x = 1;", message: "Add example", expected_sha: null, branch: "main",
    });
    assert.equal(calls.length, 3);
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[1].options.method, "GET");
    assert.equal(calls[2].options.method, "PUT");
    assert.equal(calls[1].options.headers.authorization, "Bearer test-installation-token");
    const body = JSON.parse(calls[2].options.body);
    assert.equal(body.branch, "main");
    assert.equal(decodeURIComponent(escape(atob(body.content))), "export const x = 1;");
    assert.match(body.message, /^\[Transactra approved\]/);
    assert.equal(JSON.parse(result.output).commit, "commit-sha");
  } finally { globalThis.fetch = originalFetch; }
});

test("staging adapter dispatches only the approved staging workflow to main", async () => {
  const originalFetch = globalThis.fetch;
  let call;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("/app/installations/")) return new Response(JSON.stringify({ token: "test-installation-token", permissions: { contents: "write", actions: "write" }, repositories: [{ full_name: "KUNDURUHIMANEESHREDDY/transactra" }] }), { status: 201 });
    call = { url: String(url), options };
    return new Response(null, { status: 204 });
  };
  try {
    const result = await executeToolAdapter(env, "cloudflare_staging", { environment: "staging" }, {
      taskId: "tg-123", stepId: "step-2", approvalId: "approval-123", actionHash: "a".repeat(64),
    });
    assert.match(call.url, /actions\/workflows\/deploy-staging\.yml\/dispatches$/);
    assert.equal(call.options.method, "POST");
    const body = JSON.parse(call.options.body);
    assert.equal(body.ref, "main");
    assert.equal(body.inputs.mode, "approved_action");
    assert.equal(body.inputs.approval_database_id, "e7292f55-c90e-4d34-8b77-c97c3e5ec15a");
    assert.equal(body.inputs.approval_id, "approval-123");
    assert.equal(JSON.parse(result.output).dispatch, "accepted");
    assert.equal(result.status, "dispatched", "workflow dispatch acceptance is not deployment completion");
    assert.equal(JSON.parse(result.output).deployment_complete, false);
  } finally { globalThis.fetch = originalFetch; }
});

test("Telegram adapter can notify only the configured owner", async () => {
  const originalFetch = globalThis.fetch;
  let payload;
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /^https:\/\/api\.telegram\.org\/bottest-telegram-token\/sendMessage$/);
    payload = JSON.parse(options.body);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
  };
  try {
    const result = await executeToolAdapter(env, "telegram_notify", { message: "Approval required" });
    assert.equal(payload.chat_id, "8593447241");
    assert.equal(payload.text, "Approval required");
    assert.equal(JSON.parse(result.output).delivered_to_owner, true);
  } finally { globalThis.fetch = originalFetch; }
});

test("private repository tools fail closed when GitHub App credentials are absent", async () => {
  await assert.rejects(
    executeToolAdapter({}, "repository_read", { path: "README.md" }),
    /GitHub App ID, installation ID and private key are required/,
  );
});

test("staging verification reads health and readiness without a deployment credential", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    if (String(url).endsWith("/health")) return new Response(JSON.stringify({ ok: true, service: "transactra-edge" }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, ready: true, planner: "d1-native", inference: "disabled" }), { status: 200 });
  };
  try {
    const step = { tool: "cloudflare_staging", risk: "low", tool_input: { environment: "staging", operation: "verify" } };
    assert.equal(isSideEffectStep(step), false);
    const result = await executeToolAdapter({
      TRANSACTRA_STAGING_BASE_URL: "https://transactra-edge-staging.himaneeshreddyk.workers.dev",
    }, "cloudflare_staging", step.tool_input);
    assert.deepEqual(requested, [
      "https://transactra-edge-staging.himaneeshreddyk.workers.dev/health",
      "https://transactra-edge-staging.himaneeshreddyk.workers.dev/ready",
    ]);
    assert.equal(JSON.parse(result.output).ready, true);
  } finally { globalThis.fetch = originalFetch; }
});

test("staging deployment is a side effect while staging verification is read-only", () => {
  assert.equal(isSideEffectStep({ tool: "cloudflare_staging", tool_input: { environment: "staging" } }), true);
  assert.equal(isSideEffectStep({ tool: "cloudflare_staging", tool_input: { environment: "staging", operation: "verify" } }), false);
});

test("repository write rejects stale approved file SHAs without issuing a PUT", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("/app/installations/")) return new Response(JSON.stringify({ token: "test-installation-token", permissions: { contents: "write", actions: "write" }, repositories: [{ full_name: "KUNDURUHIMANEESHREDDY/transactra" }] }), { status: 201 });
    return new Response(JSON.stringify({ type: "file", sha: "b".repeat(40) }), { status: 200 });
  };
  try {
    await assert.rejects(
      executeToolAdapter(env, "repository_write", {
        path: "packages/existing.ts", content: "export const x = 2;", message: "Update file", expected_sha: "a".repeat(40),
      }),
      /changed since owner approval/,
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[1].options.method, "GET");
  } finally { globalThis.fetch = originalFetch; }
});

test("repository read reports a missing path without attempting a write", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/app/installations/")) return new Response(JSON.stringify({ token: "test-installation-token", permissions: { contents: "write", actions: "write" }, repositories: [{ full_name: "KUNDURUHIMANEESHREDDY/transactra" }] }), { status: 201 });
    return new Response("not found", { status: 404 });
  };
  try {
    const result = await executeToolAdapter(env, "repository_read", { path: "packages/new-file.ts" });
    assert.equal(result.status, "not_found");
    assert.deepEqual(JSON.parse(result.output), {
      repository: "KUNDURUHIMANEESHREDDY/transactra",
      path: "packages/new-file.ts",
      exists: false,
      expected_sha: null,
    });
  } finally { globalThis.fetch = originalFetch; }
});
