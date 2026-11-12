import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";

export type AuthenticatedRequestIdentity = {
  userId: string;
  sessionId: string;
  sessionHash: string;
};

const MAX_CLOCK_SKEW_MS = 60_000;

/**
 * The edge authentication gateway must authenticate the browser session, strip any
 * client-supplied x-transactra-auth-* headers, and inject a signed assertion on every
 * request. The same stable session ID must be asserted on the PayPal callback.
 */
export function signAuthGatewayAssertion(userId: string, sessionId: string, timestamp: string, secret: string): string {
  return createHmac("sha256", secret).update(userId + "\n" + sessionId + "\n" + timestamp).digest("hex");
}

export function getAuthenticatedRequestIdentity(
  request: IncomingMessage,
  now = Date.now(),
  secret = process.env.AUTH_GATEWAY_SHARED_SECRET || ""
): AuthenticatedRequestIdentity | null {
  if (secret.length < 32) return null;

  const userId = request.headers["x-transactra-auth-user"];
  const sessionId = request.headers["x-transactra-auth-session"];
  const timestamp = request.headers["x-transactra-auth-timestamp"];
  const signature = request.headers["x-transactra-auth-signature"];
  if (typeof userId !== "string" || !/^[A-Za-z0-9._:@-]{1,128}$/.test(userId)) return null;
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(sessionId)) return null;
  if (typeof timestamp !== "string" || !/^\d{13}$/.test(timestamp)) return null;
  if (typeof signature !== "string" || !/^[a-f0-9]{64}$/i.test(signature)) return null;

  const issuedAt = Number(timestamp);
  if (!Number.isSafeInteger(issuedAt) || Math.abs(now - issuedAt) > MAX_CLOCK_SKEW_MS) return null;

  const expected = Buffer.from(signAuthGatewayAssertion(userId, sessionId, timestamp, secret), "hex");
  const supplied = Buffer.from(signature, "hex");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;

  return {
    userId,
    sessionId,
    sessionHash: createHash("sha256").update(sessionId).digest("hex"),
  };
}
