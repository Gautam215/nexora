import "server-only";
import { Pool, type PoolClient } from "pg";
import {
  canAccessOrganization,
  type OrganizationRole,
} from "../security/organization-access.ts";

export type DatabaseTransaction = Pick<PoolClient, "query">;

export class OrganizationAccessDenied extends Error {
  readonly code = "ORGANIZATION_ACCESS_DENIED";

  constructor() {
    super("Organization access denied");
    this.name = "OrganizationAccessDenied";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const globalForDatabase = globalThis as typeof globalThis & {
  nexoraPool?: Pool;
};

function getPool(): Pool {
  if (globalForDatabase.nexoraPool) return globalForDatabase.nexoraPool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Database is not configured");

  const pool = new Pool({
    connectionString,
    application_name: "nexora-web",
    max: 12,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
    query_timeout: 12_000,
  });
  globalForDatabase.nexoraPool = pool;
  return pool;
}

export async function closeDatabasePool(): Promise<void> {
  const pool = globalForDatabase.nexoraPool;
  if (!pool) return;
  delete globalForDatabase.nexoraPool;
  await pool.end();
}

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  let transactionStarted = false;
  let releaseError: Error | undefined;

  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const result = await work(client);
    await client.query("COMMIT");
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        releaseError = rollbackError instanceof Error ? rollbackError : new Error("Rollback failed");
      }
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

function validateContextIds(userId: string, organizationId?: string): void {
  if (!UUID_PATTERN.test(userId)) throw new OrganizationAccessDenied();
  if (organizationId !== undefined && !UUID_PATTERN.test(organizationId)) {
    throw new OrganizationAccessDenied();
  }
}

export function withUserContext<T>(
  userId: string,
  work: (transaction: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  validateContextIds(userId);
  return inTransaction(async (client) => {
    await client.query(
      "SELECT pg_catalog.set_config('nexora.user_id', $1, true), pg_catalog.set_config('nexora.organization_id', '', true)",
      [userId],
    );
    return work(client);
  });
}

export function withOrganizationContext<T>(
  userId: string,
  organizationId: string,
  work: (transaction: DatabaseTransaction) => Promise<T>,
  minimumRole: OrganizationRole = "guest",
): Promise<T> {
  validateContextIds(userId, organizationId);

  return inTransaction(async (client) => {
    await client.query(
      "SELECT pg_catalog.set_config('nexora.user_id', $1, true), pg_catalog.set_config('nexora.organization_id', '', true)",
      [userId],
    );

    const membershipResult = await client.query<{
      user_id: string;
      organization_id: string;
      role: string;
      status: string;
    }>(
      `SELECT user_id, organization_id, role, status
       FROM nexora.organization_memberships
       WHERE user_id = $1 AND organization_id = $2
       LIMIT 1`,
      [userId, organizationId],
    );
    const membership = membershipResult.rows[0];
    const membershipForAuthorization = membership
      ? {
          userId: membership.user_id,
          organizationId: membership.organization_id,
          role: membership.role,
          status: membership.status,
        }
      : null;

    if (
      !canAccessOrganization(
        membershipForAuthorization,
        userId,
        organizationId,
        minimumRole,
      )
    ) {
      throw new OrganizationAccessDenied();
    }

    await client.query(
      "SELECT pg_catalog.set_config('nexora.organization_id', $1, true)",
      [organizationId],
    );
    return work(client);
  });
}

export interface LoginAccount {
  user_id: string;
  email: string;
  display_name: string;
  password_hash: string;
  status: string;
  email_verified_at: Date | null;
}

export interface ActiveSessionRecord {
  session_id: string;
  user_id: string;
  expires_at: Date;
}

export async function lookupLoginAccount(email: string): Promise<LoginAccount | null> {
  const result = await getPool().query<LoginAccount>(
    "SELECT user_id, email, display_name, password_hash, status, email_verified_at FROM nexora.lookup_user_for_login($1)",
    [email],
  );
  return result.rows[0] ?? null;
}

export async function lookupActiveSession(
  tokenHash: string,
): Promise<ActiveSessionRecord | null> {
  const result = await getPool().query<ActiveSessionRecord>(
    "SELECT session_id, user_id, expires_at FROM nexora.lookup_active_session($1)",
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

export async function consumeAuthRateLimit(
  scope: string,
  subjectHash: string,
  maxAttempts: number,
  windowSeconds: number,
): Promise<boolean> {
  const result = await getPool().query<{ allowed: boolean }>(
    "SELECT nexora.consume_auth_rate_limit($1, $2, $3, $4) AS allowed",
    [scope, subjectHash, maxAttempts, windowSeconds],
  );
  return result.rows[0]?.allowed === true;
}

export async function consumeEmailVerification(tokenHash: string): Promise<boolean> {
  const result = await getPool().query<{ verified: boolean }>(
    "SELECT nexora.consume_email_verification($1) AS verified",
    [tokenHash],
  );
  return result.rows[0]?.verified === true;
}

export async function issueEmailVerification(
  email: string,
  tokenId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<boolean> {
  const result = await getPool().query<{ issued: boolean }>(
    "SELECT nexora.issue_email_verification($1, $2, $3, $4) AS issued",
    [email, tokenId, tokenHash, expiresAt],
  );
  return result.rows[0]?.issued === true;
}

export async function issuePasswordReset(
  email: string,
  tokenId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<boolean> {
  const result = await getPool().query<{ issued: boolean }>(
    "SELECT nexora.issue_password_reset($1, $2, $3, $4) AS issued",
    [email, tokenId, tokenHash, expiresAt],
  );
  return result.rows[0]?.issued === true;
}

export async function consumePasswordReset(
  tokenHash: string,
  replacementPasswordHash: string,
): Promise<boolean> {
  const result = await getPool().query<{ changed: boolean }>(
    "SELECT nexora.consume_password_reset($1, $2) AS changed",
    [tokenHash, replacementPasswordHash],
  );
  return result.rows[0]?.changed === true;
}
