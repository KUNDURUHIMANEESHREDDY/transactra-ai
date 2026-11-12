import { randomBytes } from "node:crypto";
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
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string | undefined;
  scope?: string | undefined;
  id_token?: string | undefined;
  error?: string | undefined;
  error_description?: string | undefined;
};

export type PayPalUserInfo = {
  payerId: string;
  email?: string | undefined;
  name?: string | undefined;
  verifiedAccount: boolean;
};

export type ConnectedAccountSummary = {
  payerId: string;
  email: string | null;
  name: string | null;
  verified: boolean;
  connectedAt: string;
  scope: string | null;
};

export function getPayPalConfig(requestHost?: string): PayPalConfig {
  const clientId = process.env.PAYPAL_CLIENT_ID || "";
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET || "";
  const isLive = process.env.PAYPAL_ENV === "live";
  const authBase = isLive ? "https://www.paypal.com" : "https://www.sandbox.paypal.com";
  const restBase = isLive ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

  const host = requestHost || process.env.HOST || "127.0.0.1";
  const port = process.env.PORT || "8787";
  const defaultBase = host.includes(":") ? `http://${host}` : `http://${host}:${port}`;
  const apiBase = (process.env.API_BASE_URL || defaultBase).replace(/\/$/, "");
  const redirectUri = process.env.PAYPAL_REDIRECT_URI || `${apiBase}/api/auth/paypal/callback`;
  const frontend = new URL(process.env.FRONTEND_URL || "http://localhost:5173");
  const localFrontend = frontend.hostname === "localhost" || frontend.hostname === "127.0.0.1";
  if (frontend.protocol !== "https:" && !(localFrontend && frontend.protocol === "http:")) {
    throw new Error("FRONTEND_URL must use HTTPS (HTTP is allowed only for localhost development).");
  }
  const frontendUrl = frontend.origin;

  return {
    clientId,
    clientSecret,
    env: isLive ? "live" : "sandbox",
    authBase,
    restBase,
    redirectUri,
    frontendUrl,
  };
}

export async function ensurePayPalConnectionSchema(db: Pool): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS paypal_oauth_states (
      state TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      redirect_url TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS paypal_oauth_states_expiry_idx
      ON paypal_oauth_states(expires_at) WHERE used_at IS NULL;
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
    CREATE INDEX IF NOT EXISTS paypal_connected_accounts_payer_idx
      ON paypal_connected_accounts(paypal_payer_id);
  `);
  await db.query("ALTER TABLE paypal_oauth_states ALTER COLUMN user_id DROP DEFAULT");
  await db.query("ALTER TABLE paypal_connected_accounts ALTER COLUMN user_id DROP DEFAULT");
}

/**
 * Creates a cryptographically random OAuth state token, stores the Telegram identity,
 * and builds the official PayPal authorization URL.
 */
export async function createOAuthState(
  db: Pool,
  userId: string,
  requestHost?: string
): Promise<{ state: string; authorizeUrl: string }> {
  if (!/^\d{1,20}$/.test(userId)) {
    throw new Error("A valid Telegram user ID is required to connect PayPal.");
  }
  const config = getPayPalConfig(requestHost);
  if (!config.clientId || !config.clientSecret) {
    throw new Error("PayPal credentials are not configured on the server.");
  }

  // 32-byte cryptographically secure random state
  const state = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes expiry

  await db.query(
    "INSERT INTO paypal_oauth_states (state, user_id, expires_at) VALUES ($1, $2, $3)",
    [state, userId, expiresAt]
  );

  // Request OpenID Connect scopes: openid profile email
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    scope: "openid profile email",
    redirect_uri: config.redirectUri,
    state,
    prompt: "login",
  });

  const authorizeUrl = `${config.authBase}/signin/authorize?${params.toString()}`;

  return { state, authorizeUrl };
}

/**
 * Validates and atomically consumes the OAuth state to prevent CSRF and replay attacks.
 */
export async function validateAndConsumeState(
  db: Pool,
  state: string
): Promise<{ valid: boolean; userId?: string | undefined; error?: string | undefined }> {
  if (!state || typeof state !== "string" || state.length < 32) {
    return { valid: false, error: "Invalid or missing OAuth state parameter." };
  }

  // Atomic update: only succeeds if state exists, is unused, and not expired
  const result = await db.query<{ user_id: string }>(
    "UPDATE paypal_oauth_states SET used_at = NOW() WHERE state = $1 AND used_at IS NULL AND expires_at > NOW() RETURNING user_id",
    [state]
  );

  if (!result.rowCount || !result.rows[0]) {
    return { valid: false, error: "OAuth state is invalid, expired, or already used." };
  }

  return {
    valid: true,
    userId: result.rows[0].user_id,
  };
}

/**
 * Exchanges the temporary authorization code for OAuth access and refresh tokens.
 */
export async function exchangeAuthorizationCode(
  code: string,
  requestHost?: string
): Promise<PayPalTokenResponse> {
  const config = getPayPalConfig(requestHost);
  const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
  });

  const response = await fetch(`${config.restBase}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const data = (await response.json()) as PayPalTokenResponse;
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "Failed to exchange authorization code with PayPal.");
  }

  return data;
}

/**
 * Retrieves the user's permitted PayPal profile and identity using OpenID Connect.
 */
export async function fetchPayPalUserInfo(
  accessToken: string,
  requestHost?: string
): Promise<PayPalUserInfo> {
  const config = getPayPalConfig(requestHost);

  const response = await fetch(`${config.restBase}/v1/identity/openidconnect/userinfo?schema=openid`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(String(data["error_description"] || data["error"] || "Failed to retrieve PayPal user identity."));
  }

  const payerId = String(data["payer_id"] || data["user_id"] || "");
  if (!payerId) {
    throw new Error("PayPal did not return a valid account/payer identity.");
  }

  const emails = Array.isArray(data["emails"])
    ? (data["emails"] as Array<{ value?: string }>)[0]?.value
    : undefined;
  const email = String(data["email"] || emails || "").trim() || undefined;
  const name = String(data["name"] || "").trim() || undefined;
  const verifiedAccount = Boolean(
    data["verified_account"] === true ||
    data["verified_account"] === "true" ||
    data["verified"] === true
  );

  return { payerId, email, name, verifiedAccount };
}

/**
 * Encrypts sensitive tokens with AES-256-GCM and persists the connected account in PostgreSQL.
 */
export async function saveConnectedAccount(
  db: Pool,
  userId: string,
  info: {
    payerId: string;
    email?: string | undefined;
    name?: string | undefined;
    verifiedAccount: boolean;
    accessToken?: string | undefined;
    refreshToken?: string | undefined;
    expiresIn?: number | undefined;
    scope?: string | undefined;
  }
): Promise<void> {
  const encryptedAccessToken = info.accessToken ? encryptToken(info.accessToken) : null;
  const encryptedRefreshToken = info.refreshToken ? encryptToken(info.refreshToken) : null;
  const tokenExpiresAt = info.expiresIn
    ? new Date(Date.now() + info.expiresIn * 1000)
    : null;

  await db.query(
    `INSERT INTO paypal_connected_accounts (
      user_id,
      paypal_payer_id,
      email,
      name,
      verified_account,
      encrypted_access_token,
      encrypted_refresh_token,
      token_expires_at,
      scope,
      status,
      connected_at,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'CONNECTED', NOW(), NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      paypal_payer_id = EXCLUDED.paypal_payer_id,
      email = EXCLUDED.email,
      name = EXCLUDED.name,
      verified_account = EXCLUDED.verified_account,
      encrypted_access_token = EXCLUDED.encrypted_access_token,
      encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
      token_expires_at = EXCLUDED.token_expires_at,
      scope = EXCLUDED.scope,
      status = 'CONNECTED',
      updated_at = NOW()`,
    [
      userId,
      info.payerId,
      info.email || null,
      info.name || null,
      info.verifiedAccount,
      encryptedAccessToken,
      encryptedRefreshToken,
      tokenExpiresAt,
      info.scope || "openid profile email",
    ]
  );
}

/**
 * Retrieves the connection status and sanitized public account info.
 * Never leaks access/refresh tokens, encryption details, or passwords.
 */
export async function getConnectedAccountStatus(
  db: Pool,
  userId: string
): Promise<{ connected: boolean; account: ConnectedAccountSummary | null }> {
  const result = await db.query<{
    paypal_payer_id: string;
    email: string | null;
    name: string | null;
    verified_account: boolean;
    scope: string | null;
    connected_at: Date;
    status: string;
  }>(
    "SELECT paypal_payer_id, email, name, verified_account, scope, connected_at, status FROM paypal_connected_accounts WHERE user_id = $1 AND status = 'CONNECTED'",
    [userId]
  );

  if (!result.rowCount || !result.rows[0]) {
    return { connected: false, account: null };
  }

  const row = result.rows[0];
  return {
    connected: true,
    account: {
      payerId: row.paypal_payer_id,
      email: row.email,
      name: row.name,
      verified: row.verified_account,
      scope: row.scope,
      connectedAt: row.connected_at.toISOString(),
    },
  };
}

/**
 * Disconnects the user's PayPal account association, wiping stored encrypted tokens.
 */
export async function disconnectPayPalAccount(
  db: Pool,
  userId: string
): Promise<boolean> {
  const result = await db.query(
    "UPDATE paypal_connected_accounts SET status = 'DISCONNECTED', encrypted_access_token = NULL, encrypted_refresh_token = NULL, updated_at = NOW() WHERE user_id = $1 AND status = 'CONNECTED'",
    [userId]
  );

  return (result.rowCount ?? 0) > 0;
}
