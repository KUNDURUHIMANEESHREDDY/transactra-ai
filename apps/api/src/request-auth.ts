import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export type AuthenticatedRequestIdentity = {
  userId: string;
  sessionId: string;
  sessionHash: string;
  telegramId: string;
  firstName: string;
  username: string | null;
};

type Queryable = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
};

const SESSION_COOKIE = process.env.NODE_ENV === "production" ? "__Host-transactra_session" : "transactra_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const TELEGRAM_MAX_AGE_SECONDS = 5 * 60;

/** Verify Telegram Login Widget's signed user payload. Never trust unsigned Telegram profile fields. */
export function verifyTelegramLogin(
  payload: Record<string, unknown>,
  token = process.env.TELEGRAM_BOT_TOKEN || "",
  nowSeconds = Math.floor(Date.now() / 1000)
): { telegramId: string; firstName: string; lastName: string | null; username: string | null; photoUrl: string | null; payloadHash: string } | null {
  if (!token || typeof payload.hash !== "string" || !/^[a-f0-9]{64}$/i.test(payload.hash)) return null;
  const authDate = Number(payload.auth_date);
  const telegramId = String(payload.id ?? "");
  const firstName = typeof payload.first_name === "string" ? payload.first_name : "";
  if (!/^\d{1,20}$/.test(telegramId) || !Number.isSafeInteger(authDate) || authDate > nowSeconds + 30 || nowSeconds - authDate > TELEGRAM_MAX_AGE_SECONDS || !firstName || firstName.length > 128) return null;

  const checkString = Object.keys(payload)
    .filter((key) => key !== "hash" && payload[key] !== undefined && payload[key] !== null)
    .sort()
    .map((key) => key + "=" + String(payload[key]))
    .join("\n");
  const secretKey = createHash("sha256").update(token).digest();
  const expected = createHmac("sha256", secretKey).update(checkString).digest();
  const supplied = Buffer.from(payload.hash, "hex");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;

  return {
    telegramId,
    firstName,
    lastName: typeof payload.last_name === "string" ? payload.last_name.slice(0, 128) : null,
    username: typeof payload.username === "string" ? payload.username.slice(0, 64) : null,
    photoUrl: typeof payload.photo_url === "string" && payload.photo_url.length <= 2048 ? payload.photo_url : null,
    payloadHash: createHash("sha256").update(payload.hash).digest("hex")
  };
}

export async function createTelegramSession(
  db: Queryable,
  user: { telegramId: string; firstName: string; lastName: string | null; username: string | null; photoUrl: string | null; payloadHash: string },
  response: ServerResponse
): Promise<void> {
  const rawSession = randomBytes(32).toString("base64url");
  const sessionHash = createHash("sha256").update(rawSession).digest("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await db.query(
    `WITH expired_logins AS (
       DELETE FROM telegram_login_events WHERE consumed_at < NOW() - INTERVAL '10 minutes' RETURNING payload_hash
     ), accepted_login AS (
       INSERT INTO telegram_login_events (payload_hash) VALUES ($8) RETURNING payload_hash
     )
     INSERT INTO telegram_web_sessions (session_hash, telegram_id, user_id, first_name, last_name, username, photo_url, expires_at)
     SELECT $1,$2,$2,$3,$4,$5,$6,$7 FROM accepted_login`,
    [sessionHash, user.telegramId, user.firstName, user.lastName, user.username, user.photoUrl, expiresAt, user.payloadHash]
  );
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=${rawSession}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`);
}

export async function getAuthenticatedRequestIdentity(request: IncomingMessage, db: Queryable): Promise<AuthenticatedRequestIdentity | null> {
  const cookieHeader = request.headers.cookie || "";
  const cookie = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(SESSION_COOKIE + "="));
  const rawSession = cookie?.slice(SESSION_COOKIE.length + 1);
  if (!rawSession || !/^[A-Za-z0-9_-]{40,64}$/.test(rawSession)) return null;
  const sessionHash = createHash("sha256").update(rawSession).digest("hex");
  const result = await db.query(
    `SELECT user_id, telegram_id, first_name, username
     FROM telegram_web_sessions
     WHERE session_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()
     LIMIT 1`,
    [sessionHash]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    userId: String(row.user_id),
    telegramId: String(row.telegram_id),
    firstName: String(row.first_name),
    username: typeof row.username === "string" ? row.username : null,
    sessionId: sessionHash,
    sessionHash
  };
}

export async function revokeTelegramSession(request: IncomingMessage, response: ServerResponse, db: Queryable): Promise<void> {
  const cookieHeader = request.headers.cookie || "";
  const cookie = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(SESSION_COOKIE + "="));
  const rawSession = cookie?.slice(SESSION_COOKIE.length + 1);
  if (rawSession && /^[A-Za-z0-9_-]{40,64}$/.test(rawSession)) {
    const hash = createHash("sha256").update(rawSession).digest("hex");
    await db.query("UPDATE telegram_web_sessions SET revoked_at=NOW() WHERE session_hash=$1 AND revoked_at IS NULL", [hash]);
  }
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

export function telegramBotUsername(): string {
  return (process.env.TELEGRAM_BOT_USERNAME || "").replace(/^@/, "");
}
