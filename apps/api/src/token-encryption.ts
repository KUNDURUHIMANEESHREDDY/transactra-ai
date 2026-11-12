import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function getEncryptionKey(customSecret?: string): Buffer {
  const secret = customSecret ?? process.env.TOKEN_ENCRYPTION_SECRET ?? "";
  if (secret.length < 32) {
    throw new Error("TOKEN_ENCRYPTION_SECRET must be configured with at least 32 characters.");
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

/** AES-256-GCM format: iv_hex:auth_tag_hex:ciphertext_hex */
export function encryptToken(plainText: string, customSecret?: string): string {
  if (!plainText) return "";
  const key = getEncryptionKey(customSecret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptToken(encryptedText: string, customSecret?: string): string {
  if (!encryptedText) return "";
  const parts = encryptedText.split(":");
  if (parts.length !== 3 || parts.some((part) => !/^(?:[a-f0-9]{2})*$/i.test(part))) {
    throw new Error("Invalid encrypted token format. Expected hex iv:authTag:ciphertext.");
  }
  const [ivHex, authTagHex, cipherHex] = parts as [string, string, string];
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(cipherHex, "hex");
  if (iv.length !== 12) throw new Error("Invalid IV length for AES-GCM");
  if (authTag.length !== 16) throw new Error("Invalid auth tag length for AES-GCM");
  const decipher = createDecipheriv("aes-256-gcm", getEncryptionKey(customSecret), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
