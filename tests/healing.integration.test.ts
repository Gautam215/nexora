import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server.js";
import { Client } from "pg";
import { POST as register } from "../src/app/api/auth/register/route.ts";
import { POST as login } from "../src/app/api/auth/login/route.ts";
import { POST as consumeVerification } from "../src/app/api/auth/verification/consume/route.ts";
import { GET as runCron } from "../src/app/api/cron/[job]/route.ts";
import { closeDatabasePool } from "../src/server/db.ts";
import { closeScheduledPool as closeCronPool } from "../src/server/scheduled.ts";
import { startSmtpCaptureServer, type SmtpCapture } from "./smtp-server.ts";

const connectionString = process.env.NEXORA_TEST_DATABASE_URL;
const migratorConnectionString = process.env.NEXORA_TEST_MIGRATOR_DATABASE_URL;
const origin = "http://localhost:3000";
const runtimeEnvironment = process.env as unknown as Record<string, string | undefined>;
if (connectionString) process.env.DATABASE_URL = connectionString;
runtimeEnvironment.NODE_ENV = "test";
process.env.APP_ORIGIN = origin;
process.env.AUTH_RATE_LIMIT_HMAC_KEY = randomBytes(32).toString("hex");
delete process.env.NEXORA_TRUSTED_CLIENT_IP_HEADER;
process.env.NEXORA_CRON_TOKEN = randomBytes(32).toString("hex");
let smtp: SmtpCapture | undefined;

after(async () => {
  await smtp?.close();
  await closeDatabasePool();
  await closeCronPool();
});

function apiRequest(path: string, method = "GET", body?: unknown, cookie?: string): NextRequest {
  const headers = new Headers();
  if (method !== "GET") headers.set("origin", origin);
  if (body !== undefined) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  return new NextRequest(`${origin}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function cronRequest(job: string, token: string): NextRequest {
  const headers = new Headers();
  headers.set("x-nexora-cron-token", token);
  return new NextRequest(`${origin}/api/cron/${job}`, { method: "GET", headers });
}

function tokenFromMessage(message: string): string {
  const decoded = message.replace(/=\r\n/g, "").replace(/=3D/gi, "=");
  const token = decoded.match(/\/verify-email\?token=([A-Za-z0-9._~-]+)/)?.[1];
  assert.ok(token);
  return token;
}

test(
  "healing job purges expired sessions, replays the same day, and honors the operator kill-switch",
  { skip: !connectionString || !migratorConnectionString },
  async () => {
    smtp = await startSmtpCaptureServer();
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_FROM = "noreply@nexora.example.test";
    process.env.SMTP_PORT = String(smtp.port);
    process.env.SMTP_SECURE = "false";
    process.env.SMTP_REQUIRE_TLS = "false";
    process.env.SMTP_USER = "";
    process.env.SMTP_PASSWORD = "";

    const registered = await register(
      apiRequest("/api/auth/register", "POST", {
        name: "Healing Owner",
        email: "healing-owner@example.test",
        password: "correct horse battery staple",
      }),
    );
    assert.equal(registered.status, 202);
    const verificationToken = tokenFromMessage(smtp?.messages.at(-1) ?? "");
    const verified = await consumeVerification(
      apiRequest("/api/auth/verification/consume", "POST", { token: verificationToken }),
    );
    assert.equal(verified.status, 200);

    // Two logins: one session is expired by hand, one stays live.
    const loginOne = await login(
      apiRequest("/api/auth/login", "POST", {
        email: "healing-owner@example.test",
        password: "correct horse battery staple",
      }),
    );
    assert.equal(loginOne.status, 200);
    const loginTwo = await login(
      apiRequest("/api/auth/login", "POST", {
        email: "healing-owner@example.test",
        password: "correct horse battery staple",
      }),
    );
    assert.equal(loginTwo.status, 200);
    const userId = ((await loginOne.json()) as { data: { user: { id: string } } }).data.user.id;

    const migrator = new Client({ connectionString: migratorConnectionString });
    await migrator.connect();
    try {
      const sessions = await migrator.query<{ id: string }>(
        `SELECT id FROM nexora.user_sessions WHERE user_id = $1 ORDER BY created_at`,
        [userId],
      );
      assert.equal(sessions.rows.length, 2);
      await migrator.query(
        `UPDATE nexora.user_sessions SET created_at = pg_catalog.now() - interval '2 days', expires_at = pg_catalog.now() - interval '1 day' WHERE id = $1`,
        [sessions.rows[0].id],
      );

      const token = process.env.NEXORA_CRON_TOKEN ?? "";
      const first = await runCron(cronRequest("healing", token), {
        params: Promise.resolve({ job: "healing" }),
      });
      assert.equal(first.status, 200);
      const firstBody = (await first.json()) as { data: { replay: boolean; detail: string } };
      assert.equal(firstBody.data.replay, false);
      // The count is global (the job purges every expired session),
      // and test files share one database, so another file's expired
      // session may be purged in the same run. The deterministic
      // assertions are the per-user ones below; the count is only
      // asserted to be at least this test's one session.
      assert.match(firstBody.data.detail, /purged expired sessions: [1-9][0-9]*/);

      const remaining = await migrator.query<{ id: string }>(
        `SELECT id FROM nexora.user_sessions WHERE user_id = $1`,
        [userId],
      );
      assert.equal(remaining.rows.length, 1);
      assert.equal(remaining.rows[0].id, sessions.rows[1].id);

      const runRow = await migrator.query<{ status: string; detail: string }>(
        `SELECT status, detail FROM nexora.scheduled_job_runs WHERE job = 'healing' AND run_date = CURRENT_DATE`,
      );
      assert.equal(runRow.rows[0].status, "ok");
      assert.match(runRow.rows[0].detail, /purged expired sessions: [1-9][0-9]*/);

      // A second call the same day replays instead of purging twice.
      const second = await runCron(cronRequest("healing", token), {
        params: Promise.resolve({ job: "healing" }),
      });
      assert.equal(second.status, 200);
      assert.equal(((await second.json()) as { data: { replay: boolean } }).data.replay, true);

      // Operator kill-switch: clear today's claim, expire another
      // session, and confirm the disabled run touches nothing.
      await migrator.query(
        `DELETE FROM nexora.scheduled_job_runs WHERE job = 'healing' AND run_date = CURRENT_DATE`,
      );
      await migrator.query(
        `UPDATE nexora.user_sessions SET created_at = pg_catalog.now() - interval '2 days', expires_at = pg_catalog.now() - interval '1 day' WHERE id = $1`,
        [sessions.rows[1].id],
      );
      process.env.NEXORA_HEALING_DISABLED = "1";
      const disabled = await runCron(cronRequest("healing", token), {
        params: Promise.resolve({ job: "healing" }),
      });
      assert.equal(disabled.status, 200);
      assert.match(
        ((await disabled.json()) as { data: { detail: string } }).data.detail,
        /disabled by operator/,
      );
      const stillThere = await migrator.query(
        `SELECT id FROM nexora.user_sessions WHERE user_id = $1`,
        [userId],
      );
      assert.equal(stillThere.rows.length, 1);
      delete process.env.NEXORA_HEALING_DISABLED;
    } finally {
      await migrator.end();
    }
  },
);
