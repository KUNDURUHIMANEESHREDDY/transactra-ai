import { createHash, randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const MAGIC = Buffer.from("TRANSACTRA_D1_BACKUP_V1\n", "utf8");
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

function keyFrom(passphrase, salt) {
  if (typeof passphrase !== "string" || passphrase.length < 32) {
    throw new Error("D1_BACKUP_ENCRYPTION_PASSPHRASE must contain at least 32 characters.");
  }
  return scryptSync(passphrase, salt, KEY_BYTES, { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
}

async function sha256(path) {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}

const [command, input, output, expectedHash] = process.argv.slice(2);
if (!["encrypt", "decrypt", "sha256"].includes(command) || !input || (command !== "sha256" && !output)) {
  throw new Error("Usage: node scripts/d1-backup-crypto.mjs <encrypt|decrypt|sha256> <input> [output] [expected-sha256]");
}
const passphrase = process.env.D1_BACKUP_ENCRYPTION_PASSPHRASE;

if (command === "encrypt") {
  const plaintext = await readFile(input);
  if (plaintext.length === 0) throw new Error("Refusing to encrypt an empty D1 export.");
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(passphrase, salt), iv);
  cipher.setAAD(MAGIC);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  await writeFile(output, Buffer.concat([MAGIC, salt, iv, tag, ciphertext]), { mode: 0o600 });
  console.log(JSON.stringify({ encrypted: true, plaintextBytes: plaintext.length, ciphertextBytes: ciphertext.length }));
} else if (command === "decrypt") {
  const packed = await readFile(input);
  const headerLength = MAGIC.length + SALT_BYTES + IV_BYTES + TAG_BYTES;
  if (packed.length <= headerLength || !packed.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("Backup format/version is invalid.");
  }
  let offset = MAGIC.length;
  const salt = packed.subarray(offset, offset += SALT_BYTES);
  const iv = packed.subarray(offset, offset += IV_BYTES);
  const tag = packed.subarray(offset, offset += TAG_BYTES);
  const ciphertext = packed.subarray(offset);
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(passphrase, salt), iv);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const digest = createHash("sha256").update(plaintext).digest("hex");
  if (expectedHash && digest !== expectedHash) throw new Error("Decrypted SQL SHA-256 does not match the recorded manifest.");
  await writeFile(output, plaintext, { mode: 0o600 });
  console.log(JSON.stringify({ decrypted: true, plaintextBytes: plaintext.length, sha256: digest }));
} else {
  console.log(await sha256(input));
}
