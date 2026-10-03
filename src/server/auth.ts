import "server-only";
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import {
  lookupActiveSession,
  withUserContext,
} from "./db.ts";
import { createOpaqueToken, hashOpaqueToken } from "../security/tokens.ts";

const SESSION_LIFETIME_SECONDS = 14 * 24 * 60 * 60;
const SESSION_LIFETIME_MS = SESSION_LIFETIME_SECONDS * 1000;
const DEVELOPMENT_COOKIE_NAME = "nexora_session";
const PRODUCTION_COOKIE_NAME = "__Host-nexora_session";

export interface AuthPrincipal {
  userId: string;
  sessionId: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  display_name: string;
  email_verified_at: Date;
  created_at: Date;
}

export interface NewSession {
  token: string;
  expiresAt: Date;
}

export function sessionCookieName(): string {
  return process.env.NODE_ENV === "production"
    ? PRODUCTION_COOKIE_NAME
    : DEVELOPMENT_COOKIE_NAME;
}

export function setSessionCookie(response: NextResponse, session: NewSession): void {
  response.cookies.set(sessionCookieName(), session.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    expires: session.expiresAt,
    maxAge: SESSION_LIFETIME_SECONDS,
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(sessionCookieName(), "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    expires: new Date(0),
    maxAge: 0,
  });
}

export async function createSession(userId: string): Promise<NewSession> {
  const token = createOpaqueToken();
  const tokenHash = hashOpaqueToken(token);
  if (!tokenHash) throw new Error("Unable to create session token");

  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
  await withUserContext(userId, async (transaction) => {
    await transaction.query(
      `INSERT INTO nexora.user_sessions (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [sessionId, userId, tokenHash, expiresAt],
    );
  });
  return { token, expiresAt };
}

export async function getAuthPrincipal(request: NextRequest): Promise<AuthPrincipal | null> {
  const token = request.cookies.get(sessionCookieName())?.value;
  const tokenHash = hashOpaqueToken(token);
  if (!tokenHash) return null;

  const session = await lookupActiveSession(tokenHash);
  if (!session) return null;
  return { userId: session.user_id, sessionId: session.session_id };
}

export async function getAuthenticatedUser(
  principal: AuthPrincipal,
): Promise<AuthenticatedUser | null> {
  return withUserContext(principal.userId, async (transaction) => {
    await transaction.query(
      `UPDATE nexora.user_sessions
       SET last_seen_at = pg_catalog.clock_timestamp()
       WHERE id = $1
         AND user_id = $2
         AND revoked_at IS NULL
         AND last_seen_at < pg_catalog.clock_timestamp() - interval '5 minutes'`,
      [principal.sessionId, principal.userId],
    );
    const result = await transaction.query<AuthenticatedUser>(
      `SELECT id, email, display_name, email_verified_at, created_at
       FROM nexora.users
       WHERE id = $1 AND status = 'active'
       LIMIT 1`,
      [principal.userId],
    );
    return result.rows[0] ?? null;
  });
}

export async function revokeSession(principal: AuthPrincipal): Promise<void> {
  await withUserContext(principal.userId, async (transaction) => {
    await transaction.query(
      `UPDATE nexora.user_sessions
       SET revoked_at = pg_catalog.clock_timestamp()
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [principal.sessionId, principal.userId],
    );
  });
}
