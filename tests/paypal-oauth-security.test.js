import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { encryptToken, decryptToken } from "../dist/apps/api/src/token-encryption.js";
import { getAuthenticatedRequestIdentity, signAuthGatewayAssertion } from "../dist/apps/api/src/request-auth.js";
import { createOAuthState, validateAndConsumeState, getConnectedAccountStatus, disconnectPayPalAccount } from "../dist/apps/api/src/paypal-oauth.js";

const secret = "gateway-test-secret-with-at-least-32-characters";
const sessionA = "a".repeat(48);
const sessionB = "b".repeat(48);
const timestamp = String(Date.now());
function requestFor(userId = "user-a", sessionId = sessionA, issuedAt = timestamp, signingSecret = secret) {
  return {
    headers: {
      "x-transactra-auth-user": userId,
      "x-transactra-auth-session": sessionId,
      "x-transactra-auth-timestamp": issuedAt,
      "x-transactra-auth-signature": signAuthGatewayAssertion(userId, sessionId, issuedAt, signingSecret)
    }
  };
}

test("auth gateway: accepts a valid signed user and session assertion", () => {
  const identity = getAuthenticatedRequestIdentity(requestFor(), Date.now(), secret);
  assert.equal(identity?.userId, "user-a");
  assert.equal(identity?.sessionHash, createHash("sha256").update(sessionA).digest("hex"));
});

test("auth gateway: rejects missing secret, forged signature, and stale assertion", () => {
  assert.equal(getAuthenticatedRequestIdentity(requestFor(), Date.now(), ""), null);
  const forged = requestFor();
  forged.headers["x-transactra-auth-signature"] = "0".repeat(64);
  assert.equal(getAuthenticatedRequestIdentity(forged, Date.now(), secret), null);
  const stale = requestFor("user-a", sessionA, String(Date.now() - 120_000));
  assert.equal(getAuthenticatedRequestIdentity(stale, Date.now(), secret), null);
});

test("OAuth state: session and user are both required to consume state", async () => {
  const expectedState = "c".repeat(64);
  let consumed = false;
  const db = {
    async query(sql, params) {
      assert.match(sql, /session_hash = \$2 AND user_id = \$3/);
      assert.equal(params[0], expectedState);
      if (params[1] !== createHash("sha256").update(sessionA).digest("hex") || params[2] !== "user-a" || consumed) {
        return { rowCount: 0, rows: [] };
      }
      consumed = true;
      return { rowCount: 1, rows: [{ user_id: "user-a", redirect_url: "https://app.example.com" }] };
    }
  };
  const wrongSession = await validateAndConsumeState(db, expectedState, createHash("sha256").update(sessionB).digest("hex"), "user-a");
  assert.equal(wrongSession.valid, false);
  const wrongUser = await validateAndConsumeState(db, expectedState, createHash("sha256").update(sessionA).digest("hex"), "user-b");
  assert.equal(wrongUser.valid, false);
  const valid = await validateAndConsumeState(db, expectedState, createHash("sha256").update(sessionA).digest("hex"), "user-a");
  assert.equal(valid.valid, true);
  const replay = await validateAndConsumeState(db, expectedState, createHash("sha256").update(sessionA).digest("hex"), "user-a");
  assert.equal(replay.valid, false);
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
  await assert.rejects(
    createOAuthState(db, "user-a", createHash("sha256").update(sessionA).digest("hex"), "https://attacker.example/steal"),
    /not allowlisted/
  );
  assert.equal(inserted, false);
  const result = await createOAuthState(db, "user-a", createHash("sha256").update(sessionA).digest("hex"), "https://app.example.com");
  assert.equal(inserted, true);
  assert.equal(insertArgs[1], "user-a");
  assert.equal(insertArgs[2], createHash("sha256").update(sessionA).digest("hex"));
  assert.equal(insertArgs[3], "https://app.example.com");
  assert.equal(new URL(result.authorizeUrl).origin, "https://www.sandbox.paypal.com");
});

test("account operations: user ID is always parameterized and has no shared default", async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith("SELECT")) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    }
  };
  await getConnectedAccountStatus(db, "user-a");
  await disconnectPayPalAccount(db, "user-b");
  assert.equal(calls[0].params[0], "user-a");
  assert.equal(calls[1].params[0], "user-b");
  await assert.rejects(getConnectedAccountStatus(db, ""), /Authenticated user is required/);
  await assert.rejects(disconnectPayPalAccount(db, ""), /Authenticated user is required/);
});

test("database migration: removes shared ownership defaults and adds session binding", () => {
  const migration = readFileSync(new URL("../infra/migrations/0006_paypal_oauth_security.sql", import.meta.url), "utf8");
  assert.match(migration, /ADD COLUMN IF NOT EXISTS session_hash TEXT/);
  assert.match(migration, /ALTER COLUMN user_id DROP DEFAULT/);
  assert.match(migration, /WHERE user_id = 'default_user'/);
  assert.match(migration, /encrypted_access_token = NULL/);
  assert.match(migration, /DELETE FROM paypal_oauth_states/);
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
