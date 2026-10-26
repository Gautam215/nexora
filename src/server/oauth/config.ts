import "server-only";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  signingKey: string;
  redirectUri: string;
  authorizeUrl: string;
  tokenUrl: string;
  jwksUrl: string;
}

export const OAUTH_CALLBACK_PATH = "/api/auth/oauth/google/callback";
export const GOOGLE_ISSUER = "https://accounts.google.com";

const DEFAULT_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function isOAuthEnabled(): boolean {
  return process.env.OAUTH_GOOGLE_ENABLED === "true";
}

/**
 * Returns the OAuth configuration, or null when any required credential
 * is missing. Checked at request time so a missing credential fails
 * closed (start 503, callback generic error) instead of redirecting to
 * Google. Endpoint overrides are test-only: they are honored only
 * outside production, so a production deployment always talks to
 * Google's real endpoints.
 */
export function getOAuthConfig(): OAuthConfig | null {
  const clientId = process.env.OAUTH_GOOGLE_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.OAUTH_GOOGLE_CLIENT_SECRET ?? "";
  const signingKey = process.env.OAUTH_FLOW_SIGNING_KEY ?? "";
  if (!clientId || !clientSecret || Buffer.byteLength(signingKey) < 32) return null;

  const origin = getAppOrigin();
  if (!origin || !isOAuthOriginAllowed(origin)) return null;

  const testOverrides = process.env.NODE_ENV !== "production";
  return {
    clientId,
    clientSecret,
    signingKey,
    redirectUri: `${origin}${OAUTH_CALLBACK_PATH}`,
    authorizeUrl: testOverrides
      ? (process.env.OAUTH_GOOGLE_AUTHORIZE_URL ?? DEFAULT_AUTHORIZE_URL)
      : DEFAULT_AUTHORIZE_URL,
    tokenUrl: testOverrides
      ? (process.env.OAUTH_GOOGLE_TOKEN_URL ?? DEFAULT_TOKEN_URL)
      : DEFAULT_TOKEN_URL,
    jwksUrl: testOverrides
      ? (process.env.OAUTH_GOOGLE_JWKS_URL ?? DEFAULT_JWKS_URL)
      : DEFAULT_JWKS_URL,
  };
}

export function getAppOrigin(): string | null {
  const origin = process.env.APP_ORIGIN?.trim().replace(/\/+$/, "") ?? "";
  return origin || null;
}

/**
 * Production requires HTTPS, except loopback origins over HTTP for
 * local development (matching the existing hasSameOrigin loopback
 * exception and Google's own allowance for http://localhost redirect
 * URIs). A remote HTTP origin in production is a misconfiguration and
 * fails closed. Outside production, any parseable origin is allowed.
 */
export function isOAuthOriginAllowed(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (process.env.NODE_ENV !== "production") return true;
  if (parsed.protocol === "https:") return true;
  return parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
}
