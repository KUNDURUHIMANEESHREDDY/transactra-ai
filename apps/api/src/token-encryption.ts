import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const DEFAULT_SECRET = "transactra-default-oauth-token-encryption-secret-key-32b";

function getEncryptionKey(customSecret?: string): Buffer {
  const secret = customSecret ||
    process.env.TOKEN_ENCRYPTION_SECRET ||
    process.env.PAYPAL_CLIENT_SECRET ||
    process.env.BACKEND_SHARED_SECRET ||
    DEFAULT_SECRET;

  return createHash("sha256").update(secret).digest();
}

/**
 * Encrypts a sensitive string (such as an OAuth access or refresh token)
 * using AES-256-GCM authenticated encryption.
 *
 * Format: iv_hex:auth_tag_hex:ciphertext_hex
 */
export function encryptToken(plainText: string, customSecret?: string): string {
  if (!plainText) return "";

  const key = getEncryptionKey(customSecret);
  const iv = randomBytes(12); // Standard 96-bit IV for AES-GCM
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plainText, "utf8"),
    cipher.final()
  ]);

  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypts a token encrypted with AES-256-GCM.
 * Verifies authenticity with the authentication tag; throws if tampered or invalid.
 */
export function decryptToken(encryptedText: string, customSecret?: string): string {
  if (!encryptedText) return "";

  const parts = encryptedText.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted token format. Expected iv:authTag:ciphertext");
  }

  const ivHex = parts[0]!;
  const authTagHex = parts[1]!;
  const cipherHex = parts[2]!;

  const key = getEncryptionKey(customSecret);
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(cipherHex, "hex");

  if (iv.length !== 12) {
    throw new Error("Invalid IV length for AES-GCM");
  }
  if (authTag.length !== 16) {
    throw new Error("Invalid auth tag length for AES-GCM");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]);

  return decrypted.toString("utf8");
}
