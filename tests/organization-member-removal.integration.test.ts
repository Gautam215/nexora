import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server.js";
import { Client } from "pg";
import { POST as register } from "../src/app/api/auth/register/route.ts";
import { POST as login } from "../src/app/api/auth/login/route.ts";
import { POST as consumeVerification } from "../src/app/api/auth/verification/consume/route.ts";
import { POST as createOrganization } from "../src/app/api/organizations/route.ts";
import { GET as getOrganization } from "../src/app/api/organizations/[organizationId]/route.ts";
import { POST as inviteOrganizationMember } from "../src/app/api/organizations/[organizationId]/members/route.ts";
import { DELETE as removeOrganizationMember } from "../src/app/api/organizations/[organizationId]/members/[userId]/route.ts";
import { POST as acceptInvitation } from "../src/app/api/invitations/accept/route.ts";
import { POST as createProject } from "../src/app/api/organizations/[organizationId]/projects/route.ts";
import { POST as addProjectMember } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/members/route.ts";
import {
  GET as listTasks,
  POST as createTask,
} from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/route.ts";
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
  return { userId: result.data.user.id, cookie: `nexora_session=${cookie}` };
}

async function inviteAndAccept(ownerCookie: string, organizationId: string, email: string) {
  const invite = await inviteOrganizationMember(
    apiRequest(`/api/organizations/${organizationId}/members`, "POST", { email, role: "member" }, ownerCookie),
    { params: Promise.resolve({ organizationId }) },
  );
  assert.equal(invite.status, 201, await invite.clone().text());
  const token = tokenFromMessage(smtp?.messages.at(-1) ?? "", "/accept-invitation");
  const user = await registerVerifyAndLogin(email, "Removal User", "removal user password");
  const accepted = await acceptInvitation(
    apiRequest("/api/invitations/accept", "POST", { token }, user.cookie),
  );
  assert.equal(accepted.status, 200, await accepted.clone().text());
  return user;
}

test(
  "organization member removal: admin removes, self-leave works, owner is protected",
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

    const owner = await registerVerifyAndLogin(
      `${randomUUID()}@example.test`,
      "Removal Owner",
      "removal owner password",
    );
    const orgResponse = await createOrganization(
      apiRequest("/api/organizations", "POST", { name: "Removal Workspace", slug: `removal-${owner.userId.slice(0, 8)}` }, owner.cookie),
    );
    assert.equal(orgResponse.status, 201);
    const organizationId = ((await orgResponse.json()) as { data: { organization: { id: string } } }).data.organization.id;

    const member = await inviteAndAccept(owner.cookie, organizationId, `${randomUUID()}@example.test`);
    const leaver = await inviteAndAccept(owner.cookie, organizationId, `${randomUUID()}@example.test`);

    const projectResponse = await createProject(
      apiRequest(`/api/organizations/${organizationId}/projects`, "POST", { name: "Removal Project" }, owner.cookie),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(projectResponse.status, 201);
    const projectId = ((await projectResponse.json()) as { data: { project: { id: string } } }).data.project.id;

    const added = await addProjectMember(
      apiRequest(`/api/organizations/${organizationId}/projects/${projectId}/members`, "POST", { userId: member.userId, role: "member" }, owner.cookie),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(added.status, 201, await added.clone().text());
    const taskResponse = await createTask(
      apiRequest(`/api/organizations/${organizationId}/projects/${projectId}/tasks`, "POST", { title: "Assigned before removal", assigneeId: member.userId }, owner.cookie, { "idempotency-key": `removal-task-${randomUUID()}` }),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(taskResponse.status, 201, await taskResponse.clone().text());

    // A plain member cannot remove another member.
    const memberRemoves = await removeOrganizationMember(
      apiRequest(`/api/organizations/${organizationId}/members/${leaver.userId}`, "DELETE", undefined, member.cookie),
      { params: Promise.resolve({ organizationId, userId: leaver.userId }) },
    );
    assert.equal(memberRemoves.status, 403);

    // A member cannot remove the owner.
    const memberRemovesOwner = await removeOrganizationMember(
      apiRequest(`/api/organizations/${organizationId}/members/${owner.userId}`, "DELETE", undefined, member.cookie),
      { params: Promise.resolve({ organizationId, userId: owner.userId }) },
    );
    assert.equal(memberRemovesOwner.status, 403);

    // Owner removes a member: org access is denied afterwards, the
    // assigned task survives but becomes unassigned. The membership row
    // itself is disabled, not deleted (history anchors), so a second
    // removal is an idempotent success, not a 404.
    const removed = await removeOrganizationMember(
      apiRequest(`/api/organizations/${organizationId}/members/${member.userId}`, "DELETE", undefined, owner.cookie),
      { params: Promise.resolve({ organizationId, userId: member.userId }) },
    );
    assert.equal(removed.status, 200, await removed.clone().text());
    const removedBody = (await removed.json()) as { data: { removed: boolean; tasksUnassigned: number } };
    assert.equal(removedBody.data.removed, true);
    assert.equal(removedBody.data.tasksUnassigned, 1);
    // Removal revokes the member's sessions, so the old cookie is
    // unauthenticated (401); the org itself would deny a still-valid
    // session with 403, as the stranger case in the matrix test shows.
    const removedRead = await getOrganization(
      apiRequest(`/api/organizations/${organizationId}`, "GET", undefined, member.cookie),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(removedRead.status, 401);
    const tasksAfter = await listTasks(
      apiRequest(`/api/organizations/${organizationId}/projects/${projectId}/tasks`, "GET", undefined, owner.cookie),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    const tasksBody = (await tasksAfter.json()) as { data: { tasks: Array<{ title: string; assignee_user_id: string | null }> } };
    const surviving = tasksBody.data.tasks.find((task) => task.title === "Assigned before removal");
    assert.ok(surviving, "assigned task must survive removal");
    assert.equal(surviving.assignee_user_id, null);

    const removedAgain = await removeOrganizationMember(
      apiRequest(`/api/organizations/${organizationId}/members/${member.userId}`, "DELETE", undefined, owner.cookie),
      { params: Promise.resolve({ organizationId, userId: member.userId }) },
    );
    assert.equal(removedAgain.status, 200, await removedAgain.clone().text());

    // Self-leave works for a plain member.
    const left = await removeOrganizationMember(
      apiRequest(`/api/organizations/${organizationId}/members/${leaver.userId}`, "DELETE", undefined, leaver.cookie),
      { params: Promise.resolve({ organizationId, userId: leaver.userId }) },
    );
    assert.equal(left.status, 200, await left.clone().text());
    // Self-leave keeps the leaver's sessions: the disabled membership
    // itself denies org access, so this is a 403, not a 401.
    const leaverRead = await getOrganization(
      apiRequest(`/api/organizations/${organizationId}`, "GET", undefined, leaver.cookie),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(leaverRead.status, 403);

    // A sole owner cannot leave: the workspace would be orphaned.
    const ownerLeaves = await removeOrganizationMember(
      apiRequest(`/api/organizations/${organizationId}/members/${owner.userId}`, "DELETE", undefined, owner.cookie),
      { params: Promise.resolve({ organizationId, userId: owner.userId }) },
    );
    assert.equal(ownerLeaves.status, 409);
    const ownerLeaveBody = (await ownerLeaves.json()) as { error: { code: string } };
    assert.equal(ownerLeaveBody.error.code, "LAST_OWNER");
    // And the owner still has access afterwards.
    const ownerRead = await getOrganization(
      apiRequest(`/api/organizations/${organizationId}`, "GET", undefined, owner.cookie),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(ownerRead.status, 200);
  },
);

test(
  "organization member removal: admin removal deletes a pending invitation for that member",
  { skip: !connectionString || !migratorConnectionString },
  async () => {
    // Regression test for the independent security review (2026-10-28):
    // the removal route deleted pending invitations by looking the
    // target's email up in nexora.users, which RLS restricts to the
    // caller's own row, so an admin removing another member silently
    // deleted zero invitations. The email must come from the
    // SECURITY DEFINER member list instead. A pending invitation for
    // an existing member cannot be created through the invite API
    // (it returns ALREADY_A_MEMBER), so this test seeds one directly
    // as the migrator, which is the only way the stale-token state
    // can arise (for example, an invitation left pending while the
    // member joined through another path).
    // Reuse the first test's capture server when it is already open:
    // the email transporter is cached per process, so a second server
    // would receive nothing, and closing the first server here would
    // leave the file-level after() hook with nothing to close while
    // the first server keeps the test process alive forever.
    const ownsSmtp = smtp === undefined;
    const capture = ownsSmtp ? await startSmtpCaptureServer() : smtp;
    assert.ok(capture);
    smtp = capture;
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = String(capture.port);
    process.env.SMTP_SECURE = "false";
    process.env.SMTP_REQUIRE_TLS = "false";
    process.env.SMTP_USER = "";
    process.env.SMTP_PASSWORD = "";
    process.env.SMTP_FROM = "noreply@nexora.example.test";
    try {
      const owner = await registerVerifyAndLogin(
        `${randomUUID()}@example.test`,
        "Invitation Removal Owner",
        "invitation removal owner password",
      );
      const orgResponse = await createOrganization(
        apiRequest("/api/organizations", "POST", { name: "Invitation Removal Workspace", slug: `invite-removal-${owner.userId.slice(0, 8)}` }, owner.cookie),
      );
      assert.equal(orgResponse.status, 201);
      const organizationId = ((await orgResponse.json()) as { data: { organization: { id: string } } }).data.organization.id;

      const memberEmail = `${randomUUID()}@example.test`;
      const member = await inviteAndAccept(owner.cookie, organizationId, memberEmail);

      const migrator = new Client({ connectionString: migratorConnectionString });
      await migrator.connect();
      try {
        await migrator.query(
          `INSERT INTO nexora.organization_invitations
             (id, organization_id, email, role, token_hash, invited_by, expires_at)
           VALUES ($1, $2, $3, 'member', $4, $5, pg_catalog.now() + interval '1 day')`,
          [randomUUID(), organizationId, memberEmail, randomBytes(32).toString("hex"), owner.userId],
        );
      } finally {
        await migrator.end();
      }

      const removed = await removeOrganizationMember(
        apiRequest(`/api/organizations/${organizationId}/members/${member.userId}`, "DELETE", undefined, owner.cookie),
        { params: Promise.resolve({ organizationId, userId: member.userId }) },
      );
      assert.equal(removed.status, 200, await removed.clone().text());

      const checker = new Client({ connectionString: migratorConnectionString });
      await checker.connect();
      try {
        const remaining = await checker.query(
          `SELECT count(*)::int AS count FROM nexora.organization_invitations
           WHERE organization_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
          [organizationId, memberEmail],
        );
        assert.equal(remaining.rows[0]?.count, 0, "pending invitation must be deleted on removal");
      } finally {
        await checker.end();
      }
    } finally {
      if (ownsSmtp) {
        await smtp?.close();
        smtp = undefined;
      }
    }
  },
);
