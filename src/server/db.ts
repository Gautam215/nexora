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

// Thrown when the organization exists but is not active (soft-deleted or
// otherwise closed). Routes map this to 404 ORGANIZATION_NOT_FOUND: a
// deleted workspace is gone, not merely forbidden. A missing membership
// still throws OrganizationAccessDenied, preserving the existing
// non-member contract.
export class OrganizationNotFound extends Error {
  readonly code = "ORGANIZATION_NOT_FOUND";

  constructor() {
    super("Organization not found");
    this.name = "OrganizationNotFound";
  }
}

export class TransactionCommitOutcomeUnknown extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("The database commit outcome is unknown");
    this.name = "TransactionCommitOutcomeUnknown";
    this.cause = cause;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const globalForDatabase = globalThis as typeof globalThis & {
  nexoraPool?: Pool;
};

function isNeonConnectionString(connectionString: string): boolean {
  try {
    return new URL(connectionString).hostname.endsWith(".neon.tech");
  } catch {
    return false;
  }
}

function requireNeonSsl(connectionString: string): void {
  // Neon rejects plaintext connections at its proxy with a cryptic
  // "connection is insecure" error. Fail fast here, with a message that
  // names the fix, instead of letting that proxy error surface as a
  // generic 500. A Neon URL copied from the Neon console already carries
  // sslmode=require, so this only rejects URLs that had it stripped.
  try {
    const url = new URL(connectionString);
    if (url.hostname.endsWith(".neon.tech") && !url.searchParams.has("sslmode")) {
      throw new Error(
        "DATABASE_URL for Neon must include sslmode=require (for example, ?sslmode=require).",
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("DATABASE_URL for Neon")) {
      throw error;
    }
    // An unparseable URL is pg's problem to report, not ours to mask.
  }
}

function getPool(): Pool {
  if (globalForDatabase.nexoraPool) return globalForDatabase.nexoraPool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Database is not configured");
  requireNeonSsl(connectionString);

  const isNeon = isNeonConnectionString(connectionString);
  const pool = new Pool({
    connectionString,
    application_name: "nexora-web",
    max: 12,
    // Neon computes scale to zero and need a TLS handshake plus a wake-up
    // before the first query can run. The previous 5s limit turned that
    // wake-up into an intermittent first-request failure; 15s is only
    // applied to Neon hosts and leaves local/test timeouts unchanged.
    connectionTimeoutMillis: isNeon ? 15_000 : 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
    query_timeout: 12_000,
  });
  // pg emits "error" for idle clients that die underneath the pool
  // (for example, a suspended Neon compute). Without a listener, that
  // event throws and can take the process down; logging it lets the
  // pool discard the dead client and the next request reconnect.
  pool.on("error", (error) => {
    console.error(JSON.stringify({ event: "database.pool_error", errorName: error.name }));
  });
  globalForDatabase.nexoraPool = pool;
  return pool;
}

export async function checkDatabaseConnection(): Promise<boolean> {
  // Cheap condition first: without a configured URL there is nothing to
  // probe, and getPool() would throw. A failed probe is a boolean, never
  // an error detail, because the health endpoint must not leak it.
  if (!process.env.DATABASE_URL) return false;
  try {
    await getPool().query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

// Pool counters for the operator metrics endpoint. Returns null when no
// pool exists yet (no DATABASE_URL configured). These are counts only,
// never connection strings, credentials, or query text.
export function getDatabasePoolStats(): {
  total: number;
  idle: number;
  waiting: number;
} | null {
  const pool = globalForDatabase.nexoraPool;
  if (!pool) return null;
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
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
    await commitDatabaseTransaction(client);
    transactionStarted = false;
    return result;
  } catch (error) {
    if (error instanceof TransactionCommitOutcomeUnknown) {
      transactionStarted = false;
      releaseError = error;
    } else if (transactionStarted) {
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

export async function commitDatabaseTransaction(transaction: DatabaseTransaction): Promise<void> {
  try {
    await transaction.query("COMMIT");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      /^[0-9A-Z]{5}$/.test(error.code)
    ) {
      throw error;
    }
    throw new TransactionCommitOutcomeUnknown(error);
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

    // Immediate invisibility for soft-deleted organizations: every
    // organization-scoped route runs through this helper, so rejecting
    // non-active organizations here hides a deleted workspace from
    // project lists, search, notifications, activity, members, tasks,
    // and files at once, without a filter at each site. The
    // organization row itself is still readable by its own DELETE
    // route's row query (which reports an already-deleted workspace as
    // not found), and the organization list/detail routes already
    // filter status = 'active'.
    const organizationResult = await client.query<{ status: string }>(
      "SELECT status FROM nexora.organizations WHERE id = $1 LIMIT 1",
      [organizationId],
    );
    const organizationStatus = organizationResult.rows[0]?.status;
    if (organizationStatus !== undefined && organizationStatus !== "active") {
      throw new OrganizationNotFound();
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

export interface OAuthIdentityLookup {
  user_id: string;
  status: string;
  email_verified_at: Date | null;
}

/**
 * Pre-auth OAuth lookup by (provider, subject) through the SECURITY
 * DEFINER function. Returns only user_id, status, and
 * email_verified_at -- never email, display_name, or password_hash.
 */
export async function lookupOAuthIdentity(
  provider: string,
  subject: string,
): Promise<OAuthIdentityLookup | null> {
  const result = await getPool().query<OAuthIdentityLookup>(
    "SELECT user_id, status, email_verified_at FROM nexora.lookup_oauth_identity($1, $2)",
    [provider, subject],
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
