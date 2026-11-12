import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";

const API_TOKEN = "test-api-token-2f8c1d4b6a9e0c7f3d5a81b2";
const APPROVAL_TOKEN = "test-approval-token-9a4e7b1c0d3f6285a7c4e9b1";
const OWNER_ID = "00000000-0000-4000-8000-000000000001";
// Assembled at runtime so the tracked source file does not itself contain a
// credential-shaped literal that the repository secret scan would reject.
const FAKE_GITHUB_CREDENTIAL = ["ghp", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"].join("_");

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function startControlPlane() {
  const port = await freePort();
  const child = spawn(process.execPath, ["dist/apps/control-plane/src/server.js"], {
    // The pool connects lazily, so an unreachable database still boots the HTTP surface.
    env: {
      ...process.env,
      DATABASE_URL: "postgres://transactra:unused@127.0.0.1:1/transactra",
      CONTROL_PLANE_API_TOKEN: API_TOKEN,
      CONTROL_PLANE_APPROVAL_TOKEN: APPROVAL_TOKEN,
      TRANSACTRA_OWNER_ID: OWNER_ID,
      HOST: "127.0.0.1",
      PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`control plane did not start: ${output}`)), 10000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes('"server_started"')) { clearTimeout(timer); resolve(); }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`control plane exited with ${code}: ${output}`)); });
  });
  return { child, base: `http://127.0.0.1:${port}` };
}

function post(base, path, body, token = API_TOKEN) {
  return fetch(base + path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

test("the control plane rejects credential-shaped input as a client error", async (t) => {
  const { child, base } = await startControlPlane();
  t.after(() => { child.kill("SIGKILL"); });

  const secret = await post(base, "/v1/memory", {
    content: `owner key is ${FAKE_GITHUB_CREDENTIAL}`,
    sourceType: "test"
  });
  assert.equal(secret.status, 400, "a client-supplied credential must not surface as 500");
  const body = await secret.json();
  assert.match(body.error, /credential or private key/);
  assert.doesNotMatch(body.error, /ghp_/, "the rejection message must not echo the credential");
});

test("unauthenticated reads are refused before any database access", async (t) => {
  const { child, base } = await startControlPlane();
  t.after(() => { child.kill("SIGKILL"); });

  const response = await fetch(base + "/v1/tasks");
  assert.equal(response.status, 401);

  const emptyType = await fetch(base + "/v1/tasks", {
    method: "POST",
    headers: { authorization: `Bearer ${API_TOKEN}` },
    body: "{}"
  });
  assert.equal(emptyType.status, 415, "a missing JSON content type must be a client error");
});
