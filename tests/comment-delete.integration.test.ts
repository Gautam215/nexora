import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server.js";
import { POST as register } from "../src/app/api/auth/register/route.ts";
import { POST as login } from "../src/app/api/auth/login/route.ts";
import { POST as consumeVerification } from "../src/app/api/auth/verification/consume/route.ts";
import { POST as createOrganization } from "../src/app/api/organizations/route.ts";
import { POST as inviteOrganizationMember } from "../src/app/api/organizations/[organizationId]/members/route.ts";
import { POST as acceptInvitation } from "../src/app/api/invitations/accept/route.ts";
import { POST as createProject } from "../src/app/api/organizations/[organizationId]/projects/route.ts";
import { POST as addProjectMember } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/members/route.ts";
import { POST as createTask } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/route.ts";
import {
  GET as listComments,
  POST as createComment,
} from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/[taskId]/comments/route.ts";
import { DELETE as deleteComment } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/[taskId]/comments/[commentId]/route.ts";
import { GET as searchWorkspace } from "../src/app/api/organizations/[organizationId]/search/route.ts";
import { closeDatabasePool } from "../src/server/db.ts";
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
  const user = await registerVerifyAndLogin(email, "Comment User", "comment user password");
  const accepted = await acceptInvitation(
    apiRequest("/api/invitations/accept", "POST", { token }, user.cookie),
  );
  assert.equal(accepted.status, 200, await accepted.clone().text());
  return user;
}

test(
  "comment soft-delete: author and manager can delete, others cannot, list and search hide it",
  { skip: !connectionString },
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
    const owner = await registerVerifyAndLogin(
      `comment-owner-${suffix}@example.test`,
      "Comment Owner",
      "comment owner password",
    );
    const orgResponse = await createOrganization(
      apiRequest("/api/organizations", "POST", { name: `Comment Org ${suffix}`, slug: `comment-org-${suffix}` }, owner.cookie),
    );
    assert.equal(orgResponse.status, 201, await orgResponse.clone().text());
    const org = (await orgResponse.json()) as { data: { organization: { id: string } } };
    const organizationId = org.data.organization.id;

    const member = await inviteAndAccept(owner.cookie, organizationId, `comment-member-${suffix}@example.test`);
    const manager = await inviteAndAccept(owner.cookie, organizationId, `comment-manager-${suffix}@example.test`);

    const projectResponse = await createProject(
      apiRequest(`/api/organizations/${organizationId}/projects`, "POST", { name: `Comment Project ${suffix}` }, owner.cookie),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(projectResponse.status, 201, await projectResponse.clone().text());
    const project = (await projectResponse.json()) as { data: { project: { id: string } } };
    const projectId = project.data.project.id;

    for (const [user, role] of [[member, "member"], [manager, "manager"]] as const) {
      const added = await addProjectMember(
        apiRequest(`/api/organizations/${organizationId}/projects/${projectId}/members`, "POST", { userId: user.userId, role }, owner.cookie),
        { params: Promise.resolve({ organizationId, projectId }) },
      );
      assert.equal(added.status, 201, await added.clone().text());
    }

    const taskResponse = await createTask(
      apiRequest(`/api/organizations/${organizationId}/projects/${projectId}/tasks`, "POST", { title: `Comment Task ${suffix}` }, owner.cookie, { "idempotency-key": `comment-task-${suffix}` }),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(taskResponse.status, 201, await taskResponse.clone().text());
    const task = (await taskResponse.json()) as { data: { task: { id: string } } };
    const taskId = task.data.task.id;

    const commentBase = `/api/organizations/${organizationId}/projects/${projectId}/tasks/${taskId}/comments`;
    async function postComment(cookie: string, body: string, key: string) {
      const response = await createComment(
        apiRequest(commentBase, "POST", { body }, cookie, { "idempotency-key": key }),
        { params: Promise.resolve({ organizationId, projectId, taskId }) },
      );
      assert.equal(response.status, 201, await response.clone().text());
      const parsed = (await response.json()) as { data: { comment: { id: string } } };
      return parsed.data.comment.id;
    }

    const memberCommentId = await postComment(member.cookie, `membercommentmarker ${suffix}`, `comment-a-${suffix}`);
    const ownerCommentId = await postComment(owner.cookie, `ownercommentmarker ${suffix}`, `comment-b-${suffix}`);
    const managerTargetId = await postComment(member.cookie, `managerdeletesmarker ${suffix}`, `comment-c-${suffix}`);

    // A plain member cannot delete someone else's comment.
    const forbidden = await deleteComment(
      apiRequest(`${commentBase}/${ownerCommentId}`, "DELETE", undefined, member.cookie),
      { params: Promise.resolve({ organizationId, projectId, taskId, commentId: ownerCommentId }) },
    );
    assert.equal(forbidden.status, 403, await forbidden.clone().text());

    // The author can delete their own comment; the list hides it and a repeat delete 404s.
    const authorDeleted = await deleteComment(
      apiRequest(`${commentBase}/${memberCommentId}`, "DELETE", undefined, member.cookie),
      { params: Promise.resolve({ organizationId, projectId, taskId, commentId: memberCommentId }) },
    );
    assert.equal(authorDeleted.status, 200, await authorDeleted.clone().text());
    const again = await deleteComment(
      apiRequest(`${commentBase}/${memberCommentId}`, "DELETE", undefined, member.cookie),
      { params: Promise.resolve({ organizationId, projectId, taskId, commentId: memberCommentId }) },
    );
    assert.equal(again.status, 404);

    const listed = await listComments(
      apiRequest(commentBase, "GET", undefined, owner.cookie),
      { params: Promise.resolve({ organizationId, projectId, taskId }) },
    );
    assert.equal(listed.status, 200, await listed.clone().text());
    const listedData = (await listed.json()) as { data: { comments: Array<{ id: string; can_delete: boolean }> } };
    assert.ok(!listedData.data.comments.some((c) => c.id === memberCommentId));
    assert.ok(listedData.data.comments.some((c) => c.id === ownerCommentId && c.can_delete === true));
    const listedAsMember = await listComments(
      apiRequest(commentBase, "GET", undefined, member.cookie),
      { params: Promise.resolve({ organizationId, projectId, taskId }) },
    );
    assert.equal(listedAsMember.status, 200, await listedAsMember.clone().text());
    const listedAsMemberData = (await listedAsMember.json()) as { data: { comments: Array<{ id: string; can_delete: boolean }> } };
    assert.ok(listedAsMemberData.data.comments.some((c) => c.id === ownerCommentId && c.can_delete === false));

    // Workspace search hides the deleted comment too.
    const searched = await searchWorkspace(
      apiRequest(`/api/organizations/${organizationId}/search?q=membercommentmarker&type=comment`, "GET", undefined, owner.cookie),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(searched.status, 200, await searched.clone().text());
    const searchedData = (await searched.json()) as { data: { results: Array<{ id: string }> } };
    assert.ok(!searchedData.data.results.some((r) => r.id === memberCommentId));

    // A project manager can delete another member's comment.
    const managerDeleted = await deleteComment(
      apiRequest(`${commentBase}/${managerTargetId}`, "DELETE", undefined, manager.cookie),
      { params: Promise.resolve({ organizationId, projectId, taskId, commentId: managerTargetId }) },
    );
    assert.equal(managerDeleted.status, 200, await managerDeleted.clone().text());
  },
);
