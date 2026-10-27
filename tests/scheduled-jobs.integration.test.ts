import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server.js";
import { Client } from "pg";
import { POST as register } from "../src/app/api/auth/register/route.ts";
import { POST as login } from "../src/app/api/auth/login/route.ts";
import { POST as consumeVerification } from "../src/app/api/auth/verification/consume/route.ts";
import { GET as runCron } from "../src/app/api/cron/[job]/route.ts";
import { POST as createOrganization } from "../src/app/api/organizations/route.ts";
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

function apiRequest(
  path: string,
  method = "GET",
  body?: unknown,
  cookie?: string,
  extraHeaders?: Record<string, string>,
): NextRequest {
  const headers = new Headers(extraHeaders);
  if (method !== "GET") headers.set("origin", origin);
  if (body !== undefined) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  return new NextRequest(`${origin}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function cronRequest(job: string, token?: string, authorization?: string): NextRequest {
  const headers = new Headers();
  if (token !== undefined) headers.set("x-nexora-cron-token", token);
  if (authorization !== undefined) headers.set("authorization", authorization);
  return new NextRequest(`${origin}/api/cron/${job}`, { method: "GET", headers });
}

function tokenFromMessage(message: string, pathname: string): string {
  const decoded = message.replace(/=\r\n/g, "").replace(/=3D/gi, "=");
  const token = decoded.match(new RegExp(`${pathname}\\?token=([A-Za-z0-9_-]{43})`))?.[1];
  assert.ok(token, `expected ${pathname} token in captured email`);
  return token;
}

test(
  "cron route fails closed without a token and rejects a wrong token",
  { skip: !connectionString },
  async () => {
    const savedToken = process.env.NEXORA_CRON_TOKEN;
    delete process.env.NEXORA_CRON_TOKEN;
    const unset = await runCron(cronRequest("due-date"), {
      params: Promise.resolve({ job: "due-date" }),
    });
    process.env.NEXORA_CRON_TOKEN = savedToken;
    assert.equal(unset.status, 503);
    const wrong = await runCron(cronRequest("due-date", "wrong-token"), {
      params: Promise.resolve({ job: "due-date" }),
    });
    assert.equal(wrong.status, 401);
    const wrongBearer = await runCron(
      cronRequest("due-date", undefined, "Bearer wrong-token"),
      { params: Promise.resolve({ job: "due-date" }) },
    );
    assert.equal(wrongBearer.status, 401);
    const unknown = await runCron(cronRequest("nope", process.env.NEXORA_CRON_TOKEN), {
      params: Promise.resolve({ job: "nope" }),
    });
    assert.equal(unknown.status, 404);
  },
);

test(
  "cron route accepts the Vercel Bearer form of the same token",
  { skip: !connectionString },
  async () => {
    const bearer = await runCron(
      cronRequest("alerts", undefined, `Bearer ${process.env.NEXORA_CRON_TOKEN}`),
      { params: Promise.resolve({ job: "alerts" }) },
    );
    assert.equal(bearer.status, 200);
  },
);

test(
  "due-date cron creates one reminder per due task and replays the same day",
  { skip: !connectionString || !migratorConnectionString },
  async () => {
    const migrator = new Client({ connectionString: migratorConnectionString });
    await migrator.connect();
    try {
      const userId = randomUUID();
      const organizationId = randomUUID();
      const projectId = randomUUID();
      const taskId = randomUUID();
      const hash = randomBytes(32).toString("hex");
      // Task writes fire a graph-lock trigger that requires tenant
      // context; set it on this fixture connection like
      // withOrganizationContext does for app requests.
      await migrator.query("SELECT pg_catalog.set_config('nexora.user_id', $1, false)", [userId]);
      await migrator.query("SELECT pg_catalog.set_config('nexora.organization_id', $1, false)", [organizationId]);
      await migrator.query(
        `INSERT INTO nexora.users (id, email, display_name, password_hash, email_verified_at)
         VALUES ($1, $2, $3, $4, pg_catalog.now())`,
        [userId, `${userId}@example.test`, "Due User", hash],
      );
      await migrator.query(
        `INSERT INTO nexora.organizations (id, name, slug, created_by) VALUES ($1, 'Due Org', $2, $3)`,
        [organizationId, `due-${userId.slice(0, 8)}`, userId],
      );
      await migrator.query(
        `INSERT INTO nexora.organization_memberships (organization_id, user_id, role, status, joined_at)
         VALUES ($1, $2, 'owner', 'active', pg_catalog.now())`,
        [organizationId, userId],
      );
      await migrator.query(
        `INSERT INTO nexora.projects (id, organization_id, name, owner_user_id) VALUES ($1, $2, 'Due Project', $3)`,
        [projectId, organizationId, userId],
      );
      await migrator.query(
        `INSERT INTO nexora.project_memberships (organization_id, project_id, user_id, role, status, added_by_user_id)
         VALUES ($1, $2, $3, 'manager', 'active', $3)`,
        [organizationId, projectId, userId],
      );
      // Project insert seeds a default workflow via trigger; reuse its
      // first open column instead of inserting a colliding status.
      const seeded = await migrator.query(
        `SELECT id FROM nexora.project_task_statuses
         WHERE organization_id = $1 AND project_id = $2 AND is_done = false
         ORDER BY sort_order LIMIT 1`,
        [organizationId, projectId],
      );
      const statusId = seeded.rows[0]?.id as string;
      assert.ok(statusId, "expected a seeded workflow status");
      await migrator.query(
        `INSERT INTO nexora.tasks (id, organization_id, project_id, title, workflow_status_id, assignee_user_id, due_date, created_by_user_id)
         VALUES ($1, $2, $3, 'Due tomorrow task', $4, $5, CURRENT_DATE + 1, $5)`,
        [taskId, organizationId, projectId, statusId, userId],
      );
      // Negative fixtures: wrong date and already completed must not
      // produce reminders, even though both belong to the same user.
      await migrator.query(
        `INSERT INTO nexora.tasks (id, organization_id, project_id, title, workflow_status_id, assignee_user_id, due_date, created_by_user_id)
         VALUES ($1, $2, $3, 'Due in two days', $4, $5, CURRENT_DATE + 2, $5)`,
        [randomUUID(), organizationId, projectId, statusId, userId],
      );
      // Completion is derived from the workflow status by a trigger
      // (an open status forces completed_at NULL), so the completed
      // fixture must use the Done column, not a manual timestamp.
      const doneStatus = await migrator.query(
        `SELECT id FROM nexora.project_task_statuses
         WHERE organization_id = $1 AND project_id = $2 AND is_done = true
         ORDER BY sort_order LIMIT 1`,
        [organizationId, projectId],
      );
      await migrator.query(
        `INSERT INTO nexora.tasks (id, organization_id, project_id, title, workflow_status_id, assignee_user_id, due_date, created_by_user_id)
         VALUES ($1, $2, $3, 'Completed already', $4, $5, CURRENT_DATE + 1, $5)`,
        [randomUUID(), organizationId, projectId, doneStatus.rows[0]?.id as string, userId],
      );

      const first = await runCron(cronRequest("due-date", process.env.NEXORA_CRON_TOKEN), {
        params: Promise.resolve({ job: "due-date" }),
      });
      assert.equal(first.status, 200, await first.clone().text());
      const firstBody = (await first.json()) as { data: { replay: boolean; detail: string } };
      assert.equal(firstBody.data.replay, false);
      assert.match(firstBody.data.detail, /due-date reminders created: 1/);

      const second = await runCron(cronRequest("due-date", process.env.NEXORA_CRON_TOKEN), {
        params: Promise.resolve({ job: "due-date" }),
      });
      assert.equal(second.status, 200);
      const secondBody = (await second.json()) as { data: { replay: boolean } };
      assert.equal(secondBody.data.replay, true);

      const notifications = await migrator.query(
        `SELECT count(*)::int AS n FROM nexora.notifications
         WHERE organization_id = $1 AND event_type = 'due_date' AND target_id = $2`,
        [organizationId, taskId],
      );
      assert.equal(notifications.rows[0]?.n, 1);
    } finally {
      await migrator.end();
    }
  },
);

test(
  "organization creation replays with the same idempotency key and conflicts on a different body",
  { skip: !connectionString },
  async () => {
    smtp = await startSmtpCaptureServer();
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = String(smtp.port);
    process.env.SMTP_SECURE = "false";
    process.env.SMTP_REQUIRE_TLS = "false";
    process.env.SMTP_USER = "";
    process.env.SMTP_PASSWORD = "";
    process.env.SMTP_FROM = "noreply@nexora.example.test";

    const email = `${randomUUID()}@example.test`;
    const registered = await register(
      apiRequest("/api/auth/register", "POST", { name: "Idem User", email, password: "idem user password" }),
    );
    assert.equal(registered.status, 202);
    const verificationToken = tokenFromMessage(smtp.messages.at(-1) ?? "", "/verify-email");
    const verified = await consumeVerification(
      apiRequest("/api/auth/verification/consume", "POST", { token: verificationToken }),
    );
    assert.equal(verified.status, 200);
    const loginResponse = await login(
      apiRequest("/api/auth/login", "POST", { email, password: "idem user password" }),
    );
    assert.equal(loginResponse.status, 200);
    const cookie = `nexora_session=${loginResponse.headers.get("set-cookie")?.match(/nexora_session=([^;]+)/)?.[1]}`;
    const slug = `idem-${randomUUID().slice(0, 8)}`;
    const key = "idem-key-12345678";

    const first = await createOrganization(
      apiRequest("/api/organizations", "POST", { name: "Idem Org", slug }, cookie, {
        "idempotency-key": key,
      }),
    );
    assert.equal(first.status, 201, await first.clone().text());
    const firstBody = (await first.json()) as { data: { organization: { id: string } } };

    const replay = await createOrganization(
      apiRequest("/api/organizations", "POST", { name: "Idem Org", slug }, cookie, {
        "idempotency-key": key,
      }),
    );
    assert.equal(replay.status, 201);
    const replayBody = (await replay.json()) as { data: { organization: { id: string } } };
    assert.equal(replayBody.data.organization.id, firstBody.data.organization.id);

    const conflict = await createOrganization(
      apiRequest("/api/organizations", "POST", { name: "Different Org", slug: `other-${slug}` }, cookie, {
        "idempotency-key": key,
      }),
    );
    assert.equal(conflict.status, 409);
  },
);
