import "server-only";
import { createPublicKey, verify } from "node:crypto";
import type { OAuthConfig } from "./config.ts";
import { GOOGLE_ISSUER } from "./config.ts";
import { pkceChallenge, type OAuthFlowPayload } from "./flow.ts";

export interface JwksKey {
  kid: string;
  kty: string;
  n?: string;
  e?: string;
}

export interface JwksDocument {
  keys: JwksKey[];
}

export type FetchJwks = (url: string, forceRefresh?: boolean) => Promise<JwksDocument | null>;

export interface VerifiedIdToken {
  sub: string;
  email: string;
  name: string | null;
}

const JWKS_CACHE_MAX_AGE_MS = 60 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;

let cachedJwks: { document: JwksDocument; fetchedAt: number } | null = null;

async function fetchJwksFromNetwork(url: string): Promise<JwksDocument | null> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/json" } });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    const document = (await response.json()) as JwksDocument;
    if (!document || !Array.isArray(document.keys)) return null;
    return document;
  } catch {
    return null;
  }
}

/**
 * Module-level JWKS fetcher with a 1-hour cache. A fetch failure
 * returns null (fail closed); callers refetch exactly once on an
 * unknown kid by passing forceRefresh.
 */
export async function cachedFetchJwks(url: string, forceRefresh = false): Promise<JwksDocument | null> {
  if (!forceRefresh && cachedJwks && Date.now() - cachedJwks.fetchedAt < JWKS_CACHE_MAX_AGE_MS) {
    return cachedJwks.document;
  }
  const document = await fetchJwksFromNetwork(url);
  if (document) cachedJwks = { document, fetchedAt: Date.now() };
  return document;
}

export function buildAuthorizeUrl(config: OAuthConfig, flow: OAuthFlowPayload): string {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("code_challenge", pkceChallenge(flow.verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", flow.state);
  url.searchParams.set("nonce", flow.nonce);
  return url.toString();
}

/**
 * Exchanges an authorization code server-side. Only the id_token is
 * returned; Google's access_token is discarded immediately and never
 * stored, logged, or sent to the browser. Offline access is never
 * requested, so no refresh_token is issued.
 */
export async function exchangeCode(
  config: OAuthConfig,
  code: string,
  verifier: string,
): Promise<{ idToken: string } | null> {
  let response: Response;
  try {
    response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: config.redirectUri,
      }),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    const body = (await response.json()) as { id_token?: unknown };
    if (typeof body.id_token !== "string" || !body.id_token) return null;
    return { idToken: body.id_token };
  } catch {
    return null;
  }
}

function decodeBase64UrlJson(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function verifyRs256Signature(signingInput: string, signature: Buffer, key: JwksKey): boolean {
  if (key.kty !== "RSA" || typeof key.n !== "string" || typeof key.e !== "string") return false;
  try {
    const publicKey = createPublicKey({ key: { kty: "RSA", n: key.n, e: key.e }, format: "jwk" });
    return verify("sha256", Buffer.from(signingInput), publicKey, signature);
  } catch {
    return false;
  }
}

export interface VerifyIdTokenOptions {
  clientId: string;
  jwksUrl: string;
  expectedNonce: string;
  fetchJwks: FetchJwks;
  nowSeconds?: number;
}

/**
 * Strict id_token verification (ARCHITECTURE.md 7.1). Any failure
 * returns null: RS256 allowlist only with a present kid, JWKS
 * signature with exactly one refetch on an unknown kid, exact iss,
 * string aud equal to the client ID, exp in the future (60s skew),
 * iat not more than 60s in the future, exact nonce match,
 * email_verified exactly true, non-empty sub (<=256 chars) and
 * non-empty email. A JWKS fetch failure fails closed.
 */
export async function verifyIdToken(
  idToken: string,
  options: VerifyIdTokenOptions,
): Promise<VerifiedIdToken | null> {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  const header = decodeBase64UrlJson(encodedHeader);
  const payload = decodeBase64UrlJson(encodedPayload);
  if (!header || !payload) return null;
  if (header.alg !== "RS256") return null;
  if (typeof header.kid !== "string" || !header.kid) return null;

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  let signature: Buffer;
  try {
    signature = Buffer.from(encodedSignature, "base64url");
  } catch {
    return null;
  }
  if (!signature.length) return null;

  const findKey = (document: JwksDocument | null, kid: string): JwksKey | undefined =>
    document?.keys.find((key) => key.kid === kid);

  // The JWKS URL comes from configuration; the fetcher is injectable
  // so unit tests can stub it without network access.
  let document = await options.fetchJwks(options.jwksUrl);
  let key = findKey(document, header.kid);
  if (!key) {
    // Unknown kid: refetch exactly once, then fail closed.
    document = await options.fetchJwks(options.jwksUrl, true);
    key = findKey(document, header.kid);
    if (!key) return null;
  }
  if (!verifyRs256Signature(signingInput, signature, key)) return null;

  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (payload.iss !== GOOGLE_ISSUER) return null;
  if (typeof payload.aud !== "string" || payload.aud !== options.clientId) return null;
  if (typeof payload.exp !== "number" || payload.exp <= nowSeconds - CLOCK_SKEW_SECONDS) return null;
  if (typeof payload.iat === "number" && payload.iat > nowSeconds + CLOCK_SKEW_SECONDS) return null;
  if (payload.nonce !== options.expectedNonce) return null;
  if (payload.email_verified !== true) return null;
  if (typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 256) return null;
  if (typeof payload.email !== "string" || !payload.email) return null;
  const name = typeof payload.name === "string" ? payload.name : null;
  return { sub: payload.sub, email: payload.email, name };
}
