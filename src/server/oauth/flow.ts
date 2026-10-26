import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { NextResponse } from "next/server";
import { safeReturnPath } from "../../security/return-path.ts";
import { createOpaqueToken } from "../../security/tokens.ts";

export type OAuthFlowIntent = "signin" | "link";

export interface OAuthFlowPayload {
  v: 1;
  state: string;
  verifier: string;
  nonce: string;
  next: string;
  intent: OAuthFlowIntent;
  linkUserId: string | null;
  createdAt: number;
}

export const FLOW_COOKIE_MAX_AGE_SECONDS = 600;
const FLOW_COOKIE_PATH = "/api/auth/oauth";
const DEVELOPMENT_FLOW_COOKIE = "nexora_oauth_flow";
const PRODUCTION_FLOW_COOKIE = "__Host-nexora_oauth_flow";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function flowCookieName(): string {
  return process.env.NODE_ENV === "production" ? PRODUCTION_FLOW_COOKIE : DEVELOPMENT_FLOW_COOKIE;
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function newFlow(intent: OAuthFlowIntent, next: string, linkUserId: string | null): OAuthFlowPayload {
  return {
    v: 1,
    state: createOpaqueToken(),
    verifier: createOpaqueToken(),
    nonce: createOpaqueToken(),
    next,
    intent,
    linkUserId,
    createdAt: Date.now(),
  };
}

function signPayload(payload: string, signingKey: string): string {
  const signature = createHmac("sha256", signingKey).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function createFlowValue(payload: OAuthFlowPayload, signingKey: string): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return signPayload(encoded, signingKey);
}

export type FlowVerification =
  | { status: "ok"; payload: OAuthFlowPayload }
  | { status: "expired"; payload: OAuthFlowPayload }
  | { status: "invalid" };

function isValidPayload(value: unknown): value is OAuthFlowPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Record<string, unknown>;
  if (payload.v !== 1) return false;
  if (
    typeof payload.state !== "string" ||
    !TOKEN_PATTERN.test(payload.state) ||
    typeof payload.verifier !== "string" ||
    !TOKEN_PATTERN.test(payload.verifier) ||
    typeof payload.nonce !== "string" ||
    !TOKEN_PATTERN.test(payload.nonce)
  ) {
    return false;
  }
  if (typeof payload.next !== "string" || safeReturnPath(payload.next) !== payload.next) return false;
  if (payload.intent !== "signin" && payload.intent !== "link") return false;
  if (payload.intent === "signin" && payload.linkUserId !== null) return false;
  if (
    payload.intent === "link" &&
    (typeof payload.linkUserId !== "string" || !UUID_PATTERN.test(payload.linkUserId))
  ) {
    return false;
  }
  return typeof payload.createdAt === "number" && Number.isFinite(payload.createdAt);
}

/**
 * Verifies a flow cookie value. A bad HMAC, malformed JSON, or missing
 * field is "invalid"; a well-formed but over-10-minute-old flow is
 * "expired" (its payload is still returned, HMAC-valid, so the caller
 * can pick the failure redirect target by intent -- the expired flow
 * itself is never honored). Both are rejected before any exchange.
 */
export function verifyFlowValue(value: string | undefined, signingKey: string): FlowVerification {
  if (!value) return { status: "invalid" };
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return { status: "invalid" };
  const encoded = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = createHmac("sha256", signingKey).update(encoded).digest("base64url");
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length) return { status: "invalid" };
  if (!timingSafeEqual(signatureBuffer, expectedBuffer)) return { status: "invalid" };

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return { status: "invalid" };
  }
  if (!isValidPayload(payload)) return { status: "invalid" };
  if (Date.now() - payload.createdAt > FLOW_COOKIE_MAX_AGE_SECONDS * 1000) {
    return { status: "expired", payload };
  }
  return { status: "ok", payload };
}

export function setFlowCookie(response: NextResponse, value: string): void {
  response.cookies.set(flowCookieName(), value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: FLOW_COOKIE_PATH,
    maxAge: FLOW_COOKIE_MAX_AGE_SECONDS,
  });
}

export function clearFlowCookie(response: NextResponse): void {
  response.cookies.set(flowCookieName(), "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: FLOW_COOKIE_PATH,
    expires: new Date(0),
    maxAge: 0,
  });
}


