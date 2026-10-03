import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Client } from "pg";
import { closeDatabasePool, withUserContext } from "../src/server/db.ts";

const connectionString = process.env.NEXORA_TEST_DATABASE_URL;
if (connectionString) process.env.DATABASE_URL = connectionString;

after(async () => {
  await closeDatabasePool();
});

test(
  "auth database functions issue single-use verification/reset tokens and revoke sessions",
  { skip: !connectionString },
  async () => {
    const userId = randomUUID();
    const email = `${userId}@example.test`;
    const tokenHash = randomBytes(32).toString("hex");
    const tokenId = randomUUID();
    const sessionId = randomUUID();
    const sessionHash = randomBytes(32).toString("hex");
    const resetId = randomUUID();
    const resetHash = randomBytes(32).toString("hex");
    const client = new Client({ connectionString });
    await client.connect();

    try {
      await withUserContext(userId, async (transaction) => {
        await transaction.query(
          "INSERT INTO nexora.users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)",
          [userId, email, "Auth Test", "scrypt$test-hash-value-that-passes-schema-check"],
        );
      });

      await client.query("SELECT pg_catalog.set_config('nexora.user_id', '', false)");
      await assert.rejects(
        client.query("SELECT * FROM nexora.email_verification_tokens"),
        (error: { code?: string }) => error.code === "42501",
      );
      await assert.rejects(
        client.query("SELECT * FROM nexora.auth_rate_limits"),
        (error: { code?: string }) => error.code === "42501",
      );

      const verificationIssued = await client.query<{ issue_email_verification: boolean }>(
        "SELECT nexora.issue_email_verification($1, $2, $3, $4)",
        [email, tokenId, tokenHash, new Date(Date.now() + 60 * 60 * 1000)],
      );
      assert.equal(verificationIssued.rows[0]?.issue_email_verification, true);

      const verified = await client.query<{ consume_email_verification: boolean }>(
        "SELECT nexora.consume_email_verification($1)",
        [tokenHash],
      );
      assert.equal(verified.rows[0]?.consume_email_verification, true);
      const consumedAgain = await client.query<{ consume_email_verification: boolean }>(
        "SELECT nexora.consume_email_verification($1)",
        [tokenHash],
      );
      assert.equal(consumedAgain.rows[0]?.consume_email_verification, false);

      const loginAccount = await client.query<{
        user_id: string;
        email_verified_at: Date | null;
      }>("SELECT user_id, email_verified_at FROM nexora.lookup_user_for_login($1)", [email]);
      assert.equal(loginAccount.rows[0]?.user_id, userId);
      assert.ok(loginAccount.rows[0]?.email_verified_at);

      await withUserContext(userId, async (transaction) => {
        await transaction.query(
          `INSERT INTO nexora.user_sessions (id, user_id, token_hash, expires_at)
           VALUES ($1, $2, $3, pg_catalog.now() + interval '1 day')`,
          [sessionId, userId, sessionHash],
        );
      });
      const activeSession = await client.query<{ session_id: string }>(
        "SELECT session_id FROM nexora.lookup_active_session($1)",
        [sessionHash],
      );
      assert.equal(activeSession.rows[0]?.session_id, sessionId);

      const resetIssued = await client.query<{ issue_password_reset: boolean }>(
        "SELECT nexora.issue_password_reset($1, $2, $3, $4)",
        [email, resetId, resetHash, new Date(Date.now() + 60 * 60 * 1000)],
      );
      assert.equal(resetIssued.rows[0]?.issue_password_reset, true);
      const resetCompleted = await client.query<{ consume_password_reset: boolean }>(
        "SELECT nexora.consume_password_reset($1, $2)",
        [resetHash, "scrypt$replacement-password-hash-for-test-only"],
      );
      assert.equal(resetCompleted.rows[0]?.consume_password_reset, true);

      const revokedSession = await client.query<{ session_id: string }>(
        "SELECT session_id FROM nexora.lookup_active_session($1)",
        [sessionHash],
      );
      assert.equal(revokedSession.rowCount, 0);
      const resetAgain = await client.query<{ consume_password_reset: boolean }>(
        "SELECT nexora.consume_password_reset($1, $2)",
        [resetHash, "scrypt$second-replacement-password-hash-for-test"],
      );
      assert.equal(resetAgain.rows[0]?.consume_password_reset, false);
    } finally {
      await client.end();
    }
  },
);

test(
  "database-backed authentication limits reject attempts beyond the fixed window quota",
  { skip: !connectionString },
  async () => {
    const client = new Client({ connectionString });
    await client.connect();
    const subjectHash = randomBytes(32).toString("hex");

    try {
      const decisions = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const result = await client.query<{ consume_auth_rate_limit: boolean }>(
          "SELECT nexora.consume_auth_rate_limit($1, $2, $3, $4)",
          ["login-email", subjectHash, 2, 900],
        );
        decisions.push(result.rows[0]?.consume_auth_rate_limit);
      }
      assert.deepEqual(decisions, [true, true, false, false]);
    } finally {
      await client.end();
    }
  },
);

test(
  "database rate-limit quota accepts configured ceilings up to 120 and rejects larger values",
  { skip: !connectionString },
  async () => {
    const client = new Client({ connectionString });
    await client.connect();
    const subjectHash = randomBytes(32).toString("hex");

    try {
      const configuredCeiling = await client.query<{ consume_auth_rate_limit: boolean }>(
        "SELECT nexora.consume_auth_rate_limit($1, $2, $3, $4)",
        ["workspace-search", subjectHash, 120, 3600],
      );
      assert.equal(configuredCeiling.rows[0]?.consume_auth_rate_limit, true);
      await assert.rejects(
        client.query(
          "SELECT nexora.consume_auth_rate_limit($1, $2, $3, $4)",
          ["workspace-search", randomBytes(32).toString("hex"), 121, 3600],
        ),
        (error: { code?: string }) => error.code === "22023",
      );
    } finally {
      await client.end();
    }
  },
);

test(
  "denied rate-limit attempts stay denied without overflowing their counter",
  { skip: !connectionString },
  async () => {
    const client = new Client({ connectionString });
    await client.connect();
    const subjectHash = randomBytes(32).toString("hex");

    try {
      const decisions = await client.query<{ allowed: boolean }>(
        `SELECT nexora.consume_auth_rate_limit($1, $2, $3, $4) AS allowed
         FROM pg_catalog.generate_series(1, 1005)`,
        ["login-email", subjectHash, 1, 3600],
      );
      assert.equal(decisions.rowCount, 1005);
      assert.equal(decisions.rows.filter((row) => row.allowed).length, 1);
      assert.ok(decisions.rows.every((row) => typeof row.allowed === "boolean"));
    } finally {
      await client.end();
    }
  },
);
