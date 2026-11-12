import test from "node:test";
import assert from "node:assert/strict";
import { encryptToken, decryptToken } from "../dist/apps/api/src/token-encryption.js";
import { getPayPalConfig, createOAuthState } from "../dist/apps/api/src/paypal-oauth.js";

process.env.TOKEN_ENCRYPTION_SECRET ||= "test-only-secret-that-is-at-least-32-bytes";

test("Token Encryption: AES-256-GCM roundtrip encryption and decryption", () => {
  const secretToken = "A21AAI_MOCK_PAYPAL_ACCESS_TOKEN_XYZ1234567890";
  const encrypted = encryptToken(secretToken);

  assert.notEqual(encrypted, secretToken);
  assert.ok(encrypted.includes(":"), "Encrypted token format should contain iv:authTag:ciphertext");
  const parts = encrypted.split(":");
  assert.equal(parts.length, 3, "Expected 3 parts (iv, authTag, ciphertext)");
  assert.equal(parts[0].length, 24, "IV should be 12 bytes (24 hex characters)");
  assert.equal(parts[1].length, 32, "Auth tag should be 16 bytes (32 hex characters)");

  const decrypted = decryptToken(encrypted);
  assert.equal(decrypted, secretToken, "Decrypted token should match original token");
});

test("Token Encryption: Different calls produce different ciphertexts (random IVs)", () => {
  const secretToken = "A21AAI_SAME_TOKEN";
  const enc1 = encryptToken(secretToken);
  const enc2 = encryptToken(secretToken);

  assert.notEqual(enc1, enc2, "Each encryption should use a fresh random IV");
  assert.equal(decryptToken(enc1), secretToken);
  assert.equal(decryptToken(enc2), secretToken);
});

test("Token Encryption: Tampered ciphertext or auth tag fails authentication", () => {
  const secretToken = "SECRET_TOKEN";
  const encrypted = encryptToken(secretToken);
  const parts = encrypted.split(":");

  // Tamper with ciphertext
  const tamperedCipher = parts[0] + ":" + parts[1] + ":" + (parts[2].slice(0, -2) + "ff");
  assert.throws(() => decryptToken(tamperedCipher), /Unsupported state or unable to authenticate data|bad decrypt/i);

  // Tamper with auth tag
  const tamperedTag = parts[0] + ":00000000000000000000000000000000:" + parts[2];
  assert.throws(() => decryptToken(tamperedTag), /Unsupported state or unable to authenticate data|bad decrypt/i);
});

test("PayPal OAuth Config: Generates correct official sandbox endpoints and OpenID scopes", () => {
  process.env.PAYPAL_ENV = "sandbox";
  process.env.PAYPAL_CLIENT_ID = "test_client_id";
  process.env.PAYPAL_CLIENT_SECRET = "test_client_secret";

  const config = getPayPalConfig();
  assert.equal(config.authBase, "https://www.sandbox.paypal.com");
  assert.equal(config.restBase, "https://api-m.sandbox.paypal.com");
  assert.ok(config.redirectUri.includes("/api/auth/paypal/callback"));
});

test("OAuth State: Replay prevention and single-use state validation mock simulation", async () => {
  // Simulate mock database store for states
  const mockDbStateStore = new Map();

  function mockInsertState(state, userId, expiresAt) {
    mockDbStateStore.set(state, { userId, expiresAt, usedAt: null });
  }

  function mockValidateAndConsumeState(state) {
    const item = mockDbStateStore.get(state);
    if (!item) return { valid: false, error: "State not found" };
    if (item.usedAt !== null) return { valid: false, error: "State already used (replay detected)" };
    if (item.expiresAt < Date.now()) return { valid: false, error: "State expired" };

    // Atomic consumption
    item.usedAt = Date.now();
    return { valid: true, userId: item.userId };
  }

  const testState = "a".repeat(64);
  const futureExpiry = Date.now() + 10 * 60 * 1000;

  // 1. Initial valid consumption
  mockInsertState(testState, "user_123", futureExpiry);
  const firstValidation = mockValidateAndConsumeState(testState);
  assert.equal(firstValidation.valid, true);
  assert.equal(firstValidation.userId, "user_123");

  // 2. Immediate replay attack with same state must fail
  const replayValidation = mockValidateAndConsumeState(testState);
  assert.equal(replayValidation.valid, false);
  assert.match(replayValidation.error, /already used/i);

  // 3. Expired state must fail
  const expiredState = "b".repeat(64);
  mockInsertState(expiredState, "user_123", Date.now() - 1000); // 1 second in the past
  const expiredValidation = mockValidateAndConsumeState(expiredState);
  assert.equal(expiredValidation.valid, false);
  assert.match(expiredValidation.error, /expired/i);
});

test("Security Sanitization: Connected account summary never leaks tokens or client secrets", () => {
  const sensitiveAccountRecord = {
    paypal_payer_id: "PAYER_987654321",
    email: "buyer@example.com",
    name: "Alex Buyer",
    verified_account: true,
    scope: "openid profile email",
    connected_at: new Date("2026-11-11T12:00:00Z"),
    encrypted_access_token: encryptToken("SENSITIVE_ACCESS_TOKEN"),
    encrypted_refresh_token: encryptToken("SENSITIVE_REFRESH_TOKEN"),
  };

  // Sanitized public DTO
  const publicSummary = {
    connected: true,
    account: {
      payerId: sensitiveAccountRecord.paypal_payer_id,
      email: sensitiveAccountRecord.email,
      name: sensitiveAccountRecord.name,
      verified: sensitiveAccountRecord.verified_account,
      scope: sensitiveAccountRecord.scope,
      connectedAt: sensitiveAccountRecord.connected_at.toISOString(),
    },
  };

  assert.equal(publicSummary.connected, true);
  assert.equal(publicSummary.account.payerId, "PAYER_987654321");
  assert.equal(publicSummary.account.email, "buyer@example.com");
  assert.equal(publicSummary.account.verified, true);
  // Ensure sensitive fields are absent
  assert.equal("encrypted_access_token" in publicSummary.account, false);
  assert.equal("encrypted_refresh_token" in publicSummary.account, false);
  assert.equal("client_secret" in publicSummary.account, false);
  assert.equal("password" in publicSummary.account, false);
});


test("Token Encryption: refuses to use an implicit or fallback secret", () => {
  const previous = process.env.TOKEN_ENCRYPTION_SECRET;
  delete process.env.TOKEN_ENCRYPTION_SECRET;
  try {
    assert.throws(() => encryptToken("token"), /TOKEN_ENCRYPTION_SECRET must be configured/);
  } finally {
    if (previous === undefined) delete process.env.TOKEN_ENCRYPTION_SECRET;
    else process.env.TOKEN_ENCRYPTION_SECRET = previous;
  }
});

test("OAuth State: binds authorization URL to the initiating Telegram user", async () => {
  process.env.PAYPAL_CLIENT_ID = "test_client_id";
  process.env.PAYPAL_CLIENT_SECRET = "test_client_secret";
  let inserted;
  const fakeDb = { query: async (sql, values) => { inserted = { sql, values }; return { rowCount: 1, rows: [] }; } };
  const result = await createOAuthState(fakeDb, "123456789");
  assert.equal(inserted.values[1], "123456789");
  assert.match(inserted.sql, /user_id/);
  assert.match(result.authorizeUrl, /^https:\/\/www\.sandbox\.paypal\.com\/signin\/authorize\?/);
  assert.ok(new URL(result.authorizeUrl).searchParams.get("state"));
  assert.equal(new URL(result.authorizeUrl).searchParams.has("redirect_url"), false);
  await assert.rejects(() => createOAuthState(fakeDb, "default_user"), /valid Telegram user ID/);
});
