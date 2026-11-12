import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const SESSION_COOKIE = "transactra_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

function authSecret(): string {
  const secret = process.env.TRANSACTRA_AUTH_HEADER_SECRET || "";
  if (secret.length < 32) throw new Error("A dedicated TRANSACTRA_AUTH_HEADER_SECRET (32+ characters) must be configured.");
  return secret;
}

export function signAuthenticatedUser(userId: string, timestamp = Math.floor(Date.now() / 1000), secret = authSecret()): string {
  return createHmac("sha256", secret).update(userId + "." + timestamp).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(a) || !/^[0-9a-f]{64}$/i.test(b)) return false;
  const left = Buffer.from(a, "hex"), right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Verify Telegram Mini App initData using Telegram's documented two-stage HMAC. */
export function verifyTelegramWebAppInitData(initData: string, botToken = process.env.TELEGRAM_BOT_TOKEN || "", now = Math.floor(Date.now() / 1000)): { userId: string; authDate: number } | null {
  if (!botToken || !initData || initData.length > 8192) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash") || "";
    const authDate = Number(params.get("auth_date") || 0);
    const userRaw = params.get("user") || "";
    if (!/^[0-9a-f]{64}$/i.test(hash) || !Number.isSafeInteger(authDate) || authDate > now + 30 || now - authDate > 300) return null;
    const checkString = [...params.entries()].filter(([key]) => key !== "hash").sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => key + "=" + value).join("\n");
    const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
    const expected = createHmac("sha256", secretKey).update(checkString).digest("hex");
    if (!safeEqualHex(hash, expected)) return null;
    const user = JSON.parse(userRaw) as { id?: number | string };
    const telegramId = String(user.id || "");
    if (!/^\d{1,20}$/.test(telegramId)) return null;
    return { userId: "telegram:" + telegramId, authDate };
  } catch { return null; }
}

/** Issue an eight-hour, HttpOnly, server-signed browser session after Telegram validation. */
export function createAuthenticatedSessionCookie(userId: string, now = Math.floor(Date.now() / 1000)): string {
  if (!/^telegram:\d{1,20}$/.test(userId)) throw new Error("Invalid Telegram identity.");
  const payload = Buffer.from(JSON.stringify({ sub: userId, iat: now, exp: now + SESSION_TTL_SECONDS })).toString("base64url");
  const signature = createHmac("sha256", authSecret()).update("session." + payload).digest("hex");
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return SESSION_COOKIE + "=" + payload + "." + signature + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=" + SESSION_TTL_SECONDS + secure;
}

export function clearAuthenticatedSessionCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return SESSION_COOKIE + "=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" + secure;
}

function userFromSessionCookie(req: IncomingMessage): string | null {
  const raw = String(req.headers.cookie || "").split(";").map(x => x.trim()).find(x => x.startsWith(SESSION_COOKIE + "="))?.slice(SESSION_COOKIE.length + 1) || "";
  const [payload, signature, extra] = raw.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  try {
    const expected = createHmac("sha256", authSecret()).update("session." + payload).digest("hex");
    if (!safeEqualHex(signature, expected)) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: string; iat?: number; exp?: number };
    const now = Math.floor(Date.now() / 1000);
    if (!data.sub || !/^telegram:\d{1,20}$/.test(data.sub) || !Number.isSafeInteger(data.iat) || !Number.isSafeInteger(data.exp) || (data.exp as number) <= now || (data.iat as number) > now + 30 || (data.exp as number) - (data.iat as number) > SESSION_TTL_SECONDS) return null;
    return data.sub;
  } catch { return null; }
}

/** Trust a signed gateway identity or a server-issued Telegram session cookie. */
export function getAuthenticatedUser(req: IncomingMessage): string | null {
  const userId = String(req.headers["x-transactra-user-id"] || "");
  const timestampText = String(req.headers["x-transactra-auth-timestamp"] || "");
  const signature = String(req.headers["x-transactra-auth-signature"] || "");
  if (/^[A-Za-z0-9._:@-]{1,128}$/.test(userId) && /^\d{10}$/.test(timestampText) && /^[0-9a-f]{64}$/i.test(signature)) {
    const timestamp = Number(timestampText);
    if (Number.isSafeInteger(timestamp) && Math.abs(Math.floor(Date.now() / 1000) - timestamp) <= 300) {
      try { if (safeEqualHex(signature, signAuthenticatedUser(userId, timestamp))) return userId; } catch { /* fall through to cookie */ }
    }
  }
  return userFromSessionCookie(req);
}
