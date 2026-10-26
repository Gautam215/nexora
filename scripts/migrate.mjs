import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { isMigrationName, migrationChecksum } from "./migration-utils.mjs";

const migrationDirectory = fileURLToPath(new URL("../db/migrations/", import.meta.url));
const advisoryLockId = 1_947_203_611;

async function runMigrations() {
  const connectionString = process.env.MIGRATOR_DATABASE_URL;
  if (!connectionString) throw new Error("MIGRATOR_DATABASE_URL is required");

  // The migrator holds a session-level advisory lock across many
  // transactions, one per migration. That lock is unsupported in
  // PgBouncer transaction pooling, so a pooled Neon endpoint
  // (host containing "-pooler.") would silently lose the lock and let
  // two migrators run at once. Fail fast and name the direct endpoint
  // instead of risking that silent race. The app pool, which only uses
  // transaction-local state, may still use the pooled endpoint.
  try {
    const url = new URL(connectionString);
    if (url.hostname.includes("-pooler.")) {
      throw new Error(
        "MIGRATOR_DATABASE_URL must use the direct Neon endpoint, not the pooled (-pooler) endpoint: the migrator's session-level advisory lock is unsupported in transaction pooling.",
      );
    }
    if (url.hostname.endsWith(".neon.tech") && !url.searchParams.has("sslmode")) {
      throw new Error(
        "MIGRATOR_DATABASE_URL for Neon must include sslmode=require.",
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith("MIGRATOR_DATABASE_URL must") ||
        error.message.startsWith("MIGRATOR_DATABASE_URL for Neon"))
    ) {
      throw error;
    }
    // An unparseable URL is pg's problem to report, not ours to mask.
  }

  const migrationEntries = await readdir(migrationDirectory, { withFileTypes: true });
  const sqlNames = migrationEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();

  if (sqlNames.some((name) => !isMigrationName(name))) {
    throw new Error("A migration filename must use NNNN_lowercase_name.sql format");
  }

  const client = new Client({
    connectionString,
    application_name: "nexora-migrator",
    connectionTimeoutMillis: 5_000,
    query_timeout: 30_000,
  });
  let lockHeld = false;

  try {
    await client.connect();
    await client.query("SELECT pg_catalog.pg_advisory_lock($1)", [advisoryLockId]);
    lockHeld = true;
    await client.query("CREATE SCHEMA IF NOT EXISTS nexora");
    await client.query(`
      CREATE TABLE IF NOT EXISTS nexora.schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT pg_catalog.now()
      )
    `);

    const appliedResult = await client.query("SELECT name, checksum FROM nexora.schema_migrations");
    const applied = new Map(appliedResult.rows.map((row) => [row.name, row.checksum]));
    const available = new Set(sqlNames);

    for (const name of applied.keys()) {
      if (!available.has(name)) {
        throw new Error(`Applied migration ${name} is missing from the source tree`);
      }
    }

    for (const name of sqlNames) {
      const source = await readFile(new URL(`../db/migrations/${name}`, import.meta.url), "utf8");
      const checksum = migrationChecksum(source);
      const recordedChecksum = applied.get(name);

      if (recordedChecksum) {
        if (recordedChecksum !== checksum) {
          throw new Error(`Applied migration ${name} changed; add a new migration instead`);
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(source);
        await client.query(
          "INSERT INTO nexora.schema_migrations (name, checksum) VALUES ($1, $2)",
          [name, checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
      console.log(`Applied ${name}`);
    }

    // Previously, runtime grants were a separate manual step
    // (psql -f db/runtime-grants.sql), and skipping it broke every
    // runtime query with "permission denied for schema nexora" even
    // though all migrations had succeeded. Apply the grants here, as
    // the migration owner, so a single `npm run db:migrate` leaves
    // the database usable. The grants file is idempotent (REVOKE
    // then GRANT), so re-running the migrator is safe.
    const grantsSource = await readFile(
      new URL("../db/runtime-grants.sql", import.meta.url),
      "utf8",
    );
    await client.query(grantsSource);
    console.log("Applied db/runtime-grants.sql");
  } finally {
    if (lockHeld) {
      await client.query("SELECT pg_catalog.pg_advisory_unlock($1)", [advisoryLockId]).catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  }
}

runMigrations().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown migration error";
  console.error(`Nexora migration failed: ${message}`);
  process.exitCode = 1;
});
