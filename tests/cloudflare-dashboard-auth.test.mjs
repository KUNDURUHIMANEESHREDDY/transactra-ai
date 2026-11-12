import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker from "../infra/dashboard/index.mjs";

const botToken = "123456:TEST_BOT_TOKEN";
const ownerId = "8593447241";
const authSecret = "test-session-secret-with-at-least-thirty-two-bytes";
function initData({ id = ownerId, authDate = Math.floor(Date.now() / 1000) } = {}) {
  const fields = new URLSearchParams({
    auth_date: String(authDate),
    query_id: "AAEAAAE",
    user: JSON.stringify({ id: Number(id), first_name: "Test" })
  });
  const check = [...fields.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + "=" + v).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  fields.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return fields.toString();
}
const env = { TELEGRAM_BOT_TOKEN: botToken, TELEGRAM_OWNER_ID: ownerId, TRANSACTRA_AUTH_HEADER_SECRET: authSecret };
test("Cloudflare dashboard Worker accepts valid Telegram initData and issues a secure session", async () => {
  const response = await worker.fetch(new Request("https://dashboard.test/api/auth/telegram/session", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ initData: initData() })
  }), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie") || "", /HttpOnly/);
  assert.match(response.headers.get("set-cookie") || "", /Secure/);
  assert.match(response.headers.get("set-cookie") || "", /SameSite=Lax/);
  const body = await response.json();
  assert.equal(body.user.id, "telegram:" + ownerId);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const session = await worker.fetch(new Request("https://dashboard.test/api/auth/session", { headers: { cookie } }), env);
  assert.equal(session.status, 200);
  assert.equal((await session.json()).authenticated, true);
});
test("Cloudflare dashboard Worker rejects tampered, stale, and non-owner Telegram initData", async () => {
  for (const data of [initData() + "x", initData({ authDate: Math.floor(Date.now() / 1000) - 301 }), initData({ id: "123" })]) {
    const response = await worker.fetch(new Request("https://dashboard.test/api/auth/telegram/session", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ initData: data })
    }), env);
    assert.equal(response.status, 401);
  }
});
test("Cloudflare dashboard Worker rejects missing and tampered session cookies", async () => {
  const missing = await worker.fetch(new Request("https://dashboard.test/api/auth/session"), env);
  assert.equal(missing.status, 401);
  const tampered = await worker.fetch(new Request("https://dashboard.test/api/auth/session", {
    headers: { cookie: "transactra_session=not-a-valid-session" }
  }), env);
  assert.equal(tampered.status, 401);
});
