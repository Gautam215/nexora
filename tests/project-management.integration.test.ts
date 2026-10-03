import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
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
  GET as getProject,
  PATCH as updateProject,
} from "../src/app/api/organizations/[organizationId]/projects/[projectId]/route.ts";
import { GET as searchOrganization } from "../src/app/api/organizations/[organizationId]/search/route.ts";
import { POST as addProjectMember } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/members/route.ts";
import { PATCH as updateProjectMember } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/members/[userId]/route.ts";
import {
  GET as listMilestones,
  POST as createMilestone,
} from "../src/app/api/organizations/[organizationId]/projects/[projectId]/milestones/route.ts";
import { PATCH as updateMilestone } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/milestones/[milestoneId]/route.ts";
import {
  GET as listTasks,
  POST as createTask,
} from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/route.ts";
import {
  DELETE as archiveTask,
  GET as getTask,
  PATCH as updateTask,
} from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/[taskId]/route.ts";
import {
  GET as listTaskComments,
  POST as createTaskComment,
} from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/[taskId]/comments/route.ts";
import {
  GET as listTaskFiles,
  POST as uploadTaskFile,
} from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/[taskId]/files/route.ts";
import {
  DELETE as deleteTaskFile,
  GET as getTaskFile,
  PUT as replaceTaskFile,
} from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/[taskId]/files/[fileId]/route.ts";
import { GET as getProjectActivity } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/activity/route.ts";
import { GET as getProjectAnalytics } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/analytics/route.ts";
import { GET as listNotifications } from "../src/app/api/organizations/[organizationId]/notifications/route.ts";
import {
  GET as getNotificationPreferences,
  PATCH as updateNotificationPreferences,
} from "../src/app/api/organizations/[organizationId]/notifications/preferences/route.ts";
import { PATCH as updateNotification } from "../src/app/api/organizations/[organizationId]/notifications/[notificationId]/route.ts";
import { closeDatabasePool, withOrganizationContext } from "../src/server/db.ts";
import { startSmtpCaptureServer, type SmtpCapture } from "./smtp-server.ts";

const connectionString = process.env.NEXORA_TEST_DATABASE_URL;
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

after(async () => {
  await smtp?.close();
  await closeDatabasePool();
  if (privateFilesRoot) await rm(privateFilesRoot, { recursive: true, force: true });
  if (previousPrivateFileDirectory === undefined) delete process.env.NEXORA_PRIVATE_FILE_DIR;
  else process.env.NEXORA_PRIVATE_FILE_DIR = previousPrivateFileDirectory;
  if (previousFileSigningKey === undefined) delete process.env.NEXORA_FILE_SIGNING_KEY;
  else process.env.NEXORA_FILE_SIGNING_KEY = previousFileSigningKey;
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
  const token = decoded.match(new RegExp(`${pathname}\\?token=([A-Za-z0-9_-]{43})`))?.[1];
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
    apiRequest("/api/organizations", "POST", { name: "Project Workspace", slug }, cookie),
  );
  assert.equal(response.status, 201);
  const result = (await response.json()) as { data: { organization: { id: string } } };
  return result.data.organization.id;
}

test(
  "projects enforce explicit membership, manager authority, state transitions, and optimistic versions",
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
    privateFilesRoot = await mkdtemp(path.join(os.tmpdir(), "nexora-task-files-"));
    process.env.NEXORA_PRIVATE_FILE_DIR = privateFilesRoot;
    process.env.NEXORA_FILE_SIGNING_KEY = randomBytes(32).toString("hex");

    const owner = await registerVerifyAndLogin(
      `${randomUUID()}@example.test`,
      "Project Owner",
      "project owner password",
    );
    const organizationId = await createWorkspace(owner.cookie, `projects-${owner.userId.slice(0, 8)}`);
    const invitedEmail = `${randomUUID()}@example.test`;
    const organizationInvite = await createOrganizationInvitation(
      apiRequest(
        `/api/organizations/${organizationId}/members`,
        "POST",
        { email: invitedEmail, role: "member" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(organizationInvite.status, 201);
    const organizationInviteToken = tokenFromMessage(
      smtp.messages.at(-1) ?? "",
      "/accept-invitation",
    );
    const member = await registerVerifyAndLogin(
      invitedEmail,
      "Project Teammate",
      "project member password",
    );
    const accepted = await acceptInvitation(
      apiRequest("/api/invitations/accept", "POST", { token: organizationInviteToken }, member.cookie),
    );
    assert.equal(accepted.status, 200);

    const created = await createProject(
      apiRequest(
        `/api/organizations/${organizationId}/projects`,
        "POST",
        {
          name: "Quarterly release",
          description: "Coordinate the next production release.",
          startDate: "2026-10-01",
          targetDate: "2026-12-15",
        },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as {
      data: { project: { id: string; status: string; owner_user_id: string; version: number } };
    };
    const projectId = createdBody.data.project.id;
    const ownerSearch = await withTrustedClientIp((headerName) =>
      searchOrganization(
        apiRequest(
          `/api/organizations/${organizationId}/search?q=Quarterly&type=project`,
          "GET",
          undefined,
          owner.cookie,
          { [headerName]: "203.0.113.10" },
        ),
        { params: Promise.resolve({ organizationId }) },
      ),
    );
    assert.equal(ownerSearch.status, 200, await ownerSearch.clone().text());
    const ownerSearchBody = (await ownerSearch.json()) as {
      data: { results: Array<{ entity_type: string; id: string; title: string }>; pagination: { total: number } };
    };
    assert.equal(ownerSearchBody.data.pagination.total, 1);
    assert.equal(ownerSearchBody.data.results[0]?.entity_type, "project");
    assert.equal(ownerSearchBody.data.results[0]?.id, projectId);

    const hiddenProjectSearch = await searchOrganization(
      apiRequest(
        `/api/organizations/${organizationId}/search?q=Quarterly&type=project`,
        "GET",
        undefined,
        member.cookie,
      ),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(hiddenProjectSearch.status, 200);
    const hiddenProjectSearchBody = (await hiddenProjectSearch.json()) as {
      data: { results: Array<{ id: string }>; pagination: { total: number } };
    };
    assert.equal(hiddenProjectSearchBody.data.pagination.total, 0);
    assert.deepEqual(hiddenProjectSearchBody.data.results, []);

    const projectParams = { params: Promise.resolve({ organizationId, projectId }) };
    const milestoneCollectionPath = `/api/organizations/${organizationId}/projects/${projectId}/milestones`;
    const taskCollectionPath = `/api/organizations/${organizationId}/projects/${projectId}/tasks`;
    let memberTaskId = "";
    const searchProjectEntity = (
      cookie: string,
      query: string,
      type: "task" | "comment" | "member" | "file",
    ) => withTrustedClientIp((headerName) =>
      searchOrganization(
        apiRequest(
          `/api/organizations/${organizationId}/search?${new URLSearchParams({ q: query, type, projectId })}`,
          "GET",
          undefined,
          cookie,
          { [headerName]: "203.0.113.12" },
        ),
        { params: Promise.resolve({ organizationId }) },
      ),
    );
    const searchWorkspaceAll = (cookie: string) => withTrustedClientIp((headerName) =>
      searchOrganization(
        apiRequest(
          `/api/organizations/${organizationId}/search?q=Search`,
          "GET",
          undefined,
          cookie,
          { [headerName]: "203.0.113.14" },
        ),
        { params: Promise.resolve({ organizationId }) },
      ),
    );

    const searchFixtureTaskResponse = await createTask(
      apiRequest(
        taskCollectionPath,
        "POST",
          { title: "Search Task Marker" },
        owner.cookie,
        { "idempotency-key": "search-visibility-task-001" },
      ),
      projectParams,
    );
    assert.equal(searchFixtureTaskResponse.status, 201, await searchFixtureTaskResponse.clone().text());
    const searchFixtureTaskBody = (await searchFixtureTaskResponse.json()) as {
      data: { task: { id: string } };
    };
    const searchFixtureTaskId = searchFixtureTaskBody.data.task.id;
    const searchFixtureTaskParams = {
      params: Promise.resolve({ organizationId, projectId, taskId: searchFixtureTaskId }),
    };
    const searchFixtureFileResponse = await withTrustedClientIp((headerName) =>
      uploadTaskFile(
        privateFileRequest(
          `${taskCollectionPath}/${searchFixtureTaskId}/files`,
          "POST",
          Buffer.from("Search visibility fixture\n", "utf8"),
          "Search File Marker.txt",
          owner.cookie,
          { "idempotency-key": "search-visibility-file-001", [headerName]: "203.0.113.13" },
        ),
        searchFixtureTaskParams,
      ),
    );
    assert.equal(searchFixtureFileResponse.status, 201, await searchFixtureFileResponse.clone().text());
    const searchFixtureCommentResponse = await createTaskComment(
      apiRequest(
        `${taskCollectionPath}/${searchFixtureTaskId}/comments`,
        "POST",
        { body: "Search Comment Marker" },
        owner.cookie,
        { "idempotency-key": "search-visibility-comment-001" },
      ),
      searchFixtureTaskParams,
    );
    assert.equal(searchFixtureCommentResponse.status, 201, await searchFixtureCommentResponse.clone().text());

    const searchVisibilityCases = [
      ["task", "Search"],
      ["comment", "Search"],
      ["file", "Search"],
      ["member", "Teammate"],
    ] as const;
    const hiddenAllSearch = await searchWorkspaceAll(member.cookie);
    assert.equal(hiddenAllSearch.status, 200, await hiddenAllSearch.clone().text());
    assert.deepEqual(
      ((await hiddenAllSearch.json()) as { data: { results: unknown[] } }).data.results,
      [],
      "unfiltered all-type search must not expose inaccessible project results",
    );
    for (const [type, query] of searchVisibilityCases) {
      const hiddenSearch = await searchProjectEntity(member.cookie, query, type);
      assert.equal(hiddenSearch.status, 200, await hiddenSearch.clone().text());
      const hiddenSearchBody = (await hiddenSearch.json()) as {
        data: { results: Array<{ id: string }>; pagination: { total: number } };
      };
      assert.equal(hiddenSearchBody.data.pagination.total, 0, `unassigned member must not find ${type} results`);
      assert.deepEqual(hiddenSearchBody.data.results, []);
    }

    assert.equal(createdBody.data.project.status, "planned");
    assert.equal(createdBody.data.project.owner_user_id, owner.userId);
    assert.equal(createdBody.data.project.version, 1);

    const firstPage = await listProjects(
      apiRequest(`/api/organizations/${organizationId}/projects?limit=1&offset=0`, "GET", undefined, owner.cookie),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(firstPage.status, 200);
    const firstPageBody = (await firstPage.json()) as {
      data: { projects: Array<{ id: string; can_manage: boolean }>; pagination: { limit: number; hasMore: boolean } };
    };
    assert.equal(firstPageBody.data.projects[0]?.id, projectId);
    assert.equal(firstPageBody.data.projects[0]?.can_manage, true);
    assert.equal(firstPageBody.data.pagination.limit, 1);
    assert.equal(firstPageBody.data.pagination.hasMore, false);
    const invalidPage = await listProjects(
      apiRequest(`/api/organizations/${organizationId}/projects?limit=1000`, "GET", undefined, owner.cookie),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(invalidPage.status, 400);

    const hiddenProject = await getProject(
      apiRequest(`/api/organizations/${organizationId}/projects/${projectId}`, "GET", undefined, member.cookie),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(hiddenProject.status, 404);
    const hiddenAnalytics = await getProjectAnalytics(
      apiRequest(`/api/organizations/${organizationId}/projects/${projectId}/analytics`, "GET", undefined, member.cookie),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(hiddenAnalytics.status, 404);

    const assigned = await addProjectMember(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${projectId}/members`,
        "POST",
        { userId: member.userId, role: "member" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(assigned.status, 201);
    const visibleAllSearch = await searchWorkspaceAll(member.cookie);
    assert.equal(visibleAllSearch.status, 200, await visibleAllSearch.clone().text());
    const visibleAllSearchBody = (await visibleAllSearch.json()) as {
      data: { results: Array<{ entity_type: string }> };
    };
    assert.deepEqual(
      visibleAllSearchBody.data.results.map((result) => result.entity_type).sort(),
      ["comment", "file", "task"],
      "unfiltered all-type search should combine accessible project sources",
    );
    for (const [type, query] of searchVisibilityCases) {
      const visibleSearch = await searchProjectEntity(member.cookie, query, type);
      assert.equal(visibleSearch.status, 200, await visibleSearch.clone().text());
      const visibleSearchBody = (await visibleSearch.json()) as {
        data: {
          results: Array<{ entity_type: string; id: string }>;
          pagination: { total: number };
        };
      };
      assert.equal(visibleSearchBody.data.pagination.total, 1, `project member should find ${type} result`);
      assert.equal(visibleSearchBody.data.results[0]?.entity_type, type);
      if (type === "member") {
        assert.equal(visibleSearchBody.data.results[0]?.id, member.userId);
        assert.equal(JSON.stringify(visibleSearchBody.data).includes(invitedEmail), false);
      }
    }
    const archivedSearchFixture = await archiveTask(
      apiRequest(
        `${taskCollectionPath}/${searchFixtureTaskId}`,
        "DELETE",
        { expectedVersion: 1 },
        owner.cookie,
      ),
      searchFixtureTaskParams,
    );
    assert.equal(archivedSearchFixture.status, 200, await archivedSearchFixture.clone().text());
    const visibleProject = await getProject(
      apiRequest(`/api/organizations/${organizationId}/projects/${projectId}`, "GET", undefined, member.cookie),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(visibleProject.status, 200);
    const visibleBody = (await visibleProject.json()) as {
      data: { project: { viewer_role: string; can_manage: boolean }; members: Array<{ user_id: string }> };
    };
    assert.equal(visibleBody.data.project.viewer_role, "member");
    assert.equal(visibleBody.data.project.can_manage, false);
    assert.equal(visibleBody.data.members.length, 2);

    const memberTaskResponse = await createTask(
      apiRequest(
        taskCollectionPath,
        "POST",
        { title: "Member-created task" },
        member.cookie,
        { "idempotency-key": "member-task-create-001" },
      ),
      projectParams,
    );
    assert.equal(memberTaskResponse.status, 201, await memberTaskResponse.clone().text());
    const memberTaskBody = (await memberTaskResponse.json()) as { data: { task: { id: string } } };
    memberTaskId = memberTaskBody.data.task.id;
    const memberTaskParams = { params: Promise.resolve({ organizationId, projectId, taskId: memberTaskId }) };
    const taskFilesPath = `${taskCollectionPath}/${memberTaskId}/files`;
    const fileBytesV1 = Buffer.from("Private release notes v1\n", "utf8");
    const [uploadedFileResponse, concurrentFileReplay] = await withTrustedClientIp((headerName) =>
      Promise.all(
        [0, 1].map(() =>
          uploadTaskFile(
            privateFileRequest(
              taskFilesPath,
              "POST",
              fileBytesV1,
              "release-notes.txt",
              member.cookie,
              { "idempotency-key": "member-file-upload-001", [headerName]: "203.0.113.11" },
            ),
            memberTaskParams,
          ),
        ),
      ),
    );
    assert.equal(uploadedFileResponse.status, 201, await uploadedFileResponse.clone().text());
    assert.equal(concurrentFileReplay.status, 201, await concurrentFileReplay.clone().text());
    const uploadedFileBody = (await uploadedFileResponse.json()) as {
      data: { file: { id: string; original_filename: string; version: number } };
    };
    const taskFileId = uploadedFileBody.data.file.id;
    const taskFilePath = `${taskFilesPath}/${taskFileId}`;
    const concurrentFileReplayBody = (await concurrentFileReplay.json()) as {
      data: { file: { id: string } };
    };
    assert.equal(concurrentFileReplayBody.data.file.id, taskFileId);
    assert.equal(uploadedFileBody.data.file.original_filename, "release-notes.txt");
    assert.equal(uploadedFileBody.data.file.version, 1);
    assert.equal(Object.hasOwn(uploadedFileBody.data.file, "storage_key"), false);

    const memberFileList = await listTaskFiles(
      apiRequest(taskFilesPath, "GET", undefined, member.cookie),
      memberTaskParams,
    );
    assert.equal(memberFileList.status, 200);
    const memberFileListBody = (await memberFileList.json()) as {
      data: { files: Array<{ id: string; version: number }> };
    };
    assert.deepEqual(memberFileListBody.data.files.map((file) => file.id), [taskFileId]);

    const changedUploadReplay = await uploadTaskFile(
      privateFileRequest(
        taskFilesPath,
        "POST",
        Buffer.from("different bytes for the same upload key\n", "utf8"),
        "release-notes.txt",
        member.cookie,
        { "idempotency-key": "member-file-upload-001" },
      ),
      memberTaskParams,
    );
    assert.equal(changedUploadReplay.status, 409);

    const memberDownloadLink = await getTaskFile(
      apiRequest(taskFilePath, "GET", undefined, member.cookie),
      { params: Promise.resolve({ organizationId, projectId, taskId: memberTaskId, fileId: taskFileId }) },
    );
    assert.equal(memberDownloadLink.status, 200);
    const memberDownloadLinkBody = (await memberDownloadLink.json()) as { data: { url: string } };
    const firstSignedPath = new URL(memberDownloadLinkBody.data.url, origin).pathname +
      new URL(memberDownloadLinkBody.data.url, origin).search;
    const firstDownload = await getTaskFile(
      apiRequest(firstSignedPath),
      { params: Promise.resolve({ organizationId, projectId, taskId: memberTaskId, fileId: taskFileId }) },
    );
    assert.equal(firstDownload.status, 200);
    assert.match(firstDownload.headers.get("content-disposition") ?? "", /^attachment;/);
    assert.equal(firstDownload.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(Buffer.from(await firstDownload.arrayBuffer()), fileBytesV1);

    const fileBytesV2 = Buffer.from("Private release notes v2\n", "utf8");
    const replacedFileResponse = await replaceTaskFile(
      privateFileRequest(taskFilePath, "PUT", fileBytesV2, "release-notes.txt", member.cookie, {
        "if-match": '"1"',
      }),
      { params: Promise.resolve({ organizationId, projectId, taskId: memberTaskId, fileId: taskFileId }) },
    );
    assert.equal(replacedFileResponse.status, 200, await replacedFileResponse.clone().text());
    const replacedFileBody = (await replacedFileResponse.json()) as {
      data: { file: { id: string; version: number } };
    };
    assert.equal(replacedFileBody.data.file.version, 2);
    const staleVersionDownload = await getTaskFile(
      apiRequest(firstSignedPath),
      { params: Promise.resolve({ organizationId, projectId, taskId: memberTaskId, fileId: taskFileId }) },
    );
    assert.equal(staleVersionDownload.status, 404);

    const memberComment = await createTaskComment(
      apiRequest(
        `${taskCollectionPath}/${memberTaskId}/comments`,
        "POST",
        { body: "Starting the release checklist." },
        member.cookie,
        { "idempotency-key": "member-task-comment-001" },
      ),
      memberTaskParams,
    );
    assert.equal(memberComment.status, 201, await memberComment.clone().text());
    const memberCommentBody = (await memberComment.json()) as {
      data: { comment: { id: string; body: string; author_name: string } };
    };
    assert.equal(memberCommentBody.data.comment.body, "Starting the release checklist.");
    assert.equal(memberCommentBody.data.comment.author_name, "Project Teammate");
    const commentReplay = await createTaskComment(
      apiRequest(
        `${taskCollectionPath}/${memberTaskId}/comments`,
        "POST",
        { body: "Starting the release checklist." },
        member.cookie,
        { "idempotency-key": "member-task-comment-001" },
      ),
      memberTaskParams,
    );
    assert.equal(commentReplay.status, 201);
    const replayedCommentBody = (await commentReplay.json()) as { data: { comment: { id: string } } };
    assert.equal(replayedCommentBody.data.comment.id, memberCommentBody.data.comment.id);
    const commentReplayConflict = await createTaskComment(
      apiRequest(
        `${taskCollectionPath}/${memberTaskId}/comments`,
        "POST",
        { body: "Different comment text." },
        member.cookie,
        { "idempotency-key": "member-task-comment-001" },
      ),
      memberTaskParams,
    );
    assert.equal(commentReplayConflict.status, 409);
    const unrelatedTaskId = randomUUID();
    const crossTaskReplay = await createTaskComment(
      apiRequest(
        `${taskCollectionPath}/${unrelatedTaskId}/comments`,
        "POST",
        { body: "Starting the release checklist." },
        member.cookie,
        { "idempotency-key": "member-task-comment-001" },
      ),
      { params: Promise.resolve({ organizationId, projectId, taskId: unrelatedTaskId }) },
    );
    assert.equal(crossTaskReplay.status, 409);
    const listedComments = await listTaskComments(
      apiRequest(`${taskCollectionPath}/${memberTaskId}/comments`, "GET", undefined, member.cookie),
      memberTaskParams,
    );
    assert.equal(listedComments.status, 200);
    const listedCommentBody = (await listedComments.json()) as { data: { comments: Array<{ id: string }> } };
    assert.deepEqual(listedCommentBody.data.comments.map((comment) => comment.id), [memberCommentBody.data.comment.id]);

    const unavailableMentionResponse = await createTaskComment(
      apiRequest(
        `${taskCollectionPath}/${memberTaskId}/comments`,
        "POST",
        { body: `This mention is not allowed @[${randomUUID()}].` },
        member.cookie,
        { "idempotency-key": "invalid-task-mention-001" },
      ),
      memberTaskParams,
    );
    assert.equal(unavailableMentionResponse.status, 409);

    const mentionedCommentResponse = await createTaskComment(
      apiRequest(
        `${taskCollectionPath}/${memberTaskId}/comments`,
        "POST",
        { body: `Please review this with @[${owner.userId}].` },
        member.cookie,
        { "idempotency-key": "member-task-mention-001" },
      ),
      memberTaskParams,
    );
    assert.equal(mentionedCommentResponse.status, 201, await mentionedCommentResponse.clone().text());
    const mentionedCommentBody = (await mentionedCommentResponse.json()) as {
      data: { comment: { id: string; mentions: Array<{ user_id: string; display_name: string }> } };
    };
    assert.equal(mentionedCommentBody.data.comment.mentions[0]?.user_id, owner.userId);
    assert.equal(mentionedCommentBody.data.comment.mentions[0]?.display_name, "Project Owner");

    const preferencesBeforeUpdate = await getNotificationPreferences(
      apiRequest(`/api/organizations/${organizationId}/notifications/preferences`, "GET", undefined, owner.cookie),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(preferencesBeforeUpdate.status, 200);
    const preferencesBeforeUpdateBody = (await preferencesBeforeUpdate.json()) as {
      data: { preferences: Array<{ eventType: string; inAppEnabled: boolean }> };
    };
    assert.equal(preferencesBeforeUpdateBody.data.preferences.find((item) => item.eventType === "mention")?.inAppEnabled, true);

    const ownerNotifications = await listNotifications(
      apiRequest(`/api/organizations/${organizationId}/notifications`, "GET", undefined, owner.cookie),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(ownerNotifications.status, 200);
    const ownerNotificationsBody = (await ownerNotifications.json()) as {
      data: { notifications: Array<{ id: string; event_type: string; target_id: string }> };
    };
    const mentionNotification = ownerNotificationsBody.data.notifications.find((item) => item.event_type === "mention");
    assert.ok(mentionNotification);
    assert.equal(mentionNotification.target_id, memberTaskId);
    assert.ok(ownerNotificationsBody.data.notifications.some((item) => item.event_type === "project_activity"));

    const projectActivityResponse = await getProjectActivity(
      apiRequest(`/api/organizations/${organizationId}/projects/${projectId}/activity`, "GET", undefined, owner.cookie),
      projectParams,
    );
    assert.equal(projectActivityResponse.status, 200);
    const projectActivityBody = (await projectActivityResponse.json()) as {
      data: { events: Array<{ action: string; target_id: string | null }> };
    };
    assert.ok(projectActivityBody.data.events.some((event) => event.action === "task.comment_created" && event.target_id === memberTaskId));

    const disableMentionPreference = await updateNotificationPreferences(
      apiRequest(
        `/api/organizations/${organizationId}/notifications/preferences`,
        "PATCH",
        { preferences: [{ eventType: "mention", inAppEnabled: false }] },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(disableMentionPreference.status, 200);
    const mutedMentionResponse = await createTaskComment(
      apiRequest(
        `${taskCollectionPath}/${memberTaskId}/comments`,
        "POST",
        { body: `A second mention @[${owner.userId}].` },
        member.cookie,
        { "idempotency-key": "member-task-mention-002" },
      ),
      memberTaskParams,
    );
    assert.equal(mutedMentionResponse.status, 201);
    const ownerNotificationsAfterMute = await listNotifications(
      apiRequest(`/api/organizations/${organizationId}/notifications`, "GET", undefined, owner.cookie),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(ownerNotificationsAfterMute.status, 200);
    const ownerNotificationsAfterMuteBody = (await ownerNotificationsAfterMute.json()) as {
      data: { notifications: Array<{ id: string; event_type: string }> };
    };
    assert.equal(ownerNotificationsAfterMuteBody.data.notifications.filter((item) => item.event_type === "mention").length, 1);

    const readMentionNotification = await updateNotification(
      apiRequest(
        `/api/organizations/${organizationId}/notifications/${mentionNotification.id}`,
        "PATCH",
        { read: true },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, notificationId: mentionNotification.id }) },
    );
    assert.equal(readMentionNotification.status, 200);
    const anotherUserRead = await updateNotification(
      apiRequest(
        `/api/organizations/${organizationId}/notifications/${mentionNotification.id}`,
        "PATCH",
        { read: true },
        member.cookie,
      ),
      { params: Promise.resolve({ organizationId, notificationId: mentionNotification.id }) },
    );
    assert.equal(anotherUserRead.status, 404);

    const restoreMentionPreference = await updateNotificationPreferences(
      apiRequest(
        `/api/organizations/${organizationId}/notifications/preferences`,
        "PATCH",
        { preferences: [{ eventType: "mention", inAppEnabled: true }] },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(restoreMentionPreference.status, 200);

    const changedToViewer = await updateProjectMember(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${projectId}/members/${member.userId}`,
        "PATCH",
        { role: "viewer" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, userId: member.userId }) },
    );
    assert.equal(changedToViewer.status, 200);

    const viewerFileList = await listTaskFiles(
      apiRequest(taskFilesPath, "GET", undefined, member.cookie),
      memberTaskParams,
    );
    assert.equal(viewerFileList.status, 200);
    const viewerFileListBody = (await viewerFileList.json()) as {
      data: { files: Array<{ id: string; version: number }> };
    };
    assert.deepEqual(viewerFileListBody.data.files.map((file) => [file.id, file.version]), [[taskFileId, 2]]);
    const viewerDownloadLink = await getTaskFile(
      apiRequest(taskFilePath, "GET", undefined, member.cookie),
      { params: Promise.resolve({ organizationId, projectId, taskId: memberTaskId, fileId: taskFileId }) },
    );
    assert.equal(viewerDownloadLink.status, 200);
    const viewerDownloadLinkBody = (await viewerDownloadLink.json()) as { data: { url: string } };
    const viewerSignedUrl = new URL(viewerDownloadLinkBody.data.url, origin);
    const viewerDownload = await getTaskFile(
      apiRequest(viewerSignedUrl.pathname + viewerSignedUrl.search),
      { params: Promise.resolve({ organizationId, projectId, taskId: memberTaskId, fileId: taskFileId }) },
    );
    assert.equal(viewerDownload.status, 200, await viewerDownload.clone().text());
    assert.deepEqual(Buffer.from(await viewerDownload.arrayBuffer()), fileBytesV2);

    const viewerFileUpload = await uploadTaskFile(
      privateFileRequest(
        taskFilesPath,
        "POST",
        Buffer.from("viewer upload should fail\n", "utf8"),
        "viewer.txt",
        member.cookie,
        { "idempotency-key": "viewer-file-upload-001" },
      ),
      memberTaskParams,
    );
    assert.equal(viewerFileUpload.status, 403);
    const viewerFileReplace = await replaceTaskFile(
      privateFileRequest(taskFilePath, "PUT", Buffer.from("viewer replace should fail\n", "utf8"), "release-notes.txt", member.cookie, {
        "if-match": '"2"',
      }),
      { params: Promise.resolve({ organizationId, projectId, taskId: memberTaskId, fileId: taskFileId }) },
    );
    assert.equal(viewerFileReplace.status, 403);
    const viewerFileDelete = await deleteTaskFile(
      apiRequest(taskFilePath, "DELETE", undefined, member.cookie),
      { params: Promise.resolve({ organizationId, projectId, taskId: memberTaskId, fileId: taskFileId }) },
    );
    assert.equal(viewerFileDelete.status, 403);
    const ownerFileDelete = await deleteTaskFile(
      apiRequest(taskFilePath, "DELETE", undefined, owner.cookie),
      { params: Promise.resolve({ organizationId, projectId, taskId: memberTaskId, fileId: taskFileId }) },
    );
    assert.equal(ownerFileDelete.status, 200);
    const deletedFileList = await listTaskFiles(
      apiRequest(taskFilesPath, "GET", undefined, owner.cookie),
      memberTaskParams,
    );
    assert.equal(deletedFileList.status, 200);
    assert.deepEqual(((await deletedFileList.json()) as { data: { files: unknown[] } }).data.files, []);
    const revokedSignedDownload = await getTaskFile(
      apiRequest(viewerSignedUrl.pathname + viewerSignedUrl.search),
      { params: Promise.resolve({ organizationId, projectId, taskId: memberTaskId, fileId: taskFileId }) },
    );
    assert.equal(revokedSignedDownload.status, 404);

    const viewerUpdate = await updateProject(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${projectId}`,
        "PATCH",
        { expectedVersion: 1, name: "Unauthorized edit" },
        member.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(viewerUpdate.status, 403);
    const viewerTaskCreate = await createTask(
      apiRequest(
        taskCollectionPath,
        "POST",
        { title: "Viewer cannot create work" },
        member.cookie,
        { "idempotency-key": "viewer-task-create-001" },
      ),
      projectParams,
    );
    assert.equal(viewerTaskCreate.status, 403, await viewerTaskCreate.clone().text());
    const viewerMilestoneCreate = await createMilestone(
      apiRequest(
        milestoneCollectionPath,
        "POST",
        { name: "Viewer cannot create a milestone" },
        member.cookie,
        { "idempotency-key": "viewer-mile-create-001" },
      ),
      projectParams,
    );
    assert.equal(viewerMilestoneCreate.status, 403);
    const viewerComments = await listTaskComments(
      apiRequest(`${taskCollectionPath}/${memberTaskId}/comments`, "GET", undefined, member.cookie),
      memberTaskParams,
    );
    assert.equal(viewerComments.status, 200);
    const viewerCommentPost = await createTaskComment(
      apiRequest(
        `${taskCollectionPath}/${memberTaskId}/comments`,
        "POST",
        { body: "Viewers cannot comment." },
        member.cookie,
        { "idempotency-key": "viewer-task-comment-001" },
      ),
      memberTaskParams,
    );
    assert.equal(viewerCommentPost.status, 403);

    const promoted = await updateProjectMember(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${projectId}/members/${member.userId}`,
        "PATCH",
        { role: "manager" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, userId: member.userId }) },
    );
    assert.equal(promoted.status, 200);

    const selfChange = await updateProjectMember(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${projectId}/members/${member.userId}`,
        "PATCH",
        { status: "disabled" },
        member.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, userId: member.userId }) },
    );
    assert.equal(selfChange.status, 409);

    const ownerProtection = await updateProjectMember(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${projectId}/members/${owner.userId}`,
        "PATCH",
        { status: "disabled" },
        member.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, userId: owner.userId }) },
    );
    assert.equal(ownerProtection.status, 409);

    const milestonePayload = {
      name: "Release candidate",
      description: "Coordinate the candidate build.",
      startDate: "2026-10-15",
      endDate: "2026-11-15",
    };
    const milestoneCreated = await createMilestone(
      apiRequest(
        milestoneCollectionPath,
        "POST",
        milestonePayload,
        owner.cookie,
        { "idempotency-key": "release-milestone-create-001" },
      ),
      projectParams,
    );
    assert.equal(milestoneCreated.status, 201);
    const milestoneCreatedBody = (await milestoneCreated.json()) as {
      data: { milestone: { id: string; version: number; progress_percent: number } };
    };
    const milestoneId = milestoneCreatedBody.data.milestone.id;
    assert.equal(milestoneCreatedBody.data.milestone.version, 1);
    assert.equal(milestoneCreatedBody.data.milestone.progress_percent, 0);

    const milestoneReplay = await createMilestone(
      apiRequest(
        milestoneCollectionPath,
        "POST",
        milestonePayload,
        owner.cookie,
        { "idempotency-key": "release-milestone-create-001" },
      ),
      projectParams,
    );
    assert.equal(milestoneReplay.status, 201);
    const milestoneReplayBody = (await milestoneReplay.json()) as {
      data: { milestone: { id: string } };
    };
    assert.equal(milestoneReplayBody.data.milestone.id, milestoneId);
    const milestoneReplayConflict = await createMilestone(
      apiRequest(
        milestoneCollectionPath,
        "POST",
        { ...milestonePayload, name: "Different milestone" },
        owner.cookie,
        { "idempotency-key": "release-milestone-create-001" },
      ),
      projectParams,
    );
    assert.equal(milestoneReplayConflict.status, 409);

    const milestoneStarted = await updateMilestone(
      apiRequest(
        `${milestoneCollectionPath}/${milestoneId}`,
        "PATCH",
        { expectedVersion: 1, status: "active" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, milestoneId }) },
    );
    assert.equal(milestoneStarted.status, 200);
    const staleMilestoneUpdate = await updateMilestone(
      apiRequest(
        `${milestoneCollectionPath}/${milestoneId}`,
        "PATCH",
        { expectedVersion: 1, name: "Stale milestone edit" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, milestoneId }) },
    );
    assert.equal(staleMilestoneUpdate.status, 409);

    const firstTaskPayload = {
      title: "Finalize release notes",
      description: "Prepare the release notes for review.",
      priority: "high",
      labels: ["release", "docs"],
      milestoneId,
      assigneeId: member.userId,
    };
    const firstTaskResponse = await createTask(
      apiRequest(
        taskCollectionPath,
        "POST",
        firstTaskPayload,
        owner.cookie,
        { "idempotency-key": "release-task-create-0001" },
      ),
      projectParams,
    );
    assert.equal(firstTaskResponse.status, 201);
    const firstTaskBody = (await firstTaskResponse.json()) as {
      data: { task: { id: string; version: number; status_name: string; milestone_id: string } };
    };
    const firstTaskId = firstTaskBody.data.task.id;
    assert.equal(firstTaskBody.data.task.version, 1);
    assert.equal(firstTaskBody.data.task.status_name, "Backlog");
    assert.equal(firstTaskBody.data.task.milestone_id, milestoneId);
    const assigneeNotificationsResponse = await listNotifications(
      apiRequest(`/api/organizations/${organizationId}/notifications`, "GET", undefined, member.cookie),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(assigneeNotificationsResponse.status, 200);
    const assigneeNotificationsBody = (await assigneeNotificationsResponse.json()) as {
      data: { notifications: Array<{ event_type: string; target_id: string }> };
    };
    assert.ok(assigneeNotificationsBody.data.notifications.some(
      (notification) => notification.event_type === "task_assigned" && notification.target_id === firstTaskId,
    ));

    const taskReplay = await createTask(
      apiRequest(
        taskCollectionPath,
        "POST",
        firstTaskPayload,
        owner.cookie,
        { "idempotency-key": "release-task-create-0001" },
      ),
      projectParams,
    );
    assert.equal(taskReplay.status, 201);
    const taskReplayBody = (await taskReplay.json()) as { data: { task: { id: string } } };
    assert.equal(taskReplayBody.data.task.id, firstTaskId);
    const taskReplayConflict = await createTask(
      apiRequest(
        taskCollectionPath,
        "POST",
        { ...firstTaskPayload, title: "Different task" },
        owner.cookie,
        { "idempotency-key": "release-task-create-0001" },
      ),
      projectParams,
    );
    assert.equal(taskReplayConflict.status, 409);

    const taskList = await listTasks(
      apiRequest(`${taskCollectionPath}?limit=20`, "GET", undefined, owner.cookie),
      projectParams,
    );
    assert.equal(taskList.status, 200);
    const taskListBody = (await taskList.json()) as {
      data: { statuses: Array<{ id: string; name: string; is_done: boolean }>; tasks: Array<{ id: string }> };
    };
    const doneStatus = taskListBody.data.statuses.find((status) => status.is_done);
    assert.ok(doneStatus);
    assert.ok(taskListBody.data.tasks.some((task) => task.id === firstTaskId));

    const taskDetail = await getTask(
      apiRequest(`${taskCollectionPath}/${firstTaskId}`, "GET", undefined, owner.cookie),
      { params: Promise.resolve({ organizationId, projectId, taskId: firstTaskId }) },
    );
    assert.equal(taskDetail.status, 200);
    const taskDetailBody = (await taskDetail.json()) as {
      data: { task: { id: string }; activity: Array<{ action: string }> };
    };
    assert.equal(taskDetailBody.data.task.id, firstTaskId);
    assert.ok(taskDetailBody.data.activity.some((event) => event.action === "task.created"));

    const taskUpdated = await updateTask(
      apiRequest(
        `${taskCollectionPath}/${firstTaskId}`,
        "PATCH",
        { expectedVersion: 1, priority: "urgent", labels: ["release", "qa"] },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, taskId: firstTaskId }) },
    );
    assert.equal(taskUpdated.status, 200);
    const taskUpdatedBody = (await taskUpdated.json()) as {
      data: { task: { version: number; priority: string; labels: string[] } };
    };
    assert.equal(taskUpdatedBody.data.task.version, 2);
    assert.equal(taskUpdatedBody.data.task.priority, "urgent");
    const staleTaskUpdate = await updateTask(
      apiRequest(
        `${taskCollectionPath}/${firstTaskId}`,
        "PATCH",
        { expectedVersion: 1, title: "Stale task edit" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, taskId: firstTaskId }) },
    );
    assert.equal(staleTaskUpdate.status, 409);

    const secondTaskResponse = await createTask(
      apiRequest(
        taskCollectionPath,
        "POST",
        { title: "Publish release", milestoneId, dependencies: [firstTaskId], assigneeId: member.userId },
        owner.cookie,
        { "idempotency-key": "release-task-create-0002" },
      ),
      projectParams,
    );
    assert.equal(secondTaskResponse.status, 201);
    const secondTaskBody = (await secondTaskResponse.json()) as { data: { task: { id: string } } };
    const secondTaskId = secondTaskBody.data.task.id;
    const projectAnalytics = await getProjectAnalytics(
      apiRequest(`/api/organizations/${organizationId}/projects/${projectId}/analytics`, "GET", undefined, owner.cookie),
      projectParams,
    );
    assert.equal(projectAnalytics.status, 200, await projectAnalytics.clone().text());
    const projectAnalyticsBody = (await projectAnalytics.json()) as {
      data: {
        project_status: string;
        progress_percent: number | null;
        tasks: { total: number; completed: number; overdue: number };
        milestones: {
          total: number;
          completed: number;
          items: Array<{ id: string; task_count: number; progress_percent: number | null }>;
        };
        health: { status: string };
        workload: {
          members: Array<{ user_id: string; open_task_count: number }>;
          unassigned: { open_task_count: number };
        };
        activity: { last_7_days_count: number; events: Array<{ action: string }> };
      };
    };
    assert.equal(projectAnalyticsBody.data.progress_percent, 0);
    assert.deepEqual(projectAnalyticsBody.data.tasks, { total: 3, completed: 0, overdue: 0 });
    assert.equal(projectAnalyticsBody.data.milestones.total, 1);
    assert.equal(projectAnalyticsBody.data.milestones.completed, 0);
    assert.equal(projectAnalyticsBody.data.milestones.items[0]?.id, milestoneId);
    assert.equal(projectAnalyticsBody.data.milestones.items[0]?.task_count, 2);
    assert.equal(projectAnalyticsBody.data.milestones.items[0]?.progress_percent, 0);
    assert.equal(projectAnalyticsBody.data.health.status, "planned");
    assert.equal(projectAnalyticsBody.data.workload.members.find((item) => item.user_id === member.userId)?.open_task_count, 2);
    assert.equal(projectAnalyticsBody.data.workload.unassigned.open_task_count, 1);
    assert.ok(projectAnalyticsBody.data.activity.last_7_days_count >= 1);
    assert.ok(projectAnalyticsBody.data.activity.events.some((event) => event.action === "task.created"));
    const blockedCompletion = await updateTask(
      apiRequest(
        `${taskCollectionPath}/${secondTaskId}`,
        "PATCH",
        { expectedVersion: 1, statusId: doneStatus.id },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, taskId: secondTaskId }) },
    );
    assert.equal(blockedCompletion.status, 409);

    const dependencyCycle = await updateTask(
      apiRequest(
        `${taskCollectionPath}/${firstTaskId}`,
        "PATCH",
        { expectedVersion: 2, dependencies: [secondTaskId] },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, taskId: firstTaskId }) },
    );
    assert.equal(dependencyCycle.status, 409);

    const firstTaskCompleted = await updateTask(
      apiRequest(
        `${taskCollectionPath}/${firstTaskId}`,
        "PATCH",
        { expectedVersion: 2, statusId: doneStatus.id },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, taskId: firstTaskId }) },
    );
    assert.equal(firstTaskCompleted.status, 200);
    const reorderedTaskConflict = await updateTask(
      apiRequest(
        `${taskCollectionPath}/${secondTaskId}`,
        "PATCH",
        { expectedVersion: 1, statusId: doneStatus.id },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, taskId: secondTaskId }) },
    );
    assert.equal(reorderedTaskConflict.status, 409);
    const refreshedSecondTask = await getTask(
      apiRequest(`${taskCollectionPath}/${secondTaskId}`, "GET", undefined, owner.cookie),
      { params: Promise.resolve({ organizationId, projectId, taskId: secondTaskId }) },
    );
    assert.equal(refreshedSecondTask.status, 200);
    const refreshedSecondTaskBody = (await refreshedSecondTask.json()) as {
      data: { task: { version: number } };
    };
    const secondTaskCompleted = await updateTask(
      apiRequest(
        `${taskCollectionPath}/${secondTaskId}`,
        "PATCH",
        { expectedVersion: refreshedSecondTaskBody.data.task.version, statusId: doneStatus.id },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, taskId: secondTaskId }) },
    );
    assert.equal(secondTaskCompleted.status, 200, await secondTaskCompleted.clone().text());
    const memberTaskCompleted = await updateTask(
      apiRequest(
        `${taskCollectionPath}/${memberTaskId}`,
        "PATCH",
        { expectedVersion: 1, statusId: doneStatus.id },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, taskId: memberTaskId }) },
    );
    assert.equal(memberTaskCompleted.status, 200);

    const milestoneProgress = await listMilestones(
      apiRequest(milestoneCollectionPath, "GET", undefined, owner.cookie),
      projectParams,
    );
    assert.equal(milestoneProgress.status, 200);
    const milestoneProgressBody = (await milestoneProgress.json()) as {
      data: { milestones: Array<{ id: string; progress_percent: number; task_count: number }> };
    };
    const completedProgress = milestoneProgressBody.data.milestones.find((item) => item.id === milestoneId);
    assert.equal(completedProgress?.task_count, 2);
    assert.equal(completedProgress?.progress_percent, 100);
    const milestoneCompleted = await updateMilestone(
      apiRequest(
        `${milestoneCollectionPath}/${milestoneId}`,
        "PATCH",
        { expectedVersion: 2, status: "completed" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, milestoneId }) },
    );
    assert.equal(milestoneCompleted.status, 200);

    const invalidTransition = await updateProject(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${projectId}`,
        "PATCH",
        { expectedVersion: 1, status: "on_hold" },
        member.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(invalidTransition.status, 409);

    const renamed = await updateProject(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${projectId}`,
        "PATCH",
        { expectedVersion: 1, name: "Member-managed project" },
        member.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(renamed.status, 200);
    const renamedBody = (await renamed.json()) as { data: { project: { name: string; version: number } } };
    assert.equal(renamedBody.data.project.name, "Member-managed project");
    assert.equal(renamedBody.data.project.version, 2);

    const staleUpdate = await updateProject(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${projectId}`,
        "PATCH",
        { expectedVersion: 1, name: "Stale project name" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(staleUpdate.status, 409);

    const activated = await updateProject(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${projectId}`,
        "PATCH",
        { expectedVersion: 2, status: "active" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(activated.status, 200);
    const completed = await updateProject(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${projectId}`,
        "PATCH",
        { expectedVersion: 3, status: "completed" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(completed.status, 200);
    const archived = await updateProject(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${projectId}`,
        "PATCH",
        { expectedVersion: 4, status: "archived" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(archived.status, 200);
    const unarchive = await updateProject(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${projectId}`,
        "PATCH",
        { expectedVersion: 5, status: "active" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(unarchive.status, 409);

    const disabled = await updateProjectMember(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${projectId}/members/${member.userId}`,
        "PATCH",
        { status: "disabled" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, userId: member.userId }) },
    );
    assert.equal(disabled.status, 200);
    const hiddenAfterDisable = await getProject(
      apiRequest(`/api/organizations/${organizationId}/projects/${projectId}`, "GET", undefined, member.cookie),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(hiddenAfterDisable.status, 404);
    const restored = await updateProjectMember(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${projectId}/members/${member.userId}`,
        "PATCH",
        { status: "active" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, userId: member.userId }) },
    );
    assert.equal(restored.status, 200);

    const otherOrganizationId = await createWorkspace(member.cookie, `other-${member.userId.slice(0, 8)}`);
    const otherProject = await createProject(
      apiRequest(
        `/api/organizations/${otherOrganizationId}/projects`,
        "POST",
        { name: "Separate tenant project" },
        member.cookie,
      ),
      { params: Promise.resolve({ organizationId: otherOrganizationId }) },
    );
    assert.equal(otherProject.status, 201);
    const crossTenant = await listProjects(
      apiRequest(`/api/organizations/${otherOrganizationId}/projects`, "GET", undefined, owner.cookie),
      { params: Promise.resolve({ organizationId: otherOrganizationId }) },
    );
    assert.equal(crossTenant.status, 403);

    const auditActions = await withOrganizationContext(
      owner.userId,
      organizationId,
      async (transaction) => {
        const result = await transaction.query<{ action: string }>(
          `SELECT action FROM nexora.audit_events
           WHERE organization_id = $1
             AND (target_id = $2::uuid OR details->>'projectId' = $2::uuid::text OR target_id = $3::uuid)`,
          [organizationId, projectId, memberTaskId],
        );
        return result.rows.map((row) => row.action);
      },
    );
    assert.ok(auditActions.includes("project.created"));
    assert.ok(auditActions.includes("project.updated"));
    assert.ok(auditActions.includes("project.member.added"));
    assert.ok(auditActions.includes("project.member.updated"));
    assert.ok(auditActions.includes("task.comment_created"));

    const graphProjectResponse = await createProject(
      apiRequest(
        `/api/organizations/${organizationId}/projects`,
        "POST",
        { name: "Milestone graph concurrency test" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(graphProjectResponse.status, 201, await graphProjectResponse.clone().text());
    const graphProjectBody = (await graphProjectResponse.json()) as {
      data: { project: { id: string } };
    };
    const graphProjectId = graphProjectBody.data.project.id;
    const graphProjectParams = { params: Promise.resolve({ organizationId, projectId: graphProjectId }) };

    async function createGraphMilestone(name: string, idempotencyKey: string): Promise<string> {
      const response = await createMilestone(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${graphProjectId}/milestones`,
          "POST",
          { name },
          owner.cookie,
          { "idempotency-key": idempotencyKey },
        ),
        graphProjectParams,
      );
      assert.equal(response.status, 201, await response.clone().text());
      const body = (await response.json()) as { data: { milestone: { id: string } } };
      return body.data.milestone.id;
    }

    const graphMilestoneA = await createGraphMilestone("Graph milestone A", randomUUID());
    const graphMilestoneB = await createGraphMilestone("Graph milestone B", randomUUID());
    const repeatedReadMilestoneA = await createGraphMilestone("Repeatable read milestone A", randomUUID());
    const repeatedReadMilestoneB = await createGraphMilestone("Repeatable read milestone B", randomUUID());

    const taskGraphIds = [randomUUID(), randomUUID()];
    await withOrganizationContext(
      owner.userId,
      organizationId,
      async (transaction) => {
        const status = await transaction.query<{ id: string }>(
          `SELECT id FROM nexora.project_task_statuses
           WHERE organization_id = $1 AND project_id = $2
           ORDER BY sort_order, id LIMIT 1`,
          [organizationId, graphProjectId],
        );
        assert.ok(status.rows[0]);
        for (const [index, taskId] of taskGraphIds.entries()) {
          await transaction.query(
            `INSERT INTO nexora.tasks
               (id, organization_id, project_id, title, workflow_status_id, created_by_user_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [taskId, organizationId, graphProjectId, `Repeatable read task ${index + 1}`, status.rows[0].id, owner.userId],
          );
        }
      },
    );

    async function raceGraphInsertAtRepeatableRead(
      table: "milestone_dependencies" | "task_dependencies",
      sourceColumn: "milestone_id" | "task_id",
      targetColumn: "depends_on_milestone_id" | "depends_on_task_id",
      itemA: string,
      itemB: string,
    ): Promise<void> {
      const clients = [new Client({ connectionString }), new Client({ connectionString })];
      const committed = new Set<number>();
      let connected = 0;
      try {
        for (const client of clients) {
          await client.connect();
          connected += 1;
        }
        await Promise.all(clients.map((client) => client.query("BEGIN ISOLATION LEVEL REPEATABLE READ")));
        await Promise.all(
          clients.map((client) =>
            client.query(
              "SELECT pg_catalog.set_config('nexora.user_id', $1, true), pg_catalog.set_config('nexora.organization_id', $2, true)",
              [owner.userId, organizationId],
            ),
          ),
        );
        await Promise.all(
          clients.map((client) =>
            client.query(
              `SELECT count(*) FROM nexora.${table}
               WHERE organization_id = $1 AND project_id = $2`,
              [organizationId, graphProjectId],
            ),
          ),
        );

        const insertSql = `INSERT INTO nexora.${table}
          (organization_id, project_id, ${sourceColumn}, ${targetColumn})
          VALUES ($1, $2, $3, $4)`;
        const attempts = [
          [itemA, itemB],
          [itemB, itemA],
        ].map(([source, target], index) =>
          clients[index]!.query(insertSql, [organizationId, graphProjectId, source, target]).then(
            () => ({ index, inserted: true as const }),
            (error: unknown) => ({ index, inserted: false as const, error }),
          ),
        );

        const first = await Promise.race(attempts);
        assert.equal(first.inserted, true);
        await clients[first.index]!.query("COMMIT");
        committed.add(first.index);

        const outcomes = await Promise.all(attempts);
        assert.equal(outcomes.filter((outcome) => outcome.inserted).length, 1);
        const rejected = outcomes.find(
          (outcome): outcome is Extract<(typeof outcomes)[number], { inserted: false }> => !outcome.inserted,
        );
        assert.ok(rejected);
        assert.equal((rejected.error as { code?: string }).code, "40001");

        const remainingEdges = await withOrganizationContext(
          owner.userId,
          organizationId,
          (transaction) =>
            transaction.query<{ source_id: string; target_id: string }>(
              `SELECT ${sourceColumn} AS source_id, ${targetColumn} AS target_id
               FROM nexora.${table}
               WHERE organization_id = $1 AND project_id = $2
                 AND ${sourceColumn} = ANY($3::uuid[])
                 AND ${targetColumn} = ANY($3::uuid[])`,
              [organizationId, graphProjectId, [itemA, itemB]],
            ),
        );
        assert.equal(remainingEdges.rows.length, 1);
      } finally {
        await Promise.all(
          clients.slice(0, connected).map((client, index) =>
            committed.has(index) ? Promise.resolve() : client.query("ROLLBACK").catch(() => undefined),
          ),
        );
        await Promise.all(clients.slice(0, connected).map((client) => client.end()));
      }
    }

    await t.test("direct milestone dependency inserts cannot cross projects", async () => {
      const client = new Client({ connectionString });
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_catalog.set_config('nexora.user_id', $1, true), pg_catalog.set_config('nexora.organization_id', $2, true)",
          [owner.userId, organizationId],
        );
        await assert.rejects(
          client.query(
            `INSERT INTO nexora.milestone_dependencies
               (organization_id, project_id, milestone_id, depends_on_milestone_id)
             VALUES ($1, $2, $3, $4)`,
            [organizationId, graphProjectId, graphMilestoneA, milestoneId],
          ),
          (error: { code?: string }) => error.code === "23503",
        );
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        await client.end();
      }
    });

    await t.test("simultaneous opposite milestone dependencies cannot create a cycle", async () => {
      const clients = [new Client({ connectionString }), new Client({ connectionString })];
      const committed = new Set<number>();
      let connected = 0;
      try {
        for (const client of clients) {
          await client.connect();
          connected += 1;
        }
        await Promise.all(clients.map((client) => client.query("BEGIN")));
        await Promise.all(
          clients.map((client) =>
            client.query(
              "SELECT pg_catalog.set_config('nexora.user_id', $1, true), pg_catalog.set_config('nexora.organization_id', $2, true)",
              [owner.userId, organizationId],
            ),
          ),
        );

        const insertSql = `INSERT INTO nexora.milestone_dependencies
          (organization_id, project_id, milestone_id, depends_on_milestone_id)
          VALUES ($1, $2, $3, $4)`;
        const attempts = [
          [graphMilestoneA, graphMilestoneB],
          [graphMilestoneB, graphMilestoneA],
        ].map(([milestone, dependency], index) =>
          clients[index]!.query(insertSql, [organizationId, graphProjectId, milestone, dependency]).then(
            () => ({ index, inserted: true as const }),
            (error: unknown) => ({ index, inserted: false as const, error }),
          ),
        );

        const first = await Promise.race(attempts);
        if (!first.inserted) throw first.error;
        await clients[first.index]!.query("COMMIT");
        committed.add(first.index);

        const outcomes = await Promise.all(attempts);
        assert.equal(outcomes.filter((outcome) => outcome.inserted).length, 1);
        const rejected = outcomes.find(
          (outcome): outcome is Extract<(typeof outcomes)[number], { inserted: false }> => !outcome.inserted,
        );
        assert.ok(rejected);
        assert.equal((rejected.error as { code?: string }).code, "23514");
        assert.match((rejected.error as Error).message, /milestone dependency cycle detected/);

        const remainingEdges = await withOrganizationContext(
          owner.userId,
          organizationId,
          (transaction) =>
            transaction.query<{ milestone_id: string; depends_on_milestone_id: string }>(
              `SELECT milestone_id, depends_on_milestone_id
               FROM nexora.milestone_dependencies
               WHERE organization_id = $1 AND project_id = $2`,
              [organizationId, graphProjectId],
            ),
        );
        assert.equal(remainingEdges.rows.length, 1);
        assert.ok(
          (remainingEdges.rows[0]?.milestone_id === graphMilestoneA &&
            remainingEdges.rows[0]?.depends_on_milestone_id === graphMilestoneB) ||
            (remainingEdges.rows[0]?.milestone_id === graphMilestoneB &&
              remainingEdges.rows[0]?.depends_on_milestone_id === graphMilestoneA),
        );
      } finally {
        await Promise.all(
          clients.slice(0, connected).map((client, index) =>
            committed.has(index) ? Promise.resolve() : client.query("ROLLBACK").catch(() => undefined),
          ),
        );
        await Promise.all(clients.slice(0, connected).map((client) => client.end()));
      }
    });

    await t.test("milestone graph writes serialize with repeatable-read snapshots", async () => {
      await raceGraphInsertAtRepeatableRead(
        "milestone_dependencies",
        "milestone_id",
        "depends_on_milestone_id",
        repeatedReadMilestoneA,
        repeatedReadMilestoneB,
      );
    });

    await t.test("task graph writes serialize with repeatable-read snapshots", async () => {
      await raceGraphInsertAtRepeatableRead(
        "task_dependencies",
        "task_id",
        "depends_on_task_id",
        taskGraphIds[0]!,
        taskGraphIds[1]!,
      );
    });
  },
);
