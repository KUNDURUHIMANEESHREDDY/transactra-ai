import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

function authSecret(): string {
  const secret = process.env.TRANSACTRA_AUTH_HEADER_SECRET || "";
  if (secret.length < 32) throw new Error("TRANSACTRA_AUTH_HEADER_SECRET must be configured with at least 32 characters.");
  return secret;
}

export function signAuthenticatedUser(userId: string, timestamp = Math.floor(Date.now() / 1000), secret = authSecret()): string {
  return createHmac("sha256", secret).update(userId + "." + timestamp).digest("hex");
}

/** Trust only identity headers signed by the configured authentication gateway. */
export function getAuthenticatedUser(req: IncomingMessage): string | null {
  const userId = String(req.headers["x-transactra-user-id"] || "");
  const timestampText = String(req.headers["x-transactra-auth-timestamp"] || "");
  const signature = String(req.headers["x-transactra-auth-signature"] || "");
  if (!/^[A-Za-z0-9._:@-]{1,128}$/.test(userId) || !/^\d{10}$/.test(timestampText) || !/^[0-9a-f]{64}$/i.test(signature)) return null;
  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) return null;
  let expected: Buffer;
  try { expected = Buffer.from(signAuthenticatedUser(userId, timestamp), "hex"); }
  catch { return null; }
  const supplied = Buffer.from(signature, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected) ? userId : null;
}
