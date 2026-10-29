import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { NextRequest } from "next/server.js";
import { Client } from "pg";
import { POST as register } from "../src/app/api/auth/register/route.ts";
import { POST as login } from "../src/app/api/auth/login/route.ts";
import { POST as consumeVerification } from "../src/app/api/auth/verification/consume/route.ts";
import { POST as createOrganization } from "../src/app/api/organizations/route.ts";
import { POST as createOrganizationInvitation } from "../src/app/api/organizations/[organizationId]/members/route.ts";
import { POST as acceptInvitation } from "../src/app/api/invitations/accept/route.ts";
import {
  GET as listProjects,
  POST as createProject,
} from "../src/app/api/organizations/[organizationId]/projects/route.ts";
import {
  DELETE as deleteProject,
  GET as getProject,
  PATCH as updateProject,
} from "../src/app/api/organizations/[organizationId]/projects/[projectId]/route.ts";
import { POST as addProjectMember } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/members/route.ts";
import {
  GET as listMilestones,
  POST as createMilestone,
} from "../src/app/api/organizations/[organizationId]/projects/[projectId]/milestones/route.ts";
import {
  GET as listTasks,
  POST as createTask,
} from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/route.ts";
import {
  GET as listTaskComments,
  POST as createTaskComment,
} from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/[taskId]/comments/route.ts";
import {
  GET as listTaskFiles,
  POST as uploadTaskFile,
} from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/[taskId]/files/route.ts";
import { GET as getTaskFile } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/[taskId]/files/[fileId]/route.ts";
import { GET as getProjectActivity } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/activity/route.ts";
import { GET as getProjectAnalytics } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/analytics/route.ts";
import { GET as listNotifications } from "../src/app/api/organizations/[organizationId]/notifications/route.ts";
import { GET as searchOrganization } from "../src/app/api/organizations/[organizationId]/search/route.ts";
import { closeDatabasePool, withOrganizationContext } from "../src/server/db.ts";
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
let privateFilesRoot: string | undefined;
let previousPrivateFileDirectory: string | undefined;
let previousFileSigningKey: string | undefined;
let previousScanner: string | undefined;
let previousClamHost: string | undefined;
let previousClamPort: string | undefined;

after(async () => {
  await smtp?.close();
  await closeDatabasePool();
  if (privateFilesRoot) await rm(privateFilesRoot, { recursive: true, force: true });
  if (previousPrivateFileDirectory === undefined) delete process.env.NEXORA_PRIVATE_FILE_DIR;
  else process.env.NEXORA_PRIVATE_FILE_DIR = previousPrivateFileDirectory;
  if (previousFileSigningKey === undefined) delete process.env.NEXORA_FILE_SIGNING_KEY;
  else process.env.NEXORA_FILE_SIGNING_KEY = previousFileSigningKey;
  if (previousScanner === undefined) delete process.env.NEXORA_MALWARE_SCANNER;
  else process.env.NEXORA_MALWARE_SCANNER = previousScanner;
  if (previousClamHost === undefined) delete process.env.NEXORA_CLAMAV_HOST;
  else process.env.NEXORA_CLAMAV_HOST = previousClamHost;
  if (previousClamPort === undefined) delete process.env.NEXORA_CLAMAV_PORT;
  else process.env.NEXORA_CLAMAV_PORT = previousClamPort;
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

async function withTrustedClientIp<T>(work: (headerName: string) => Promise<T>): Promise<T> {
  const headerName = "x-nexora-test-client-ip";
  const previousHeader = process.env.NEXORA_TRUSTED_CLIENT_IP_HEADER;
  process.env.NEXORA_TRUSTED_CLIENT_IP_HEADER = headerName;
  try {
    return await work(headerName);
  } finally {
    if (previousHeader === undefined) delete process.env.NEXORA_TRUSTED_CLIENT_IP_HEADER;
    else process.env.NEXORA_TRUSTED_CLIENT_IP_HEADER = previousHeader;
  }
}

function privateFileRequest(
  pathname: string,
  method: "POST" | "PUT",
  bytes: Uint8Array,
  filename: string,
  cookie: string,
  extraHeaders?: Record<string, string>,
): NextRequest {
  const headers = new Headers(extraHeaders);
  headers.set("origin", origin);
  headers.set("content-type", "text/plain");
  headers.set("x-file-name", encodeURIComponent(filename));
  headers.set("cookie", cookie);
  return new NextRequest(`${origin}${pathname}`, {
    method,
    headers,
    body: new Uint8Array(bytes),
  });
}

function tokenFromMessage(message: string, pathname: string): string {
  const decoded = message.replace(/=\r\n/g, "").replace(/=3D/gi, "=");
  const token = decoded.match(new RegExp(`${pathname}\\?token=([^\\s"']+)`))?.[1];
  assert.ok(token, `expected ${pathname} token in captured email`);
  return token;
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

async function createWorkspace(cookie: string, slug: string) {
  const response = await createOrganization(
    apiRequest("/api/organizations", "POST", { name: "Deletion Workspace", slug }, cookie),
  );
  assert.equal(response.status, 201);
  const result = (await response.json()) as { data: { organization: { id: string } } };
  return result.data.organization.id;
}

async function inviteToOrganization(cookie: string, organizationId: string, email: string, role: string) {
  const response = await createOrganizationInvitation(
    apiRequest(
      `/api/organizations/${organizationId}/members`,
      "POST",
      { email, role },
      cookie,
    ),
    { params: Promise.resolve({ organizationId }) },
  );
  assert.equal(response.status, 201);
  const token = tokenFromMessage(smtp?.messages.at(-1) ?? "", "/accept-invitation");
  return token;
}

async function createProjectAs(cookie: string, organizationId: string, name: string) {
  const response = await createProject(
    apiRequest(`/api/organizations/${organizationId}/projects`, "POST", { name }, cookie),
    { params: Promise.resolve({ organizationId }) },
  );
  assert.equal(response.status, 201);
  const body = (await response.json()) as { data: { project: { id: string; version: number } } };
  return body.data.project;
}

async function deleteProjectAs(cookie: string, organizationId: string, projectId: string, expectedVersion: number) {
  return deleteProject(
    apiRequest(
      `/api/organizations/${organizationId}/projects/${projectId}`,
      "DELETE",
      { expectedVersion },
      cookie,
    ),
    { params: Promise.resolve({ organizationId, projectId }) },
  );
}

async function appQuery<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query(sql, params as never[]);
    return result.rows as T[];
  } finally {
    await client.end();
  }
}

async function migratorQueryAs<T>(
  userId: string,
  organizationId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  // Notifications use FORCE row-level security with a recipient-scoped
  // SELECT policy, so counting them requires a recipient session context
  // (plain owner queries return zero rows). The context is set inside an
  // explicit transaction because set_config(..., true) is transaction-local.
  assert.ok(migratorConnectionString, "migrator connection required for this check");
  const client = new Client({ connectionString: migratorConnectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_catalog.set_config('nexora.user_id', $1, true), pg_catalog.set_config('nexora.organization_id', $2, true)",
      [userId, organizationId],
    );
    const result = await client.query(sql, params as never[]);
    await client.query("ROLLBACK");
    return result.rows as T[];
  } finally {
    await client.end();
  }
}

async function migratorQuery<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  assert.ok(migratorConnectionString, "migrator connection required for this check");
  const client = new Client({ connectionString: migratorConnectionString });
  await client.connect();
  try {
    const result = await client.query(sql, params as never[]);
    return result.rows as T[];
  } finally {
    await client.end();
  }
}

async function diskContainsKey(root: string, key: string): Promise<boolean> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries.some((entry) => entry.isFile() && entry.name.includes(key));
}

const execFileAsync = promisify(execFile);

test(
  "project deletion soft-deletes, hides, and purges after retention",
  { skip: !connectionString },
  async (t) => {
    smtp = await startSmtpCaptureServer();
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = String(smtp.port);
    process.env.SMTP_SECURE = "false";
    process.env.SMTP_REQUIRE_TLS = "false";
    process.env.SMTP_USER = "";
    process.env.SMTP_PASSWORD = "";
    process.env.SMTP_FROM = "noreply@nexora.example.test";
    previousPrivateFileDirectory = process.env.NEXORA_PRIVATE_FILE_DIR;
    previousFileSigningKey = process.env.NEXORA_FILE_SIGNING_KEY;
    privateFilesRoot = await mkdtemp(path.join(os.tmpdir(), "nexora-delete-files-"));
    process.env.NEXORA_PRIVATE_FILE_DIR = privateFilesRoot;
    process.env.NEXORA_FILE_SIGNING_KEY = randomBytes(32).toString("hex");

    // Pending downloads are refused (2026-10-28 ₹0 round), so this
    // scenario's incidental file downloads run against a clean-only
    // fake clamd; the scenario itself is about project visibility,
    // not scan states (those are covered in
    // task-file-scan.integration.test.ts).
    previousScanner = process.env.NEXORA_MALWARE_SCANNER;
    previousClamHost = process.env.NEXORA_CLAMAV_HOST;
    previousClamPort = process.env.NEXORA_CLAMAV_PORT;
    const clamd = createServer((socket) => {
      let buffer = Buffer.alloc(0);
      let headerConsumed = false;
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!headerConsumed) {
          if (buffer.byteLength < 10) return;
          buffer = buffer.subarray(10);
          headerConsumed = true;
        }
        for (;;) {
          if (buffer.byteLength < 4) return;
          const length = buffer.readUInt32BE(0);
          if (buffer.byteLength < 4 + length) return;
          buffer = buffer.subarray(4 + length);
          if (length === 0) {
            socket.end("stream: OK\n");
            return;
          }
        }
      });
    });
    await new Promise<void>((resolve) => clamd.listen(0, "127.0.0.1", resolve));
    const clamdAddress = clamd.address();
    assert.ok(clamdAddress && typeof clamdAddress !== "string");
    process.env.NEXORA_MALWARE_SCANNER = "clamav";
    process.env.NEXORA_CLAMAV_HOST = "127.0.0.1";
    process.env.NEXORA_CLAMAV_PORT = String(clamdAddress.port);
    t.after(async () => {
      await new Promise<void>((resolve) => clamd.close(() => resolve()));
      if (previousScanner === undefined) delete process.env.NEXORA_MALWARE_SCANNER;
      else process.env.NEXORA_MALWARE_SCANNER = previousScanner;
      if (previousClamHost === undefined) delete process.env.NEXORA_CLAMAV_HOST;
      else process.env.NEXORA_CLAMAV_HOST = previousClamHost;
      if (previousClamPort === undefined) delete process.env.NEXORA_CLAMAV_PORT;
      else process.env.NEXORA_CLAMAV_PORT = previousClamPort;
    });

    const owner = await registerVerifyAndLogin(
      `${randomUUID()}@example.test`,
      "Deletion Owner",
      "deletion owner password",
    );
    const organizationId = await createWorkspace(owner.cookie, `deletion-${owner.userId.slice(0, 8)}`);

    await t.test("manager, organization owner, and organization admin can delete; others cannot", async () => {
      const project = await createProjectAs(owner.cookie, organizationId, "Deletable project");

      const managerEmail = `${randomUUID()}@example.test`;
      const managerToken = await inviteToOrganization(owner.cookie, organizationId, managerEmail, "member");
      const manager = await registerVerifyAndLogin(managerEmail, "Project Manager", "project manager password");
      assert.equal(
        (await acceptInvitation(
          apiRequest("/api/invitations/accept", "POST", { token: managerToken }, manager.cookie),
        )).status,
        200,
      );
      const managerAdded = await addProjectMember(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${project.id}/members`,
          "POST",
          { userId: manager.userId, role: "manager" },
          owner.cookie,
        ),
        { params: Promise.resolve({ organizationId, projectId: project.id }) },
      );
      assert.equal(managerAdded.status, 201);

      const viewerEmail = `${randomUUID()}@example.test`;
      const viewerToken = await inviteToOrganization(owner.cookie, organizationId, viewerEmail, "member");
      const viewer = await registerVerifyAndLogin(viewerEmail, "Project Viewer", "project viewer password");
      assert.equal(
        (await acceptInvitation(
          apiRequest("/api/invitations/accept", "POST", { token: viewerToken }, viewer.cookie),
        )).status,
        200,
      );
      const viewerAdded = await addProjectMember(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${project.id}/members`,
          "POST",
          { userId: viewer.userId, role: "viewer" },
          owner.cookie,
        ),
        { params: Promise.resolve({ organizationId, projectId: project.id }) },
      );
      assert.equal(viewerAdded.status, 201);

      const outsiderEmail = `${randomUUID()}@example.test`;
      const outsiderToken = await inviteToOrganization(owner.cookie, organizationId, outsiderEmail, "member");
      const outsider = await registerVerifyAndLogin(outsiderEmail, "Project Outsider", "project outsider password");
      assert.equal(
        (await acceptInvitation(
          apiRequest("/api/invitations/accept", "POST", { token: outsiderToken }, outsider.cookie),
        )).status,
        200,
      );

      const viewerDenied = await deleteProjectAs(viewer.cookie, organizationId, project.id, project.version);
      assert.equal(viewerDenied.status, 403);
      const viewerDeniedBody = (await viewerDenied.json()) as { error: { code: string } };
      assert.equal(viewerDeniedBody.error.code, "PROJECT_MANAGEMENT_REQUIRED");

      // A same-organization user who is not a project member cannot even
      // see the project: the projects SELECT policy hides it, so the
      // delete reads nothing and reports 404 rather than 403.
      const outsiderDenied = await deleteProjectAs(outsider.cookie, organizationId, project.id, project.version);
      assert.equal(outsiderDenied.status, 404);
      const outsiderDeniedBody = (await outsiderDenied.json()) as { error: { code: string } };
      assert.equal(outsiderDeniedBody.error.code, "PROJECT_NOT_FOUND");

      const staleVersion = await deleteProjectAs(manager.cookie, organizationId, project.id, project.version + 1);
      assert.equal(staleVersion.status, 409);
      const staleBody = (await staleVersion.json()) as { error: { code: string } };
      assert.equal(staleBody.error.code, "VERSION_CONFLICT");

      const stillThere = await getProject(
        apiRequest(`/api/organizations/${organizationId}/projects/${project.id}`, "GET", undefined, manager.cookie),
        { params: Promise.resolve({ organizationId, projectId: project.id }) },
      );
      assert.equal(stillThere.status, 200);

      const managerDeleted = await deleteProjectAs(manager.cookie, organizationId, project.id, project.version);
      assert.equal(managerDeleted.status, 200);
      const managerDeletedBody = (await managerDeleted.json()) as {
        data: { projectId: string; deleted: boolean };
      };
      assert.equal(managerDeletedBody.data.projectId, project.id);
      assert.equal(managerDeletedBody.data.deleted, true);

      const getAfter = await getProject(
        apiRequest(`/api/organizations/${organizationId}/projects/${project.id}`, "GET", undefined, owner.cookie),
        { params: Promise.resolve({ organizationId, projectId: project.id }) },
      );
      assert.equal(getAfter.status, 404);

      const patchAfter = await updateProject(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${project.id}`,
          "PATCH",
          { expectedVersion: project.version + 1, name: "Should not apply" },
          owner.cookie,
        ),
        { params: Promise.resolve({ organizationId, projectId: project.id }) },
      );
      assert.equal(patchAfter.status, 404);

      const secondDelete = await deleteProjectAs(owner.cookie, organizationId, project.id, project.version + 1);
      assert.equal(secondDelete.status, 404);

      // Organization owner deletes their own project.
      const ownerProject = await createProjectAs(owner.cookie, organizationId, "Owner deletable project");
      const ownerDeleted = await deleteProjectAs(owner.cookie, organizationId, ownerProject.id, ownerProject.version);
      assert.equal(ownerDeleted.status, 200);

      // Organization admin inherits manager authority through the existing
      // authorization model, exactly as with PATCH.
      const adminEmail = `${randomUUID()}@example.test`;
      const adminToken = await inviteToOrganization(owner.cookie, organizationId, adminEmail, "admin");
      const admin = await registerVerifyAndLogin(adminEmail, "Organization Admin", "organization admin password");
      assert.equal(
        (await acceptInvitation(
          apiRequest("/api/invitations/accept", "POST", { token: adminToken }, admin.cookie),
        )).status,
        200,
      );
      const adminProject = await createProjectAs(owner.cookie, organizationId, "Admin deletable project");
      const adminDeleted = await deleteProjectAs(admin.cookie, organizationId, adminProject.id, adminProject.version);
      assert.equal(adminDeleted.status, 200);
    });

    await t.test("deleted projects disappear from lists, search, analytics, activity, and notifications", async () => {
      const project = await createProjectAs(owner.cookie, organizationId, "Vanishing project marker");

      const memberEmail = `${randomUUID()}@example.test`;
      const memberToken = await inviteToOrganization(owner.cookie, organizationId, memberEmail, "member");
      const member = await registerVerifyAndLogin(memberEmail, "Vanishing Member", "vanishing member password");
      assert.equal(
        (await acceptInvitation(
          apiRequest("/api/invitations/accept", "POST", { token: memberToken }, member.cookie),
        )).status,
        200,
      );
      assert.equal(
        (await addProjectMember(
          apiRequest(
            `/api/organizations/${organizationId}/projects/${project.id}/members`,
            "POST",
            { userId: member.userId, role: "member" },
            owner.cookie,
          ),
          { params: Promise.resolve({ organizationId, projectId: project.id }) },
        )).status,
        201,
      );

      const projectParams = { params: Promise.resolve({ organizationId, projectId: project.id }) };
      const milestoneResponse = await createMilestone(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${project.id}/milestones`,
          "POST",
          { name: "Vanishing milestone" },
          owner.cookie,
          { "idempotency-key": `vanishing-milestone-${project.id}` },
        ),
        projectParams,
      );
      assert.equal(milestoneResponse.status, 201);

      const taskResponse = await createTask(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${project.id}/tasks`,
          "POST",
          { title: "Vanishing task marker", assigneeId: member.userId },
          owner.cookie,
          { "idempotency-key": `vanishing-task-${project.id}` },
        ),
        projectParams,
      );
      assert.equal(taskResponse.status, 201);
      const taskBody = (await taskResponse.json()) as { data: { task: { id: string } } };
      const taskId = taskBody.data.task.id;

      const commentResponse = await createTaskComment(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${project.id}/tasks/${taskId}/comments`,
          "POST",
          { body: "Vanishing comment marker" },
          owner.cookie,
          { "idempotency-key": `vanishing-comment-${project.id}` },
        ),
        { params: Promise.resolve({ organizationId, projectId: project.id, taskId }) },
      );
      assert.equal(commentResponse.status, 201);

      const fileResponse = await uploadTaskFile(
        privateFileRequest(
          `/api/organizations/${organizationId}/projects/${project.id}/tasks/${taskId}/files`,
          "POST",
          Buffer.from("vanishing file bytes\n", "utf8"),
          "vanishing-notes.txt",
          owner.cookie,
          { "idempotency-key": `vanishing-file-${project.id}` },
        ),
        { params: Promise.resolve({ organizationId, projectId: project.id, taskId }) },
      );
      assert.equal(fileResponse.status, 201);
      const fileBody = (await fileResponse.json()) as { data: { file: { id: string } } };
      const fileId = fileBody.data.file.id;

      const linkResponse = await getTaskFile(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${project.id}/tasks/${taskId}/files/${fileId}`,
          "GET",
          undefined,
          owner.cookie,
        ),
        { params: Promise.resolve({ organizationId, projectId: project.id, taskId, fileId }) },
      );
      assert.equal(linkResponse.status, 200);
      const linkBody = (await linkResponse.json()) as { data: { url: string } };
      const signedUrl = linkBody.data.url;
      assert.ok(signedUrl.includes("token="));

      const notificationsBefore = await listNotifications(
        apiRequest(`/api/organizations/${organizationId}/notifications`, "GET", undefined, member.cookie),
        { params: Promise.resolve({ organizationId }) },
      );
      assert.equal(notificationsBefore.status, 200);
      const notificationsBeforeBody = (await notificationsBefore.json()) as {
        data: { notifications: Array<{ event_type: string; target_id: string }>; unreadCount: number };
      };
      assert.ok(
        notificationsBeforeBody.data.notifications.some(
          (item) => item.event_type === "task_assigned" && item.target_id === taskId,
        ),
      );
      assert.ok(notificationsBeforeBody.data.unreadCount >= 1);

      const searchBefore = await withTrustedClientIp((headerName) =>
        searchOrganization(
          apiRequest(
            `/api/organizations/${organizationId}/search?q=Vanishing%20project%20marker&type=project`,
            "GET",
            undefined,
            owner.cookie,
            { [headerName]: "203.0.113.12" },
          ),
          { params: Promise.resolve({ organizationId }) },
        ),
      );
      assert.equal(searchBefore.status, 200);
      const searchBeforeBody = (await searchBefore.json()) as {
        data: { results: Array<{ id: string }>; pagination: { total: number } };
      };
      assert.ok(searchBeforeBody.data.results.some((item) => item.id === project.id));

      const memberSearchBefore = await withTrustedClientIp((headerName) =>
        searchOrganization(
          apiRequest(
            `/api/organizations/${organizationId}/search?q=Vanishing%20Member&type=member&projectId=${project.id}`,
            "GET",
            undefined,
            owner.cookie,
            { [headerName]: "203.0.113.12" },
          ),
          { params: Promise.resolve({ organizationId }) },
        ),
      );
      assert.equal(memberSearchBefore.status, 200);
      const memberSearchBeforeBody = (await memberSearchBefore.json()) as {
        data: { results: Array<{ id: string }>; pagination: { total: number } };
      };
      assert.ok(memberSearchBeforeBody.data.results.some((item) => item.id === member.userId));

      const deleted = await deleteProjectAs(owner.cookie, organizationId, project.id, project.version);
      assert.equal(deleted.status, 200);

      const listedAfter = await listProjects(
        apiRequest(`/api/organizations/${organizationId}/projects`, "GET", undefined, owner.cookie),
        { params: Promise.resolve({ organizationId }) },
      );
      assert.equal(listedAfter.status, 200);
      const listedAfterBody = (await listedAfter.json()) as {
        data: { projects: Array<{ id: string }> };
      };
      assert.ok(!listedAfterBody.data.projects.some((item) => item.id === project.id));

      const milestonesAfter = await listMilestones(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${project.id}/milestones`,
          "GET",
          undefined,
          owner.cookie,
        ),
        projectParams,
      );
      assert.equal(milestonesAfter.status, 404);

      const tasksAfter = await listTasks(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${project.id}/tasks`,
          "GET",
          undefined,
          owner.cookie,
        ),
        projectParams,
      );
      assert.equal(tasksAfter.status, 404);

      const commentsAfter = await listTaskComments(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${project.id}/tasks/${taskId}/comments`,
          "GET",
          undefined,
          owner.cookie,
        ),
        { params: Promise.resolve({ organizationId, projectId: project.id, taskId }) },
      );
      assert.equal(commentsAfter.status, 404);

      const filesAfter = await listTaskFiles(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${project.id}/tasks/${taskId}/files`,
          "GET",
          undefined,
          owner.cookie,
        ),
        { params: Promise.resolve({ organizationId, projectId: project.id, taskId }) },
      );
      assert.equal(filesAfter.status, 404);

      const linkAfter = await getTaskFile(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${project.id}/tasks/${taskId}/files/${fileId}`,
          "GET",
          undefined,
          owner.cookie,
        ),
        { params: Promise.resolve({ organizationId, projectId: project.id, taskId, fileId }) },
      );
      assert.equal(linkAfter.status, 404);

      const signedAfter = await getTaskFile(
        apiRequest(signedUrl, "GET"),
        { params: Promise.resolve({ organizationId, projectId: project.id, taskId, fileId }) },
      );
      assert.equal(signedAfter.status, 404);

      const activityAfter = await getProjectActivity(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${project.id}/activity`,
          "GET",
          undefined,
          owner.cookie,
        ),
        projectParams,
      );
      assert.equal(activityAfter.status, 404);

      const analyticsAfter = await getProjectAnalytics(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${project.id}/analytics`,
          "GET",
          undefined,
          owner.cookie,
        ),
        projectParams,
      );
      assert.equal(analyticsAfter.status, 404);

      for (const [entityType, query] of [
        ["project", "Vanishing%20project%20marker"],
        ["task", "Vanishing%20task%20marker"],
        ["comment", "Vanishing%20comment%20marker"],
        ["file", "vanishing-notes"],
      ] as const) {
        const searched = await withTrustedClientIp((headerName) =>
          searchOrganization(
            apiRequest(
              `/api/organizations/${organizationId}/search?${new URLSearchParams({ q: decodeURIComponent(query), type: entityType, projectId: project.id })}`,
              "GET",
              undefined,
              owner.cookie,
              { [headerName]: "203.0.113.12" },
            ),
            { params: Promise.resolve({ organizationId }) },
          ),
        );
        assert.equal(searched.status, 200, `search ${entityType} after delete`);
        const searchedBody = (await searched.json()) as {
          data: { results: Array<unknown>; pagination: { total: number } };
        };
        assert.equal(searchedBody.data.pagination.total, 0, `search ${entityType} after delete`);
        assert.deepEqual(searchedBody.data.results, []);
      }

      const notificationsAfter = await listNotifications(
        apiRequest(`/api/organizations/${organizationId}/notifications`, "GET", undefined, member.cookie),
        { params: Promise.resolve({ organizationId }) },
      );
      assert.equal(notificationsAfter.status, 200);
      const notificationsAfterBody = (await notificationsAfter.json()) as {
        data: { notifications: Array<{ target_id: string }>; unreadCount: number };
      };
      assert.ok(!notificationsAfterBody.data.notifications.some((item) => item.target_id === taskId));
      assert.equal(notificationsAfterBody.data.unreadCount, 0);

      // Project-scoped member search is empty after deletion, while
      // org-wide member search still finds the member: the member row
      // itself is untouched by the project deletion.
      const memberSearchAfter = await withTrustedClientIp((headerName) =>
        searchOrganization(
          apiRequest(
            `/api/organizations/${organizationId}/search?q=Vanishing%20Member&type=member&projectId=${project.id}`,
            "GET",
            undefined,
            owner.cookie,
            { [headerName]: "203.0.113.12" },
          ),
          { params: Promise.resolve({ organizationId }) },
        ),
      );
      assert.equal(memberSearchAfter.status, 200);
      const memberSearchAfterBody = (await memberSearchAfter.json()) as {
        data: { results: Array<unknown>; pagination: { total: number } };
      };
      assert.equal(memberSearchAfterBody.data.pagination.total, 0);
      assert.deepEqual(memberSearchAfterBody.data.results, []);

      const memberSearchOrgWide = await withTrustedClientIp((headerName) =>
        searchOrganization(
          apiRequest(
            `/api/organizations/${organizationId}/search?q=Vanishing%20Member&type=member`,
            "GET",
            undefined,
            owner.cookie,
            { [headerName]: "203.0.113.12" },
          ),
          { params: Promise.resolve({ organizationId }) },
        ),
      );
      assert.equal(memberSearchOrgWide.status, 200);
      const memberSearchOrgWideBody = (await memberSearchOrgWide.json()) as {
        data: { results: Array<{ id: string }> };
      };
      assert.ok(memberSearchOrgWideBody.data.results.some((item) => item.id === member.userId));
    });

    await t.test("cross-tenant deletion attempts do not leak existence", async () => {
      const project = await createProjectAs(owner.cookie, organizationId, "Tenant isolated project");
      const otherOwner = await registerVerifyAndLogin(
        `${randomUUID()}@example.test`,
        "Other Tenant Owner",
        "other tenant owner password",
      );
      const otherOrganizationId = await createWorkspace(otherOwner.cookie, `other-${otherOwner.userId.slice(0, 8)}`);

      const crossTenant = await deleteProjectAs(otherOwner.cookie, otherOrganizationId, project.id, project.version);
      assert.equal(crossTenant.status, 404);
      const crossTenantBody = (await crossTenant.json()) as { error: { code: string } };
      assert.equal(crossTenantBody.error.code, "PROJECT_NOT_FOUND");

      const stillThere = await getProject(
        apiRequest(`/api/organizations/${organizationId}/projects/${project.id}`, "GET", undefined, owner.cookie),
        { params: Promise.resolve({ organizationId, projectId: project.id }) },
      );
      assert.equal(stillThere.status, 200);
    });

    await t.test("delete validation rejects bad versions and identifiers", async () => {
      const project = await createProjectAs(owner.cookie, organizationId, "Validation project");

      const missingVersion = await deleteProject(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${project.id}`,
          "DELETE",
          {},
          owner.cookie,
        ),
        { params: Promise.resolve({ organizationId, projectId: project.id }) },
      );
      assert.equal(missingVersion.status, 400);

      const zeroVersion = await deleteProjectAs(owner.cookie, organizationId, project.id, 0);
      assert.equal(zeroVersion.status, 400);

      const badProjectId = await deleteProjectAs(owner.cookie, organizationId, "not-a-uuid", project.version);
      assert.equal(badProjectId.status, 400);

      const badOrganizationId = await deleteProjectAs(owner.cookie, "not-a-uuid", project.id, project.version);
      // The route validates only the project identifier format; a malformed
      // organization identifier is rejected by the tenant context as an
      // access denial, exactly as PATCH behaves.
      assert.equal(badOrganizationId.status, 403);
    });

    await t.test(
      "purge removes expired projects and their data but keeps audit events",
      { skip: !migratorConnectionString },
      async () => {
        const project = await createProjectAs(owner.cookie, organizationId, "Purge boundary project");

        const memberEmail = `${randomUUID()}@example.test`;
        const memberToken = await inviteToOrganization(owner.cookie, organizationId, memberEmail, "member");
        const member = await registerVerifyAndLogin(memberEmail, "Purge Member", "purge member password");
        assert.equal(
          (await acceptInvitation(
            apiRequest("/api/invitations/accept", "POST", { token: memberToken }, member.cookie),
          )).status,
          200,
        );
        assert.equal(
          (await addProjectMember(
            apiRequest(
              `/api/organizations/${organizationId}/projects/${project.id}/members`,
              "POST",
              { userId: member.userId, role: "member" },
              owner.cookie,
            ),
            { params: Promise.resolve({ organizationId, projectId: project.id }) },
          )).status,
          201,
        );

        const projectParams = { params: Promise.resolve({ organizationId, projectId: project.id }) };
        const milestoneResponse = await createMilestone(
          apiRequest(
            `/api/organizations/${organizationId}/projects/${project.id}/milestones`,
            "POST",
            { name: "Purge milestone" },
            owner.cookie,
            { "idempotency-key": `purge-milestone-${project.id}` },
          ),
          projectParams,
        );
        assert.equal(milestoneResponse.status, 201);
        const milestoneBody = (await milestoneResponse.json()) as {
          data: { milestone: { id: string } };
        };
        const milestone1Id = milestoneBody.data.milestone.id;
        const milestone2Response = await createMilestone(
          apiRequest(
            `/api/organizations/${organizationId}/projects/${project.id}/milestones`,
            "POST",
            { name: "Purge milestone 2" },
            owner.cookie,
            { "idempotency-key": `purge-milestone-2-${project.id}` },
          ),
          projectParams,
        );
        assert.equal(milestone2Response.status, 201);
        const milestone2Body = (await milestone2Response.json()) as {
          data: { milestone: { id: string } };
        };
        const milestone2Id = milestone2Body.data.milestone.id;
        const taskResponse = await createTask(
          apiRequest(
            `/api/organizations/${organizationId}/projects/${project.id}/tasks`,
            "POST",
            { title: "Purge task", assigneeId: member.userId },
            owner.cookie,
            { "idempotency-key": `purge-task-${project.id}` },
          ),
          projectParams,
        );
        assert.equal(taskResponse.status, 201);
        const taskBody = (await taskResponse.json()) as { data: { task: { id: string } } };
        const taskId = taskBody.data.task.id;
        assert.equal(
          (await createTaskComment(
            apiRequest(
              `/api/organizations/${organizationId}/projects/${project.id}/tasks/${taskId}/comments`,
              "POST",
              { body: "Purge comment" },
              owner.cookie,
              { "idempotency-key": `purge-comment-${project.id}` },
            ),
            { params: Promise.resolve({ organizationId, projectId: project.id, taskId }) },
          )).status,
          201,
        );
        const fileResponse = await uploadTaskFile(
          privateFileRequest(
            `/api/organizations/${organizationId}/projects/${project.id}/tasks/${taskId}/files`,
            "POST",
            Buffer.from("purge file bytes\n", "utf8"),
            "purge-notes.txt",
            owner.cookie,
            { "idempotency-key": `purge-file-${project.id}` },
          ),
          { params: Promise.resolve({ organizationId, projectId: project.id, taskId }) },
        );
        assert.equal(fileResponse.status, 201);

        // A two-level task hierarchy (the deepest the application allows:
        // subtasks must hang off an active top-level task) plus one task
        // dependency and one milestone dependency. Dependency rows have
        // no API route, so they are inserted through the tenant context
        // like the graph-lock call below; the dependency triggers
        // require that context for the graph lock.
        const parentTaskResponse = await createTask(
          apiRequest(
            `/api/organizations/${organizationId}/projects/${project.id}/tasks`,
            "POST",
            { title: "Purge parent task" },
            owner.cookie,
            { "idempotency-key": `purge-parent-task-${project.id}` },
          ),
          projectParams,
        );
        assert.equal(parentTaskResponse.status, 201);
        const parentTaskBody = (await parentTaskResponse.json()) as {
          data: { task: { id: string } };
        };
        const parentTaskId = parentTaskBody.data.task.id;
        const childTaskResponse = await createTask(
          apiRequest(
            `/api/organizations/${organizationId}/projects/${project.id}/tasks`,
            "POST",
            { title: "Purge child task", parentTaskId, assigneeId: member.userId },
            owner.cookie,
            { "idempotency-key": `purge-child-task-${project.id}` },
          ),
          projectParams,
        );
        assert.equal(childTaskResponse.status, 201);
        await withOrganizationContext(owner.userId, organizationId, async (client) => {
          await client.query(
            "INSERT INTO nexora.task_dependencies (organization_id, project_id, task_id, depends_on_task_id) VALUES ($1, $2, $3, $4)",
            [organizationId, project.id, taskId, parentTaskId],
          );
          await client.query(
            "INSERT INTO nexora.milestone_dependencies (organization_id, project_id, milestone_id, depends_on_milestone_id) VALUES ($1, $2, $3, $4)",
            [organizationId, project.id, milestone2Id, milestone1Id],
          );
        });

        // A graph lock row, as created by graph writes, must cascade away
        // with the project. The lock function is SECURITY DEFINER and
        // granted to the runtime role, so the app-role context can create it.
        await withOrganizationContext(owner.userId, organizationId, async (client) => {
          await client.query("SELECT nexora.lock_project_dependency_graph($1, $2, 'milestone')", [
            organizationId,
            project.id,
          ]);
        });
        // Two lock rows: task creation acquires the task graph lock, and
        // the explicit call above acquires the milestone graph lock. Both
        // must cascade away with the project.
        const locksBefore = await migratorQuery<{ count: string }>(
          "SELECT count(*)::text AS count FROM nexora.project_dependency_graph_locks WHERE project_id = $1",
          [project.id],
        );
        assert.equal(locksBefore[0]?.count, "2");

        const fileKeyRows = await migratorQuery<{ storage_key: string }>(
          "SELECT storage_key FROM nexora.task_files WHERE project_id = $1",
          [project.id],
        );
        assert.equal(fileKeyRows.length, 1);
        const fileKey = fileKeyRows[0]?.storage_key;
        assert.ok(fileKey);

        const deleted = await deleteProjectAs(owner.cookie, organizationId, project.id, project.version);
        assert.equal(deleted.status, 200);

        const auditBefore = await migratorQuery<{ action: string }>(
          "SELECT action FROM nexora.audit_events WHERE target_id = $1 ORDER BY action",
          [project.id],
        );
        assert.deepEqual(
          auditBefore.map((row) => row.action),
          ["project.created", "project.deleted"],
        );

        // Notifications for this project exist before the purge (counted
        // with a recipient context, since FORCE row-level security hides
        // them from plain owner queries). After the purge they are gone by
        // construction: the CASCADE foreign key removes them atomically
        // with the project row, so a post-purge count would be zero either
        // way and is not asserted as proof.
        const notificationsBeforePurge = await migratorQueryAs<{ count: string }>(
          member.userId,
          organizationId,
          "SELECT count(*)::text AS count FROM nexora.notifications WHERE project_id = $1",
          [project.id],
        );
        assert.ok(Number(notificationsBeforePurge[0]?.count) >= 1);

        await migratorQuery(
          "UPDATE nexora.projects SET deleted_at = pg_catalog.now() - interval '31 days' WHERE id = $1",
          [project.id],
        );

        // A project deleted 29 days ago is inside retention and must survive.
        const keeper = await createProjectAs(owner.cookie, organizationId, "Retention keeper project");
        assert.equal(
          (await addProjectMember(
            apiRequest(
              `/api/organizations/${organizationId}/projects/${keeper.id}/members`,
              "POST",
              { userId: member.userId, role: "member" },
              owner.cookie,
            ),
            { params: Promise.resolve({ organizationId, projectId: keeper.id }) },
          )).status,
          201,
        );
        const keeperTaskResponse = await createTask(
          apiRequest(
            `/api/organizations/${organizationId}/projects/${keeper.id}/tasks`,
            "POST",
            { title: "Keeper task", assigneeId: member.userId },
            owner.cookie,
            { "idempotency-key": `keeper-task-${keeper.id}` },
          ),
          { params: Promise.resolve({ organizationId, projectId: keeper.id }) },
        );
        assert.equal(keeperTaskResponse.status, 201);
        const keeperDeleted = await deleteProjectAs(owner.cookie, organizationId, keeper.id, keeper.version);
        assert.equal(keeperDeleted.status, 200);
        await migratorQuery(
          "UPDATE nexora.projects SET deleted_at = pg_catalog.now() - interval '29 days' WHERE id = $1",
          [keeper.id],
        );

        // Pre-purge counts make the post-purge zeros meaningful: each of
        // these tables provably holds rows for this project before the purge.
        for (const table of [
          "task_dependencies",
          "milestone_dependencies",
          "project_task_statuses",
          "project_mutation_idempotency",
        ] as const) {
          const rows = await migratorQuery<{ count: string }>(
            `SELECT count(*)::text AS count FROM nexora.${table} WHERE project_id = $1`,
            [project.id],
          );
          assert.ok(Number(rows[0]?.count) >= 1, `${table} rows before purge`);
        }
        // Catalog evidence that the notification cascade is actually in
        // force on this database, not just asserted in migration text:
        // confdeltype 'c' is ON DELETE CASCADE.
        const fkRows = await migratorQuery<{ confdeltype: string }>(
          "SELECT confdeltype FROM pg_catalog.pg_constraint WHERE conname = 'notifications_project_fk'",
        );
        assert.equal(fkRows[0]?.confdeltype, "c");

        // The purge runs through the runtime (app) connection: if the
        // EXECUTE grant were missing, this call would fail with 42501.
        // The purge removes every expired project in the database, so the
        // returned keys include this fixture's file key plus any leftovers
        // from earlier runs; assert inclusion, not exact equality.
        const purgedKeys = await appQuery<{ storage_key: string }>(
          "SELECT storage_key FROM nexora.purge_expired_projects()",
        );
        assert.ok(
          purgedKeys.some((row) => row.storage_key === fileKey),
          "purge returns this fixture's file key",
        );

        const projectAfter = await migratorQuery<{ id: string }>(
          "SELECT id FROM nexora.projects WHERE id = $1",
          [project.id],
        );
        assert.equal(projectAfter.length, 0);
        const keeperAfter = await migratorQuery<{ id: string }>(
          "SELECT id FROM nexora.projects WHERE id = $1",
          [keeper.id],
        );
        assert.equal(keeperAfter.length, 1);

        for (const [table, column] of [
          ["tasks", "project_id"],
          ["milestones", "project_id"],
          ["task_comments", "project_id"],
          ["project_memberships", "project_id"],
          ["task_files", "project_id"],
          ["task_dependencies", "project_id"],
          ["milestone_dependencies", "project_id"],
          ["project_task_statuses", "project_id"],
          ["project_mutation_idempotency", "project_id"],
        ] as const) {
          const rows = await migratorQuery<{ count: string }>(
            `SELECT count(*)::text AS count FROM nexora.${table} WHERE ${column} = $1`,
            [project.id],
          );
          assert.equal(rows[0]?.count, "0", `${table} rows for purged project`);
        }
        // Notifications are not counted here: with the project row gone,
        // the recipient-scoped SELECT policy filters them regardless, so a
        // zero count would prove nothing. Their removal follows from the
        // CASCADE foreign key plus the project row being gone (asserted
        // above) and the pre-purge count (asserted before the purge).
        const locksAfter = await migratorQuery<{ count: string }>(
          "SELECT count(*)::text AS count FROM nexora.project_dependency_graph_locks WHERE project_id = $1",
          [project.id],
        );
        assert.equal(locksAfter[0]?.count, "0");
        const keeperTasks = await migratorQuery<{ count: string }>(
          "SELECT count(*)::text AS count FROM nexora.tasks WHERE project_id = $1",
          [keeper.id],
        );
        assert.equal(keeperTasks[0]?.count, "1");
        const keeperNotifications = await migratorQueryAs<{ count: string }>(
          member.userId,
          organizationId,
          "SELECT count(*)::text AS count FROM nexora.notifications WHERE project_id = $1",
          [keeper.id],
        );
        assert.ok(Number(keeperNotifications[0]?.count) >= 1);

        // Audit events survive the purge indefinitely, by design: the
        // audit table has no project foreign key.
        const auditAfter = await migratorQuery<{ action: string }>(
          "SELECT action FROM nexora.audit_events WHERE target_id = $1 ORDER BY action",
          [project.id],
        );
        assert.deepEqual(
          auditAfter.map((row) => row.action),
          ["project.created", "project.deleted"],
        );

        // Post-purge recipient-context notification count is zero. On its
        // own this proves nothing -- the recipient SELECT policy filters
        // rows whose project is gone regardless -- but combined with the
        // pre-purge count (>= 1), the project row being gone, and the
        // catalog CASCADE check above, it is consistent with the cascade
        // having removed them.
        const notificationsAfterPurge = await migratorQueryAs<{ count: string }>(
          member.userId,
          organizationId,
          "SELECT count(*)::text AS count FROM nexora.notifications WHERE project_id = $1",
          [project.id],
        );
        assert.equal(notificationsAfterPurge[0]?.count, "0");

        // Through the API, the purged project is gone and the retained
        // (but deleted) keeper is still invisible.
        const listedAfter = await listProjects(
          apiRequest(`/api/organizations/${organizationId}/projects`, "GET", undefined, owner.cookie),
          { params: Promise.resolve({ organizationId }) },
        );
        const listedAfterBody = (await listedAfter.json()) as {
          data: { projects: Array<{ id: string }> };
        };
        assert.ok(!listedAfterBody.data.projects.some((item) => item.id === project.id));
        assert.ok(!listedAfterBody.data.projects.some((item) => item.id === keeper.id));
      },
    );

    await t.test(
      "cleanup --dry-run reports without deleting, and the real run purges",
      { skip: !migratorConnectionString },
      async () => {
        const project = await createProjectAs(owner.cookie, organizationId, "Script purge project");
        const projectParams = { params: Promise.resolve({ organizationId, projectId: project.id }) };
        const taskResponse = await createTask(
          apiRequest(
            `/api/organizations/${organizationId}/projects/${project.id}/tasks`,
            "POST",
            { title: "Script purge task" },
            owner.cookie,
            { "idempotency-key": `script-task-${project.id}` },
          ),
          projectParams,
        );
        assert.equal(taskResponse.status, 201);
        const taskBody = (await taskResponse.json()) as { data: { task: { id: string } } };
        const taskId = taskBody.data.task.id;
        const fileResponse = await uploadTaskFile(
          privateFileRequest(
            `/api/organizations/${organizationId}/projects/${project.id}/tasks/${taskId}/files`,
            "POST",
            Buffer.from("script purge file bytes\n", "utf8"),
            "script-purge-notes.txt",
            owner.cookie,
            { "idempotency-key": `script-file-${project.id}` },
          ),
          { params: Promise.resolve({ organizationId, projectId: project.id, taskId }) },
        );
        assert.equal(fileResponse.status, 201);

        const fileKeyRows = await migratorQuery<{ storage_key: string }>(
          "SELECT storage_key FROM nexora.task_files WHERE project_id = $1",
          [project.id],
        );
        assert.equal(fileKeyRows.length, 1);
        const fileKey = fileKeyRows[0]?.storage_key;
        assert.ok(fileKey);
        assert.ok(privateFilesRoot);
        assert.equal(await diskContainsKey(privateFilesRoot, fileKey), true);

        const deleted = await deleteProjectAs(owner.cookie, organizationId, project.id, project.version);
        assert.equal(deleted.status, 200);
        await migratorQuery(
          "UPDATE nexora.projects SET deleted_at = pg_catalog.now() - interval '31 days' WHERE id = $1",
          [project.id],
        );

        const repoRoot = fileURLToPath(new URL("../", import.meta.url));
        const scriptArgs = [
          "--import=./scripts/load-env.mjs",
          "--conditions=react-server",
          "--experimental-strip-types",
          "scripts/cleanup-task-files.mjs",
        ];
        const scriptEnv = {
          ...process.env,
          DATABASE_URL: connectionString ?? "",
          NEXORA_PRIVATE_FILE_DIR: privateFilesRoot,
        };

        const dryRun = await execFileAsync(process.execPath, [...scriptArgs, "--dry-run"], {
          cwd: repoRoot,
          env: scriptEnv,
        });
        // The dry run lists every expired project in the database, which
        // may include leftovers from earlier runs; assert this fixture is
        // reported and remember the count for the real run below. The
        // line leads with expired organizations since migration 0033
        // (organization purge runs first), so the project count is
        // matched where it now appears in the line.
        const dryRunCount = Number(dryRun.stdout.match(/(\d+) expired project\(s\)/)?.[1]);
        assert.ok(Number.isInteger(dryRunCount) && dryRunCount >= 1);
        assert.ok(dryRun.stdout.includes(project.id));
        const afterDryRun = await migratorQuery<{ id: string }>(
          "SELECT id FROM nexora.projects WHERE id = $1",
          [project.id],
        );
        assert.equal(afterDryRun.length, 1);
        assert.equal(await diskContainsKey(privateFilesRoot, fileKey), true);

        const realRun = await execFileAsync(process.execPath, scriptArgs, {
          cwd: repoRoot,
          env: scriptEnv,
        });
        assert.match(realRun.stdout, new RegExp(`Project cleanup removed ${dryRunCount} expired project`));
        const afterRealRun = await migratorQuery<{ id: string }>(
          "SELECT id FROM nexora.projects WHERE id = $1",
          [project.id],
        );
        assert.equal(afterRealRun.length, 0);
        assert.equal(await diskContainsKey(privateFilesRoot, fileKey), false);
      },
    );
  },
);
