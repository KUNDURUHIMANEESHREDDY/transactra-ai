import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function getEncryptionKey(customSecret?: string): Buffer {
  const secret = customSecret ?? process.env.TOKEN_ENCRYPTION_SECRET;
  if (!secret || secret.trim().length < 32) {
    throw new Error("TOKEN_ENCRYPTION_SECRET must be configured with at least 32 characters.");
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

/** AES-256-GCM format: iv_hex:auth_tag_hex:ciphertext_hex. */
export function encryptToken(plainText: string, customSecret?: string): string {
  if (!plainText) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(customSecret), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  return iv.toString("hex") + ":" + cipher.getAuthTag().toString("hex") + ":" + encrypted.toString("hex");
}

export function decryptToken(encryptedText: string, customSecret?: string): string {
  if (!encryptedText) return "";
  const parts = encryptedText.split(":");
  if (parts.length !== 3 || !/^[0-9a-f]{24}$/i.test(parts[0]!) || !/^[0-9a-f]{32}$/i.test(parts[1]!) || !/^(?:[0-9a-f]{2})*$/i.test(parts[2]!)) {
    throw new Error("Invalid encrypted token format. Expected iv:authTag:ciphertext.");
  }
  const decipher = createDecipheriv("aes-256-gcm", getEncryptionKey(customSecret), Buffer.from(parts[0]!, "hex"));
  decipher.setAuthTag(Buffer.from(parts[1]!, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(parts[2]!, "hex")), decipher.final()]).toString("utf8");
}
