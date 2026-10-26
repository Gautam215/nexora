import "server-only";
import { randomUUID } from "node:crypto";
import {
  lookupLoginAccount,
  lookupOAuthIdentity as lookupOAuthIdentityRow,
  withUserContext,
} from "../db.ts";

export interface OAuthIdentityLookup {
  userId: string;
  status: string;
  emailVerifiedAt: Date | null;
}

/**
 * Pre-auth lookup by (provider, subject) through the SECURITY DEFINER
 * function in db.ts. This is the only way the callback learns a user_id
 * from a subject: RLS cannot serve it because no user context exists
 * yet. Returns only user_id, status, and email_verified_at.
 */
export async function lookupOAuthIdentity(
  provider: string,
  subject: string,
): Promise<OAuthIdentityLookup | null> {
  const row = await lookupOAuthIdentityRow(provider, subject);
  if (!row) return null;
  return { userId: row.user_id, status: row.status, emailVerifiedAt: row.email_verified_at };
}

export interface EmailAccount {
  userId: string;
  email: string;
  status: string;
  emailVerifiedAt: Date | null;
}

/** Email-existence check via the existing login lookup (server-side only). */
export async function lookupAccountByEmail(email: string): Promise<EmailAccount | null> {
  const account = await lookupLoginAccount(email);
  if (!account) return null;
  return {
    userId: account.user_id,
    email: account.email,
    status: account.status,
    emailVerifiedAt: account.email_verified_at,
  };
}

/**
 * Provider display name through the registration name rule (trim,
 * 1-120 characters); falls back to the email local part when the
 * profile name is empty after trimming.
 */
export function resolveOAuthDisplayName(profileName: string | null, email: string): string {
  const trimmed = (profileName ?? "").trim();
  if (trimmed.length >= 1 && trimmed.length <= 120) return trimmed;
  return email.split("@")[0] ?? "user";
}

/** The same gate password login applies: active and email-verified. */
export function passesAccountGate(status: string, emailVerifiedAt: Date | null): boolean {
  return status === "active" && emailVerifiedAt !== null;
}

export async function updateIdentityUsage(
  userId: string,
  providerEmail: string,
): Promise<void> {
  await withUserContext(userId, async (transaction) => {
    await transaction.query(
      `UPDATE nexora.oauth_identities
       SET provider_email = $2, last_used_at = pg_catalog.now()
       WHERE user_id = $1 AND provider = 'google'`,
      [userId, providerEmail],
    );
  });
}

export async function userHasGoogleIdentity(userId: string): Promise<boolean> {
  return withUserContext(userId, async (transaction) => {
    const result = await transaction.query<{ id: string }>(
      `SELECT id FROM nexora.oauth_identities
       WHERE user_id = $1 AND provider = 'google' LIMIT 1`,
      [userId],
    );
    return result.rows.length > 0;
  });
}

export async function linkIdentity(
  userId: string,
  subject: string,
  providerEmail: string,
): Promise<void> {
  await withUserContext(userId, async (transaction) => {
    await transaction.query(
      `INSERT INTO nexora.oauth_identities (id, user_id, provider, provider_subject, provider_email)
       VALUES ($1, $2, 'google', $3, $4)`,
      [randomUUID(), userId, subject, providerEmail],
    );
  });
}

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === constraint
  );
}

/**
 * Creates a user and its Google identity atomically (one transaction,
 * following the registration pattern). The user has no password
 * (password_hash NULL) and email_verified_at set to now, because the
 * provider verified the email. Display name follows the registration
 * name rule (trim, 1-120); callers pass the already-resolved name.
 */
export async function createUserWithIdentity(
  userId: string,
  email: string,
  displayName: string,
  subject: string,
  providerEmail: string,
): Promise<void> {
  await withUserContext(userId, async (transaction) => {
    await transaction.query(
      `INSERT INTO nexora.users (id, email, display_name, password_hash, email_verified_at)
       VALUES ($1, $2, $3, NULL, pg_catalog.now())`,
      [userId, email, displayName],
    );
    await transaction.query(
      `INSERT INTO nexora.oauth_identities (id, user_id, provider, provider_subject, provider_email)
       VALUES ($1, $2, 'google', $3, $4)`,
      [randomUUID(), userId, subject, providerEmail],
    );
  });
}
