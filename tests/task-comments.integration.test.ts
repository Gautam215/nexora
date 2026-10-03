import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server.js";
import { Client } from "pg";
import { POST as acceptInvitation } from "../src/app/api/invitations/accept/route.ts";
import { POST as login } from "../src/app/api/auth/login/route.ts";
import { POST as register } from "../src/app/api/auth/register/route.ts";
import { POST as consumeVerification } from "../src/app/api/auth/verification/consume/route.ts";
import {
  GET as getTask,
  PATCH as updateTask,
} from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/[taskId]/route.ts";
import {
  GET as listComments,
  POST as createComment,
} from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/[taskId]/comments/route.ts";
import { POST as createProject } from "../src/app/api/organizations/[organizationId]/projects/route.ts";
import { POST as createProjectMember } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/members/route.ts";
import { POST as createInvitation } from "../src/app/api/organizations/[organizationId]/members/route.ts";
import { POST as createOrganization } from "../src/app/api/organizations/route.ts";
import {
  GET as listMilestones,
  POST as createMilestone,
} from "../src/app/api/organizations/[organizationId]/projects/[projectId]/milestones/route.ts";
import { PATCH as updateMilestone } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/milestones/[milestoneId]/route.ts";
import { POST as createTask } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/route.ts";
import { closeDatabasePool, withOrganizationContext } from "../src/server/db.ts";
import { startSmtpCaptureServer, type SmtpCapture } from "./smtp-server.ts";

const connectionString = process.env.NEXORA_TEST_DATABASE_URL;
const origin = "http://localhost:3000";
const runtimeEnvironment = process.env as unknown as Record<string, string | undefined>;
let smtp: SmtpCapture | undefined;
if (connectionString) process.env.DATABASE_URL = connectionString;
runtimeEnvironment.NODE_ENV = "test";
process.env.APP_ORIGIN = origin;
process.env.AUTH_RATE_LIMIT_HMAC_KEY = randomBytes(32).toString("hex");
delete process.env.NEXORA_TRUSTED_CLIENT_IP_HEADER;

after(async () => {
  await smtp?.close();
  await closeDatabasePool();
});

function apiRequest(
  path: string,
  method = "GET",
  body?: unknown,
  cookie?: string,
  extraHeaders: Record<string, string> = {},
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
  const decoded = message.replace(/=\r\n/g, "").replace(/=3D/gi, "=");
  const token = decoded.match(new RegExp(`${pathname}\\?token=([A-Za-z0-9_-]{43})`))?.[1];
  assert.ok(token, `expected ${pathname} token in captured email`);
  return token;
}

async function registerVerifyAndLogin(email: string, name: string, password: string) {
  const registered = await register(apiRequest("/api/auth/register", "POST", { name, email, password }));
  assert.equal(registered.status, 202);
  const verificationToken = tokenFromMessage(smtp?.messages.at(-1) ?? "", "/verify-email");
  const verified = await consumeVerification(
    apiRequest("/api/auth/verification/consume", "POST", { token: verificationToken }),
  );
  assert.equal(verified.status, 200);

  const loginResponse = await login(apiRequest("/api/auth/login", "POST", { email, password }));
  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get("set-cookie")?.match(/nexora_session=([^;]+)/)?.[1];
  assert.ok(cookie);
  const result = (await loginResponse.json()) as { data: { user: { id: string } } };
  return { userId: result.data.user.id, cookie: `nexora_session=${cookie}` };
}

test(
  "milestones and task comments enforce project access, lifecycle guards, audit history, and idempotent retries",
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
      "Comment Owner",
      "comment owner password",
    );
    const organizationResponse = await createOrganization(
      apiRequest(
        "/api/organizations",
        "POST",
        { name: "Comment Workspace", slug: `comments-${owner.userId.slice(0, 8)}` },
        owner.cookie,
      ),
    );
    assert.equal(organizationResponse.status, 201);
    const organizationBody = (await organizationResponse.json()) as {
      data: { organization: { id: string } };
    };
    const organizationId = organizationBody.data.organization.id;

    const projectResponse = await createProject(
      apiRequest(
        `/api/organizations/${organizationId}/projects`,
        "POST",
        { name: "Comment acceptance project" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(projectResponse.status, 201);
    const projectBody = (await projectResponse.json()) as { data: { project: { id: string } } };
    const projectId = projectBody.data.project.id;

    const milestonesPath = `/api/organizations/${organizationId}/projects/${projectId}/milestones`;
    const invalidMilestone = await createMilestone(
      apiRequest(
        milestonesPath,
        "POST",
        { name: "Invalid dates", startDate: "2026-11-01", endDate: "2026-10-01" },
        owner.cookie,
        { "idempotency-key": "milestone-invalid-date-001" },
      ),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(invalidMilestone.status, 400);

    const prerequisitePayload = {
      name: "Prerequisite milestone",
      startDate: "2026-10-01",
      endDate: "2026-10-10",
    };
    const prerequisiteResponse = await createMilestone(
      apiRequest(milestonesPath, "POST", prerequisitePayload, owner.cookie, {
        "idempotency-key": "milestone-prerequisite-001",
      }),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(prerequisiteResponse.status, 201);
    const prerequisiteBody = (await prerequisiteResponse.json()) as {
      data: { milestone: { id: string; version: number; status: string } };
    };
    const prerequisite = prerequisiteBody.data.milestone;
    const prerequisiteReplay = await createMilestone(
      apiRequest(milestonesPath, "POST", prerequisitePayload, owner.cookie, {
        "idempotency-key": "milestone-prerequisite-001",
      }),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(prerequisiteReplay.status, 201);
    const prerequisiteReplayBody = (await prerequisiteReplay.json()) as {
      data: { milestone: { id: string } };
    };
    assert.equal(prerequisiteReplayBody.data.milestone.id, prerequisite.id);

    const releaseResponse = await createMilestone(
      apiRequest(
        milestonesPath,
        "POST",
        { name: "Release milestone", dependencies: [prerequisite.id] },
        owner.cookie,
        { "idempotency-key": "milestone-release-0001" },
      ),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(releaseResponse.status, 201);
    const releaseBody = (await releaseResponse.json()) as {
      data: { milestone: { id: string; version: number; dependencies: Array<{ id: string }> } };
    };
    const releaseMilestone = releaseBody.data.milestone;
    assert.equal(releaseMilestone.dependencies[0]?.id, prerequisite.id);

    const cycleAttempt = await updateMilestone(
      apiRequest(
        `${milestonesPath}/${prerequisite.id}`,
        "PATCH",
        { expectedVersion: 1, dependencies: [releaseMilestone.id] },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, milestoneId: prerequisite.id }) },
    );
    assert.equal(cycleAttempt.status, 409);

    const earlyStart = await updateMilestone(
      apiRequest(
        `${milestonesPath}/${releaseMilestone.id}`,
        "PATCH",
        { expectedVersion: 1, status: "active" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, milestoneId: releaseMilestone.id }) },
    );
    assert.equal(earlyStart.status, 409);
    const earlyStartBody = (await earlyStart.json()) as { error: { code: string } };
    assert.equal(earlyStartBody.error.code, "MILESTONE_DEPENDENCIES_INCOMPLETE");

    const completePrerequisite = await updateMilestone(
      apiRequest(
        `${milestonesPath}/${prerequisite.id}`,
        "PATCH",
        { expectedVersion: 1, status: "completed" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, milestoneId: prerequisite.id }) },
    );
    assert.equal(completePrerequisite.status, 200);
    const completePrerequisiteBody = (await completePrerequisite.json()) as {
      data: { milestone: { version: number; status: string } };
    };
    assert.equal(completePrerequisiteBody.data.milestone.version, 2);
    assert.equal(completePrerequisiteBody.data.milestone.status, "completed");

    const activateRelease = await updateMilestone(
      apiRequest(
        `${milestonesPath}/${releaseMilestone.id}`,
        "PATCH",
        { expectedVersion: 1, status: "active" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, milestoneId: releaseMilestone.id }) },
    );
    assert.equal(activateRelease.status, 200);
    const activateReleaseBody = (await activateRelease.json()) as {
      data: { milestone: { version: number; status: string } };
    };
    assert.equal(activateReleaseBody.data.milestone.version, 2);
    assert.equal(activateReleaseBody.data.milestone.status, "active");

    const staleMilestoneUpdate = await updateMilestone(
      apiRequest(
        `${milestonesPath}/${releaseMilestone.id}`,
        "PATCH",
        { expectedVersion: 1, name: "Stale release name" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, milestoneId: releaseMilestone.id }) },
    );
    assert.equal(staleMilestoneUpdate.status, 409);

    const taskResponse = await createTask(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${projectId}/tasks`,
        "POST",
        { title: "Review comment security", milestoneId: releaseMilestone.id },
        owner.cookie,
        { "idempotency-key": "comment-test-task-seed-01" },
      ),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(taskResponse.status, 201);
    const taskBody = (await taskResponse.json()) as { data: { task: { id: string } } };
    const taskId = taskBody.data.task.id;
    const commentsPath = `/api/organizations/${organizationId}/projects/${projectId}/tasks/${taskId}/comments`;

    const staleTaskUpdate = await updateTask(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${projectId}/tasks/${taskId}`,
        "PATCH",
        { expectedVersion: 2, priority: "high" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, taskId }) },
    );
    assert.equal(staleTaskUpdate.status, 409);

    const prematureMilestoneCompletion = await updateMilestone(
      apiRequest(
        `${milestonesPath}/${releaseMilestone.id}`,
        "PATCH",
        { expectedVersion: 2, status: "completed" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, milestoneId: releaseMilestone.id }) },
    );
    assert.equal(prematureMilestoneCompletion.status, 409);
    const prematureCompletionBody = (await prematureMilestoneCompletion.json()) as { error: { code: string } };
    assert.equal(prematureCompletionBody.error.code, "MILESTONE_TASKS_INCOMPLETE");

    const commentPayload = { body: "  Check tenant scope and retry handling before release.  " };
    const idempotencyKey = "comment-concurrent-001";
    const [first, replay] = await Promise.all([
      createComment(apiRequest(commentsPath, "POST", commentPayload, owner.cookie, { "idempotency-key": idempotencyKey }), {
        params: Promise.resolve({ organizationId, projectId, taskId }),
      }),
      createComment(apiRequest(commentsPath, "POST", commentPayload, owner.cookie, { "idempotency-key": idempotencyKey }), {
        params: Promise.resolve({ organizationId, projectId, taskId }),
      }),
    ]);
    assert.equal(first.status, 201);
    assert.equal(replay.status, 201);
    const firstBody = (await first.json()) as { data: { comment: { id: string; body: string } } };
    const replayBody = (await replay.json()) as { data: { comment: { id: string; body: string } } };
    assert.equal(firstBody.data.comment.body, "Check tenant scope and retry handling before release.");
    assert.equal(replayBody.data.comment.id, firstBody.data.comment.id);

    const mismatchedReplay = await createComment(
      apiRequest(commentsPath, "POST", { body: "Different content" }, owner.cookie, { "idempotency-key": idempotencyKey }),
      { params: Promise.resolve({ organizationId, projectId, taskId }) },
    );
    assert.equal(mismatchedReplay.status, 409);
    const missingKey = await createComment(
      apiRequest(commentsPath, "POST", { body: "No key" }, owner.cookie),
      { params: Promise.resolve({ organizationId, projectId, taskId }) },
    );
    assert.equal(missingKey.status, 400);
    const emptyComment = await createComment(
      apiRequest(commentsPath, "POST", { body: "   " }, owner.cookie, { "idempotency-key": "comment-empty-0001" }),
      { params: Promise.resolve({ organizationId, projectId, taskId }) },
    );
    assert.equal(emptyComment.status, 400);

    const commentList = await listComments(
      apiRequest(commentsPath, "GET", undefined, owner.cookie),
      { params: Promise.resolve({ organizationId, projectId, taskId }) },
    );
    assert.equal(commentList.status, 200);
    const listBody = (await commentList.json()) as {
      data: { comments: Array<{ id: string; author_name: string; body: string }> };
    };
    assert.equal(listBody.data.comments.length, 1);
    assert.equal(listBody.data.comments[0]?.author_name, "Comment Owner");

    const concurrentResponses = await Promise.all(
      ["Concurrent comment A", "Concurrent comment B"].map((body, index) =>
        createComment(
          apiRequest(commentsPath, "POST", { body }, owner.cookie, {
            "idempotency-key": `comment-independent-${index + 1}`,
          }),
          { params: Promise.resolve({ organizationId, projectId, taskId }) },
        ),
      ),
    );
    assert.deepEqual(concurrentResponses.map((response) => response.status), [201, 201]);
    const concurrentBodies = await Promise.all(
      concurrentResponses.map((response) => response.json() as Promise<{ data: { comment: { id: string } } }>),
    );
    assert.notEqual(concurrentBodies[0]?.data.comment.id, concurrentBodies[1]?.data.comment.id);

    const firstPage = await listComments(
      apiRequest(`${commentsPath}?limit=2`, "GET", undefined, owner.cookie),
      { params: Promise.resolve({ organizationId, projectId, taskId }) },
    );
    const firstPageBody = (await firstPage.json()) as {
      data: { comments: Array<{ id: string }>; pagination: { hasMore: boolean } };
    };
    assert.equal(firstPage.status, 200);
    assert.equal(firstPageBody.data.comments.length, 2);
    assert.equal(firstPageBody.data.pagination.hasMore, true);

    const secondPage = await listComments(
      apiRequest(`${commentsPath}?limit=2&offset=2`, "GET", undefined, owner.cookie),
      { params: Promise.resolve({ organizationId, projectId, taskId }) },
    );
    const secondPageBody = (await secondPage.json()) as {
      data: { comments: Array<{ id: string }>; pagination: { hasMore: boolean } };
    };
    assert.equal(secondPage.status, 200);
    assert.equal(secondPageBody.data.comments.length, 1);
    assert.equal(secondPageBody.data.pagination.hasMore, false);

    const taskDetail = await getTask(
      apiRequest(`/api/organizations/${organizationId}/projects/${projectId}/tasks/${taskId}`, "GET", undefined, owner.cookie),
      { params: Promise.resolve({ organizationId, projectId, taskId }) },
    );
    assert.equal(taskDetail.status, 200);
    const activityBody = (await taskDetail.json()) as {
      data: { activity: Array<{ action: string; details: Record<string, unknown> }> };
    };
    const commentEvent = activityBody.data.activity.find((event) => event.action === "comment.added");
    assert.ok(commentEvent);
    assert.equal("body" in commentEvent.details, false);

    const viewerEmail = `${randomUUID()}@example.test`;
    const inviteResponse = await createInvitation(
      apiRequest(`/api/organizations/${organizationId}/members`, "POST", { email: viewerEmail, role: "member" }, owner.cookie),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(inviteResponse.status, 201);
    const inviteToken = tokenFromMessage(smtp.messages.at(-1) ?? "", "/accept-invitation");
    const viewer = await registerVerifyAndLogin(viewerEmail, "Comment Viewer", "comment viewer password");
    const accepted = await acceptInvitation(
      apiRequest("/api/invitations/accept", "POST", { token: inviteToken }, viewer.cookie),
    );
    assert.equal(accepted.status, 200);
    const assigned = await createProjectMember(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${projectId}/members`,
        "POST",
        { userId: viewer.userId, role: "viewer" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(assigned.status, 201);

    const viewerMilestoneRead = await listMilestones(
      apiRequest(milestonesPath, "GET", undefined, viewer.cookie),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(viewerMilestoneRead.status, 200);
    const viewerMilestoneCreate = await createMilestone(
      apiRequest(
        milestonesPath,
        "POST",
        { name: "Viewer cannot create" },
        viewer.cookie,
        { "idempotency-key": "viewer-milestone-create-01" },
      ),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(viewerMilestoneCreate.status, 403);
    const viewerMilestoneUpdate = await updateMilestone(
      apiRequest(
        `${milestonesPath}/${releaseMilestone.id}`,
        "PATCH",
        { expectedVersion: 2, name: "Viewer cannot edit" },
        viewer.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, milestoneId: releaseMilestone.id }) },
    );
    assert.equal(viewerMilestoneUpdate.status, 403);

    const viewerRead = await listComments(
      apiRequest(commentsPath, "GET", undefined, viewer.cookie),
      { params: Promise.resolve({ organizationId, projectId, taskId }) },
    );
    assert.equal(viewerRead.status, 200);
    const viewerWrite = await createComment(
      apiRequest(commentsPath, "POST", { body: "Viewer cannot comment" }, viewer.cookie, { "idempotency-key": "viewer-comment-0001" }),
      { params: Promise.resolve({ organizationId, projectId, taskId }) },
    );
    assert.equal(viewerWrite.status, 403);

    const other = await registerVerifyAndLogin(
      `${randomUUID()}@example.test`,
      "Other Tenant",
      "other tenant password",
    );
    const otherOrganizationResponse = await createOrganization(
      apiRequest(
        "/api/organizations",
        "POST",
        { name: "Other Workspace", slug: `other-${other.userId.slice(0, 8)}` },
        other.cookie,
      ),
    );
    assert.equal(otherOrganizationResponse.status, 201);
    const otherOrganizationBody = (await otherOrganizationResponse.json()) as {
      data: { organization: { id: string } };
    };
    const crossTenantRead = await listComments(
      apiRequest(commentsPath, "GET", undefined, other.cookie),
      { params: Promise.resolve({ organizationId, projectId, taskId }) },
    );
    assert.equal(crossTenantRead.status, 403);
    const crossTenantMilestones = await listMilestones(
      apiRequest(milestonesPath, "GET", undefined, other.cookie),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(crossTenantMilestones.status, 403);

    const hiddenComments = await withOrganizationContext(
      other.userId,
      otherOrganizationBody.data.organization.id,
      async (transaction) => {
        const result = await transaction.query<{ id: string }>(
          "SELECT id FROM nexora.task_comments WHERE id = $1",
          [firstBody.data.comment.id],
        );
        return result.rows;
      },
    );
    assert.equal(hiddenComments.length, 0);

    const directClient = new Client({ connectionString });
    await directClient.connect();
    try {
      await directClient.query("BEGIN");
      await directClient.query(
        "SELECT pg_catalog.set_config('nexora.user_id', $1, true), pg_catalog.set_config('nexora.organization_id', $2, true)",
        [owner.userId, organizationId],
      );
      await assert.rejects(
        directClient.query("UPDATE nexora.task_comments SET body = 'edited' WHERE id = $1", [firstBody.data.comment.id]),
        (error: { code?: string }) => error.code === "42501",
      );
      await directClient.query("ROLLBACK");
    } catch (error) {
      await directClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await directClient.end();
    }

    const doneStatusId = await withOrganizationContext(
      owner.userId,
      organizationId,
      async (transaction) => {
        const result = await transaction.query<{ id: string }>(
          `SELECT id FROM nexora.project_task_statuses
           WHERE organization_id = $1 AND project_id = $2 AND is_done`,
          [organizationId, projectId],
        );
        return result.rows[0]?.id;
      },
    );
    assert.ok(doneStatusId);

    const finishTask = await updateTask(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${projectId}/tasks/${taskId}`,
        "PATCH",
        { expectedVersion: 1, statusId: doneStatusId },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, taskId }) },
    );
    assert.equal(finishTask.status, 200);

    const milestoneList = await listMilestones(
      apiRequest(milestonesPath, "GET", undefined, owner.cookie),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(milestoneList.status, 200);
    const milestoneListBody = (await milestoneList.json()) as {
      data: { milestones: Array<{ id: string; task_count: number; completed_task_count: number; progress_percent: number }> };
    };
    const releaseWithProgress = milestoneListBody.data.milestones.find((milestone) => milestone.id === releaseMilestone.id);
    assert.equal(releaseWithProgress?.task_count, 1);
    assert.equal(releaseWithProgress?.completed_task_count, 1);
    assert.equal(releaseWithProgress?.progress_percent, 100);

    const completeRelease = await updateMilestone(
      apiRequest(
        `${milestonesPath}/${releaseMilestone.id}`,
        "PATCH",
        { expectedVersion: 2, status: "completed" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, milestoneId: releaseMilestone.id }) },
    );
    assert.equal(completeRelease.status, 200);
    const completeReleaseBody = (await completeRelease.json()) as {
      data: { milestone: { version: number; status: string } };
    };
    assert.equal(completeReleaseBody.data.milestone.version, 3);
    assert.equal(completeReleaseBody.data.milestone.status, "completed");

    const closedMilestoneTaskUpdate = await updateTask(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${projectId}/tasks/${taskId}`,
        "PATCH",
        { expectedVersion: 2, priority: "high" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, taskId }) },
    );
    assert.equal(closedMilestoneTaskUpdate.status, 409);

    const closedMilestoneComment = await createComment(
      apiRequest(commentsPath, "POST", { body: "A completed milestone is read-only." }, owner.cookie, {
        "idempotency-key": "comment-completed-milestone-01",
      }),
      { params: Promise.resolve({ organizationId, projectId, taskId }) },
    );
    assert.equal(closedMilestoneComment.status, 409);
    const closedCommentBody = (await closedMilestoneComment.json()) as { error: { code: string } };
    assert.equal(closedCommentBody.error.code, "MILESTONE_CLOSED");

    const closedMilestoneComments = await listComments(
      apiRequest(commentsPath, "GET", undefined, owner.cookie),
      { params: Promise.resolve({ organizationId, projectId, taskId }) },
    );
    const closedCommentsBody = (await closedMilestoneComments.json()) as {
      data: { comments: Array<{ id: string }> };
    };
    assert.equal(closedMilestoneComments.status, 200);
    assert.equal(closedCommentsBody.data.comments.length, 3);
  },
);
