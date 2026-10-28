import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server.js";
import { Client } from "pg";
import { POST as register } from "../src/app/api/auth/register/route.ts";
import { POST as login } from "../src/app/api/auth/login/route.ts";
import { POST as consumeVerification } from "../src/app/api/auth/verification/consume/route.ts";
import { POST as createOrganization } from "../src/app/api/organizations/route.ts";
import { DELETE as deleteOrganization } from "../src/app/api/organizations/[organizationId]/route.ts";
import { GET as getOrganization } from "../src/app/api/organizations/[organizationId]/route.ts";
import { POST as createProject } from "../src/app/api/organizations/[organizationId]/projects/route.ts";
import { POST as createTask } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/route.ts";
import { POST as createComment } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/[taskId]/comments/route.ts";
import { GET as exportAccount } from "../src/app/api/account/export/route.ts";
import { DELETE as deleteAccount } from "../src/app/api/account/route.ts";
import { closeDatabasePool } from "../src/server/db.ts";
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
let smtp: SmtpCapture | undefined;

after(async () => {
  await smtp?.close();
  await closeDatabasePool();
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

function tokenFromMessage(message: string, pathname: string): string {
  const decoded = message
    .split(`=${String.fromCharCode(13, 10)}`)
    .join("")
    .replaceAll("=3D", "=");
  const marker = `${pathname}?token=`;
  const start = decoded.indexOf(marker);
  assert.ok(start >= 0, `expected ${pathname} token in captured email`);
  const rest = decoded.slice(start + marker.length);
  const end = rest.search(/[^A-Za-z0-9._~-]/);
  return end === -1 ? rest : rest.slice(0, end);
}

async function registerVerifyAndLogin(email: string, name: string, password: string) {
  const registered = await register(
    apiRequest("/api/auth/register", "POST", { name, email, password }),
  );
  assert.equal(registered.status, 202);
  const verificationToken = tokenFromMessage(smtp?.messages.at(-1) ?? "", "/verify-email");
  const verified = await consumeVerification(
    apiRequest("/api/auth/verification/consume", "POST", { token: verificationToken }),
  );
  assert.equal(verified.status, 200);
  const loginResponse = await login(
    apiRequest("/api/auth/login", "POST", { email, password }),
  );
  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get("set-cookie")?.match(/nexora_session=([^;]+)/)?.[1];
  assert.ok(cookie);
  const result = (await loginResponse.json()) as { data: { user: { id: string } } };
  return { userId: result.data.user.id, cookie: `nexora_session=${cookie}`, email, password };
}

test(
  "account export returns own data, deletion scrubs and blocks sign-in, sole owner is blocked",
  { skip: !connectionString || !migratorConnectionString },
  async () => {
    smtp = await startSmtpCaptureServer();
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = String(smtp.port);
    process.env.SMTP_SECURE = "false";
    process.env.SMTP_REQUIRE_TLS = "false";
    process.env.SMTP_FROM = "noreply@nexora.example.test";
    process.env.SMTP_USER = "";
    process.env.SMTP_PASSWORD = "";

    const suffix = randomUUID().slice(0, 8);
    const user = await registerVerifyAndLogin(
      `account-${suffix}@example.test`,
      "Account User",
      "account user password",
    );
    const orgResponse = await createOrganization(
      apiRequest("/api/organizations", "POST", { name: `Account Org ${suffix}`, slug: `account-org-${suffix}` }, user.cookie),
    );
    assert.equal(orgResponse.status, 201, await orgResponse.clone().text());
    const org = (await orgResponse.json()) as { data: { organization: { id: string; slug: string } } };
    const organizationId = org.data.organization.id;

    const projectResponse = await createProject(
      apiRequest(`/api/organizations/${organizationId}/projects`, "POST", { name: `Account Project ${suffix}` }, user.cookie),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(projectResponse.status, 201, await projectResponse.clone().text());
    const project = (await projectResponse.json()) as { data: { project: { id: string } } };
    const projectId = project.data.project.id;

    const taskResponse = await createTask(
      apiRequest(`/api/organizations/${organizationId}/projects/${projectId}/tasks`, "POST", { title: `Account Task ${suffix}` }, user.cookie, { "idempotency-key": `account-task-${suffix}` }),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(taskResponse.status, 201, await taskResponse.clone().text());
    const task = (await taskResponse.json()) as { data: { task: { id: string } } };
    const taskId = task.data.task.id;

    const commentBody = `account export marker ${suffix}`;
    const commentResponse = await createComment(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${projectId}/tasks/${taskId}/comments`,
        "POST",
        { body: commentBody },
        user.cookie,
        { "idempotency-key": `account-comment-${suffix}` },
      ),
      { params: Promise.resolve({ organizationId, projectId, taskId }) },
    );
    assert.equal(commentResponse.status, 201, await commentResponse.clone().text());

    // Export returns the caller's own data across the workspace.
    const exported = await exportAccount(
      apiRequest("/api/account/export", "GET", undefined, user.cookie),
    );
    assert.equal(exported.status, 200, await exported.clone().text());
    const exportData = (await exported.json()) as {
      data: {
        export: {
          profile: { email: string };
          memberships: Array<{ organization_id: string }>;
          projects: Array<{ id: string }>;
          tasks_created: Array<{ id: string }>;
          comments: Array<{ body: string }>;
          files: unknown[];
        };
      };
    };
    assert.equal(exportData.data.export.profile.email, user.email);
    assert.ok(exportData.data.export.memberships.some((m) => m.organization_id === organizationId));
    assert.ok(exportData.data.export.projects.some((p) => p.id === projectId));
    assert.ok(exportData.data.export.tasks_created.some((t) => t.id === taskId));
    assert.ok(exportData.data.export.comments.some((c) => c.body === commentBody));
    assert.ok(Array.isArray(exportData.data.export.files));

    // Wrong confirmation email is rejected and the account survives.
    const wrongDelete = await deleteAccount(
      apiRequest("/api/account", "DELETE", { confirmation: "someone-else@example.test" }, user.cookie),
    );
    assert.equal(wrongDelete.status, 409);
    const stillIn = await login(apiRequest("/api/auth/login", "POST", { email: user.email, password: user.password }));
    assert.equal(stillIn.status, 200);

    // The account owns its workspace, so deletion is blocked until the
    // workspace itself is deleted (the app has no ownership transfer).
    const blockedFirst = await deleteAccount(
      apiRequest("/api/account", "DELETE", { confirmation: user.email }, user.cookie),
    );
    assert.equal(blockedFirst.status, 409, await blockedFirst.clone().text());
    const orgDeleted = await deleteOrganization(
      apiRequest(`/api/organizations/${organizationId}`, "DELETE", { slug: org.data.organization.slug }, user.cookie),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(orgDeleted.status, 200, await orgDeleted.clone().text());

    // Correct confirmation deletes the account.
    const deleted = await deleteAccount(
      apiRequest("/api/account", "DELETE", { confirmation: user.email }, user.cookie),
    );
    assert.equal(deleted.status, 200, await deleted.clone().text());
    assert.ok(deleted.headers.get("set-cookie")?.includes("nexora_session=;"));

    // Sign-in is denied and the old session is gone.
    const lockedOut = await login(apiRequest("/api/auth/login", "POST", { email: user.email, password: user.password }));
    assert.equal(lockedOut.status, 401);
    const orgAfter = await getOrganization(
      apiRequest(`/api/organizations/${organizationId}`, "GET", undefined, user.cookie),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(orgAfter.status, 401);

    // The row is scrubbed, not removed: suspended, anonymized, stamped.
    const migrator = new Client({ connectionString: migratorConnectionString });
    await migrator.connect();
    try {
      const row = await migrator.query(
        "SELECT email, display_name, status, email_verified_at, deleted_at FROM nexora.users WHERE id = $1",
        [user.userId],
      );
      assert.equal(row.rows[0]?.status, "suspended");
      assert.equal(row.rows[0]?.display_name, "Deleted user");
      assert.match(row.rows[0]?.email ?? "", /^deleted-.*@deleted\.invalid$/);
      assert.equal(row.rows[0]?.email_verified_at, null);
      assert.ok(row.rows[0]?.deleted_at);
      const membership = await migrator.query(
        "SELECT status FROM nexora.organization_memberships WHERE user_id = $1 AND organization_id = $2",
        [user.userId, organizationId],
      );
      assert.equal(membership.rows[0]?.status, "disabled");
      const sessions = await migrator.query(
        "SELECT count(*)::int AS count FROM nexora.user_sessions WHERE user_id = $1",
        [user.userId],
      );
      assert.equal(sessions.rows[0]?.count, 0);
    } finally {
      await migrator.end();
    }

    // A sole owner is blocked and keeps working.
    const owner = await registerVerifyAndLogin(
      `sole-owner-${suffix}@example.test`,
      "Sole Owner",
      "sole owner password",
    );
    const soloResponse = await createOrganization(
      apiRequest("/api/organizations", "POST", { name: `Solo Org ${suffix}`, slug: `solo-org-${suffix}` }, owner.cookie),
    );
    assert.equal(soloResponse.status, 201, await soloResponse.clone().text());
    const solo = (await soloResponse.json()) as { data: { organization: { id: string; slug: string } } };
    const blocked = await deleteAccount(
      apiRequest("/api/account", "DELETE", { confirmation: owner.email }, owner.cookie),
    );
    assert.equal(blocked.status, 409, await blocked.clone().text());
    const blockedBody = (await blocked.json()) as { error: { code: string; message: string } };
    assert.equal(blockedBody.error.code, "ACCOUNT_SOLE_OWNER");
    assert.ok(blockedBody.error.message.includes(solo.data.organization.slug));
    const ownerStillIn = await login(apiRequest("/api/auth/login", "POST", { email: owner.email, password: owner.password }));
    assert.equal(ownerStillIn.status, 200);
  },
);
