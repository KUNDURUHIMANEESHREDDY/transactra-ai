import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { encryptToken, decryptToken } from "../dist/apps/api/src/token-encryption.js";
import { verifyTelegramLogin, createTelegramSession, getAuthenticatedRequestIdentity, revokeTelegramSession } from "../dist/apps/api/src/request-auth.js";
import { createOAuthState, validateAndConsumeState, getConnectedAccountStatus, disconnectPayPalAccount } from "../dist/apps/api/src/paypal-oauth.js";
import { readFileSync } from "node:fs";

const botToken = "123456789:telegram-bot-token-for-tests";
function telegramPayload(overrides = {}, now = Math.floor(Date.now() / 1000)) {
  const fields = { id: "123456789", first_name: "Test User", username: "test_user", auth_date: String(now), ...overrides };
  const check = Object.keys(fields).sort().map((key) => key + "=" + String(fields[key])).join("\n");
  const secret = createHash("sha256").update(botToken).digest();
  return { ...fields, hash: createHmac("sha256", secret).update(check).digest("hex") };
}

test("Telegram Login Widget: verifies authentic Telegram HMAC payload", () => {
  const user = verifyTelegramLogin(telegramPayload(), botToken);
  assert.equal(user?.telegramId, "123456789");
  assert.equal(user?.firstName, "Test User");
  assert.equal(user?.username, "test_user");
  assert.match(user?.payloadHash || "", /^[a-f0-9]{64}$/);
});

test("Telegram Login Widget: rejects tampering, forged signature, and stale login payload", () => {
  const payload = telegramPayload();
  assert.equal(verifyTelegramLogin({ ...payload, first_name: "Attacker" }, botToken), null);
  assert.equal(verifyTelegramLogin({ ...payload, hash: "0".repeat(64) }, botToken), null);
  assert.equal(verifyTelegramLogin(telegramPayload({}, Math.floor(Date.now() / 1000) - 600), botToken), null);
  assert.equal(verifyTelegramLogin(telegramPayload({}, Math.floor(Date.now() / 1000) + 120), botToken), null);
  assert.equal(verifyTelegramLogin(payload, ""), null);
});

test("Telegram sessions: stores only a hash and issues HttpOnly SameSite cookie", async () => {
  let queryText = "";
  let params = [];
  const db = { async query(sql, args) { queryText = sql; params = args; return { rows: [], rowCount: 1 }; } };
  const headers = {};
  const response = { setHeader(name, value) { headers[name] = value; } };
  const user = verifyTelegramLogin(telegramPayload(), botToken);
  await createTelegramSession(db, user, response);
  assert.match(queryText, /telegram_login_events/);
  assert.match(queryText, /telegram_web_sessions/);
  assert.match(headers["Set-Cookie"], /HttpOnly; SameSite=Lax/);
  assert.doesNotMatch(headers["Set-Cookie"], /123456789/);
  assert.equal(params[1], "123456789");
  assert.match(params[0], /^[a-f0-9]{64}$/);
});

test("Telegram sessions: resolves identity from cookie-backed database session", async () => {
  const raw = "A".repeat(43);
  const expectedHash = createHash("sha256").update(raw).digest("hex");
  let args;
  const db = { async query(sql, values) { args = values; assert.match(sql, /revoked_at IS NULL/); return { rows: [{ user_id: "123456789", telegram_id: "123456789", first_name: "Test", username: "test" }], rowCount: 1 }; } };
  const identity = await getAuthenticatedRequestIdentity({ headers: { cookie: "transactra_session=" + raw } }, db);
  assert.equal(args[0], expectedHash);
  assert.equal(identity?.userId, "123456789");
  assert.equal(identity?.sessionHash, expectedHash);
});

test("Telegram sessions: logout revokes the server session and expires cookie", async () => {
  const raw = "B".repeat(43);
  let args;
  const db = { async query(sql, values) { assert.match(sql, /UPDATE telegram_web_sessions SET revoked_at/); args = values; return { rows: [], rowCount: 1 }; } };
  const headers = {};
  const response = { setHeader(name, value) { headers[name] = value; } };
  await revokeTelegramSession({ headers: { cookie: "transactra_session=" + raw } }, response, db);
  assert.equal(args[0], createHash("sha256").update(raw).digest("hex"));
  assert.match(headers["Set-Cookie"], /Max-Age=0/);
});

test("OAuth state: session and Telegram user are both required to consume state", async () => {
  const expectedState = "c".repeat(64);
  const sessionA = createHash("sha256").update("session-a").digest("hex");
  const sessionB = createHash("sha256").update("session-b").digest("hex");
  let consumed = false;
  const db = {
    async query(sql, params) {
      assert.match(sql, /session_hash = \$2 AND user_id = \$3/);
      if (params[1] !== sessionA || params[2] !== "123456789" || consumed) return { rowCount: 0, rows: [] };
      consumed = true;
      return { rowCount: 1, rows: [{ user_id: "123456789", redirect_url: "https://app.example.com" }] };
    }
  };
  assert.equal((await validateAndConsumeState(db, expectedState, sessionB, "123456789")).valid, false);
  assert.equal((await validateAndConsumeState(db, expectedState, sessionA, "999999999")).valid, false);
  assert.equal((await validateAndConsumeState(db, expectedState, sessionA, "123456789")).valid, true);
  assert.equal((await validateAndConsumeState(db, expectedState, sessionA, "123456789")).valid, false);
});

test("OAuth state: arbitrary redirect destinations are rejected before persistence", async () => {
  process.env.PAYPAL_CLIENT_ID = "test-client";
  process.env.PAYPAL_CLIENT_SECRET = "test-secret";
  process.env.FRONTEND_URL = "https://app.example.com";
  process.env.API_BASE_URL = "https://api.example.com";
  process.env.PAYPAL_REDIRECT_URI = "https://api.example.com/api/auth/paypal/callback";
  let inserted = false;
  let insertArgs;
  const db = { async query(sql, args) { inserted = true; insertArgs = args; assert.match(sql, /session_hash/); return { rowCount: 1, rows: [] }; } };
  const sessionHash = createHash("sha256").update("session-a").digest("hex");
  await assert.rejects(createOAuthState(db, "123456789", sessionHash, "https://attacker.example/steal"), /not allowlisted/);
  assert.equal(inserted, false);
  const result = await createOAuthState(db, "123456789", sessionHash, "https://app.example.com");
  assert.equal(inserted, true);
  assert.equal(insertArgs[1], "123456789");
  assert.equal(insertArgs[2], sessionHash);
  assert.equal(insertArgs[3], "https://app.example.com");
  assert.equal(new URL(result.authorizeUrl).origin, "https://www.sandbox.paypal.com");
});

test("account operations: user ID is always parameterized and has no shared default", async () => {
  const calls = [];
  const db = { async query(sql, params) { calls.push({ sql, params }); if (sql.startsWith("SELECT")) return { rowCount: 0, rows: [] }; return { rowCount: 1, rows: [] }; } };
  await getConnectedAccountStatus(db, "123456789");
  await disconnectPayPalAccount(db, "987654321");
  assert.equal(calls[0].params[0], "123456789");
  assert.equal(calls[1].params[0], "987654321");
  await assert.rejects(getConnectedAccountStatus(db, ""), /Authenticated user is required/);
  await assert.rejects(disconnectPayPalAccount(db, ""), /Authenticated user is required/);
});

test("database migrations: add Telegram sessions and isolate payment records by Telegram user", () => {
  const authMigration = readFileSync(new URL("../infra/migrations/0007_telegram_web_auth.sql", import.meta.url), "utf8");
  assert.match(authMigration, /CREATE TABLE IF NOT EXISTS telegram_web_sessions/);
  assert.match(authMigration, /session_hash TEXT PRIMARY KEY/);
  assert.match(authMigration, /CREATE TABLE IF NOT EXISTS telegram_login_events/);
  assert.match(authMigration, /payload_hash TEXT PRIMARY KEY/);
  const ownershipMigration = readFileSync(new URL("../infra/migrations/0008_telegram_user_isolation.sql", import.meta.url), "utf8");
  assert.match(ownershipMigration, /CREATE TABLE IF NOT EXISTS payment_transactions/);
  assert.match(ownershipMigration, /CREATE TABLE IF NOT EXISTS payment_workflows/);
  assert.match(ownershipMigration, /legacy_unassigned:/);
  assert.match(ownershipMigration, /ALTER COLUMN user_id SET NOT NULL/);
});

test("token encryption: missing dedicated secret fails closed", () => {
  const prior = process.env.TOKEN_ENCRYPTION_SECRET;
  delete process.env.TOKEN_ENCRYPTION_SECRET;
  try {
    assert.throws(() => encryptToken("paypal-access-token"), /TOKEN_ENCRYPTION_SECRET/);
    assert.throws(() => decryptToken("00".repeat(12) + ":" + "00".repeat(16) + ":00"), /TOKEN_ENCRYPTION_SECRET/);
  } finally {
    if (prior === undefined) delete process.env.TOKEN_ENCRYPTION_SECRET;
    else process.env.TOKEN_ENCRYPTION_SECRET = prior;
  }
});

test("token encryption: explicit independent secret supports authenticated roundtrip", () => {
  const token = "paypal-refresh-token";
  const encrypted = encryptToken(token, "another-independent-secret-with-32-chars");
  assert.equal(decryptToken(encrypted, "another-independent-secret-with-32-chars"), token);
  assert.throws(() => decryptToken(encrypted, "wrong-independent-secret-with-32-chars"));
});
