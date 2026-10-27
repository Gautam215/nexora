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

export interface ListedSession {
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

// Session listing returns metadata only: never a token, a token hash,
// or any other secret. Expired and revoked sessions are excluded; a
// session that is no longer active is not "active" and must not be
// listed as if the user could revoke it again.
export async function listActiveSessions(userId: string): Promise<ListedSession[]> {
  return withUserContext(userId, async (transaction) => {
    const result = await transaction.query<ListedSession>(
      `SELECT id, created_at AS "createdAt", last_seen_at AS "lastSeenAt",
              expires_at AS "expiresAt"
       FROM nexora.user_sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > pg_catalog.now()
       ORDER BY last_seen_at DESC`,
      [userId],
    );
    return result.rows;
  });
}

// Session rotation on privilege change (approved default, 2026-10-26).
// There is deliberately no periodic rotation: a session token alone
// never grants a role, and every request re-checks membership through
// RLS/tenant context, so a role downgrade takes effect immediately
// even without revocation. Revocation is defense-in-depth, and it is
// the enforcement mechanism for disabling a member: a disabled member
// must not keep a usable session.
// - Organization membership: revoke when the new status is not
//   active, or when the new role ranks below the previous role
//   (owner > admin > member > guest). A re-enable alone does not
//   revoke: sessions were already revoked at disable time.
// - Project membership: revoke only when the new status is not
//   active. A project role-only change does not revoke, because
//   project authorization is re-checked on every request and the
//   session itself carries no project role; revoking every session
//   for a project role change would punish multi-tab users for no
//   additional access-control gain.
// - Password change keeps the current, provably-trusted session and
//   revokes all others (see changePasswordAndRevokeOthers);
//   unauthenticated password reset revokes all sessions.
export function organizationRoleRank(role: string): number {
  if (role === "owner") return 3;
  if (role === "admin") return 2;
  if (role === "member") return 1;
  return 0;
}

export function shouldRevokeSessionsOnOrganizationChange(
  previous: { role: string; status: string },
  next: { role: string; status: string },
): boolean {
  if (next.status !== "active") return true;
  return organizationRoleRank(next.role) < organizationRoleRank(previous.role);
}

export function shouldRevokeSessionsOnProjectChange(next: { status: string }): boolean {
  return next.status !== "active";
}

// Revoke one session owned by this user. Returns false when the session
// does not exist, is already revoked or expired, or belongs to another
// user — those three cases are deliberately indistinguishable, so that
// a session ID cannot be probed for ownership.
export async function revokeSessionById(userId: string, sessionId: string): Promise<boolean> {
  return withUserContext(userId, async (transaction) => {
    const result = await transaction.query(
      `UPDATE nexora.user_sessions
       SET revoked_at = pg_catalog.clock_timestamp()
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
         AND expires_at > pg_catalog.now()`,
      [sessionId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  });
}

// Revoke every session except the caller's current one. Returns how
// many were revoked, so the caller can see the effect.
export async function revokeOtherSessions(userId: string, currentSessionId: string): Promise<number> {
  return withUserContext(userId, async (transaction) => {
    const result = await transaction.query(
      `UPDATE nexora.user_sessions
       SET revoked_at = pg_catalog.clock_timestamp()
       WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
      [userId, currentSessionId],
    );
    return result.rowCount ?? 0;
  });
}

// Change a password and revoke all other sessions in a single
// transaction, so that a password change can never leave a stale
// session active because the second update failed. The current session
// is kept: the caller just proved possession of both the current
// password and this session, so this session is the trusted one, and
// every other session — which may be stolen, stale, or forgotten — is
// revoked. This matches the password-reset policy (which revokes all
// sessions) except for the one session that is provably in the hands
// of the user making the change; a reset, being unauthenticated, has
// no such trusted session to keep. Returns the number of other
// sessions revoked, or null when the account could not be updated
// (for example, it was disabled concurrently).
export async function changePasswordAndRevokeOthers(
  userId: string,
  currentSessionId: string,
  newPasswordHash: string,
): Promise<number | null> {
  return withUserContext(userId, async (transaction) => {
    const updated = await transaction.query(
      `UPDATE nexora.users
       SET password_hash = $2
       WHERE id = $1 AND status = 'active'`,
      [userId, newPasswordHash],
    );
    if ((updated.rowCount ?? 0) !== 1) return null;
    const revoked = await transaction.query(
      `UPDATE nexora.user_sessions
       SET revoked_at = pg_catalog.clock_timestamp()
       WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
      [userId, currentSessionId],
    );
    return revoked.rowCount ?? 0;
  });
}
