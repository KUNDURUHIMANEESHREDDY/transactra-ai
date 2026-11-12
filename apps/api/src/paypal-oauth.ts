import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { encryptToken } from "./token-encryption.js";

export type PayPalConfig = {
  clientId: string;
  clientSecret: string;
  env: "sandbox" | "live";
  authBase: string;
  restBase: string;
  redirectUri: string;
  frontendUrl: string;
};
export type PayPalTokenResponse = {
  access_token: string; token_type: string; expires_in: number;
  refresh_token?: string; scope?: string; id_token?: string;
  error?: string; error_description?: string;
};
export type PayPalUserInfo = { payerId: string; email?: string; name?: string; verifiedAccount: boolean };
export type ConnectedAccountSummary = {
  payerId: string; email: string | null; name: string | null; verified: boolean;
  connectedAt: string; scope: string | null;
};

function validateHttpUrl(value: string, label: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(label + " must be an absolute URL."); }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
    throw new Error(label + " is not a permitted URL.");
  }
  if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") {
    throw new Error(label + " must use HTTPS in production.");
  }
  if (parsed.protocol === "http:" && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    throw new Error(label + " may use HTTP only on localhost.");
  }
  return parsed.toString().replace(/\/$/, "");
}

export function getPayPalConfig(_requestHost?: string): PayPalConfig {
  const clientId = process.env.PAYPAL_CLIENT_ID || "";
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET || "";
  const isLive = process.env.NODE_ENV === "production" || process.env.PAYPAL_ENV === "live";
  const authBase = isLive ? "https://www.paypal.com" : "https://www.sandbox.paypal.com";
  const restBase = isLive ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  const apiBase = validateHttpUrl(process.env.API_BASE_URL || "http://127.0.0.1:8787", "API_BASE_URL");
  const frontendUrl = validateHttpUrl(process.env.FRONTEND_URL || "http://localhost:5173", "FRONTEND_URL");
  const redirectUri = validateHttpUrl(process.env.PAYPAL_REDIRECT_URI || apiBase + "/api/auth/paypal/callback", "PAYPAL_REDIRECT_URI");
  if (process.env.NODE_ENV === "production" && (!process.env.PAYPAL_REDIRECT_URI || !process.env.FRONTEND_URL || !process.env.API_BASE_URL)) {
    throw new Error("Production requires explicit HTTPS API_BASE_URL, FRONTEND_URL and PAYPAL_REDIRECT_URI values.");
  }
  return { clientId, clientSecret, env: isLive ? "live" : "sandbox", authBase, restBase, redirectUri, frontendUrl };
}

export function resolveAllowedRedirect(requested: string | undefined, config = getPayPalConfig()): string {
  const configured = (process.env.PAYPAL_ALLOWED_REDIRECT_URLS || config.frontendUrl)
    .split(",").map(value => value.trim()).filter(Boolean)
    .map(value => validateHttpUrl(value, "PAYPAL_ALLOWED_REDIRECT_URLS"));
  const candidate = validateHttpUrl(requested || config.frontendUrl, "OAuth redirect URL");
  if (!configured.includes(candidate)) throw new Error("OAuth redirect URL is not allowlisted.");
  return candidate;
}

export function createOAuthSessionToken(): string {
  return randomBytes(32).toString("base64url");
}
export function hashOAuthSession(sessionToken: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) throw new Error("Invalid OAuth browser session.");
  return createHash("sha256").update(sessionToken).digest("hex");
}

export async function ensurePayPalConnectionSchema(db: Pool): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS paypal_oauth_states (
      state TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_hash TEXT NOT NULL,
      redirect_url TEXT NOT NULL,
      launch_used_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS paypal_oauth_states_expiry_idx ON paypal_oauth_states(expires_at) WHERE used_at IS NULL;
    CREATE TABLE IF NOT EXISTS paypal_connected_accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL,
      paypal_payer_id TEXT NOT NULL,
      email TEXT,
      name TEXT,
      verified_account BOOLEAN NOT NULL DEFAULT false,
      encrypted_access_token TEXT,
      encrypted_refresh_token TEXT,
      token_expires_at TIMESTAMPTZ,
      scope TEXT,
      status TEXT NOT NULL DEFAULT 'CONNECTED' CHECK (status IN ('CONNECTED', 'DISCONNECTED', 'REVOKED')),
      connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(user_id)
    );
    CREATE INDEX IF NOT EXISTS paypal_connected_accounts_payer_idx ON paypal_connected_accounts(paypal_payer_id);
  `);
  await db.query("ALTER TABLE paypal_oauth_states ADD COLUMN IF NOT EXISTS launch_used_at TIMESTAMPTZ");
}

export async function createOAuthState(
  db: Pool, userId: string, sessionHash: string, customRedirectUrl?: string
): Promise<{ state: string; authorizeUrl: string }> {
  if (!/^telegram:\d{1,20}$/.test(userId)) throw new Error("A valid Telegram user ID is required.");
  if (!/^[0-9a-f]{64}$/i.test(sessionHash)) throw new Error("A valid browser session is required.");
  const config = getPayPalConfig();
  if (!config.clientId || !config.clientSecret) throw new Error("PayPal credentials are not configured on the server.");
  const redirectUrl = resolveAllowedRedirect(customRedirectUrl, config);
  const state = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await db.query(
    "INSERT INTO paypal_oauth_states (state, user_id, session_hash, redirect_url, expires_at) VALUES ($1, $2, $3, $4, $5)",
    [state, userId, sessionHash, redirectUrl, expiresAt]
  );
  const params = new URLSearchParams({
    client_id: config.clientId, response_type: "code", scope: "openid profile email",
    redirect_uri: config.redirectUri, state, prompt: "login"
  });
  return { state, authorizeUrl: config.authBase + "/signin/authorize?" + params.toString() };
}

export async function validateAndConsumeState(
  db: Pool, state: string, sessionHash: string
): Promise<{ valid: boolean; userId?: string; redirectUrl?: string; error?: string }> {
  if (!state || typeof state !== "string" || !/^[0-9a-f]{64}$/i.test(state)) {
    return { valid: false, error: "Invalid or missing OAuth state parameter." };
  }
  if (!/^[0-9a-f]{64}$/i.test(sessionHash)) {
    return { valid: false, error: "OAuth browser session is missing." };
  }
  const result = await db.query<{ user_id: string; redirect_url: string }>(
    "UPDATE paypal_oauth_states SET used_at = NOW() WHERE state = $1 AND session_hash = $2 AND launch_used_at IS NOT NULL AND used_at IS NULL AND expires_at > NOW() RETURNING user_id, redirect_url",
    [state, sessionHash]
  );
  if (!result.rowCount || !result.rows[0]) return { valid: false, error: "OAuth state is invalid, expired, already used, or belongs to another session." };
  return { valid: true, userId: result.rows[0].user_id, redirectUrl: result.rows[0].redirect_url };
}

export async function exchangeAuthorizationCode(code: string): Promise<PayPalTokenResponse> {
  const config = getPayPalConfig();
  const basicAuth = Buffer.from(config.clientId + ":" + config.clientSecret).toString("base64");
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri });
  const response = await fetch(config.restBase + "/v1/oauth2/token", {
    method: "POST", headers: { Authorization: "Basic " + basicAuth, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(), signal: AbortSignal.timeout(15000)
  });
  const data = await response.json() as PayPalTokenResponse;
  if (!response.ok || !data.access_token) throw new Error(data.error_description || data.error || "Failed to exchange authorization code with PayPal.");
  return data;
}

export async function fetchPayPalUserInfo(accessToken: string): Promise<PayPalUserInfo> {
  const config = getPayPalConfig();
  const response = await fetch(config.restBase + "/v1/identity/openidconnect/userinfo?schema=openid", {
    method: "GET", headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error_description || data.error || "Failed to retrieve PayPal user identity."));
  const payerId = String(data.payer_id || data.user_id || "");
  if (!payerId) throw new Error("PayPal did not return a valid account/payer identity.");
  const emails = Array.isArray(data.emails) ? (data.emails as Array<{ value?: string }>)[0]?.value : undefined;
  const email = String(data.email || emails || "").trim() || undefined;
  const name = String(data.name || "").trim() || undefined;
  const verifiedAccount = data.verified_account === true || data.verified_account === "true" || data.verified === true;
  return { payerId, ...(email ? { email } : {}), ...(name ? { name } : {}), verifiedAccount };
}

export async function saveConnectedAccount(
  db: Pool, userId: string,
  info: { payerId: string; email?: string; name?: string; verifiedAccount: boolean; accessToken?: string; refreshToken?: string; expiresIn?: number; scope?: string }
): Promise<void> {
  if (!userId || userId.length > 128) throw new Error("An authenticated user is required to save a PayPal connection.");
  const encryptedAccessToken = info.accessToken ? encryptToken(info.accessToken) : null;
  const encryptedRefreshToken = info.refreshToken ? encryptToken(info.refreshToken) : null;
  const tokenExpiresAt = info.expiresIn ? new Date(Date.now() + info.expiresIn * 1000) : null;
  await db.query(
    `INSERT INTO paypal_connected_accounts (
      user_id, paypal_payer_id, email, name, verified_account, encrypted_access_token,
      encrypted_refresh_token, token_expires_at, scope, status, connected_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'CONNECTED',NOW(),NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      paypal_payer_id=EXCLUDED.paypal_payer_id, email=EXCLUDED.email, name=EXCLUDED.name,
      verified_account=EXCLUDED.verified_account, encrypted_access_token=EXCLUDED.encrypted_access_token,
      encrypted_refresh_token=EXCLUDED.encrypted_refresh_token, token_expires_at=EXCLUDED.token_expires_at,
      scope=EXCLUDED.scope, status='CONNECTED', updated_at=NOW()`,
    [userId, info.payerId, info.email || null, info.name || null, info.verifiedAccount,
      encryptedAccessToken, encryptedRefreshToken, tokenExpiresAt, info.scope || "openid profile email"]
  );
}

export async function getConnectedAccountStatus(db: Pool, userId: string): Promise<{ connected: boolean; account: ConnectedAccountSummary | null }> {
  if (!userId) throw new Error("An authenticated user is required.");
  const result = await db.query<{
    paypal_payer_id: string; email: string | null; name: string | null; verified_account: boolean;
    scope: string | null; connected_at: Date; status: string;
  }>("SELECT paypal_payer_id,email,name,verified_account,scope,connected_at,status FROM paypal_connected_accounts WHERE user_id=$1 AND status='CONNECTED'", [userId]);
  if (!result.rowCount || !result.rows[0]) return { connected: false, account: null };
  const row = result.rows[0];
  return { connected: true, account: {
    payerId: row.paypal_payer_id, email: row.email, name: row.name, verified: row.verified_account,
    scope: row.scope, connectedAt: row.connected_at.toISOString()
  }};
}

export async function disconnectPayPalAccount(db: Pool, userId: string): Promise<boolean> {
  if (!userId) throw new Error("An authenticated user is required.");
  const result = await db.query(
    "UPDATE paypal_connected_accounts SET status='DISCONNECTED',encrypted_access_token=NULL,encrypted_refresh_token=NULL,updated_at=NOW() WHERE user_id=$1 AND status='CONNECTED'",
    [userId]
  );
  return (result.rowCount ?? 0) > 0;
}
