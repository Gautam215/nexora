import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server.js";
import { POST as register } from "../src/app/api/auth/register/route.ts";
import { POST as login } from "../src/app/api/auth/login/route.ts";
import { POST as consumeVerification } from "../src/app/api/auth/verification/consume/route.ts";
import { POST as createOrganization } from "../src/app/api/organizations/route.ts";
import {
  GET as getOrganization,
  PATCH as updateOrganization,
} from "../src/app/api/organizations/[organizationId]/route.ts";
import { POST as inviteOrganizationMember } from "../src/app/api/organizations/[organizationId]/members/route.ts";
import { PATCH as updateOrganizationMember } from "../src/app/api/organizations/[organizationId]/members/[userId]/route.ts";
import { POST as acceptInvitation } from "../src/app/api/invitations/accept/route.ts";
import { POST as createProject } from "../src/app/api/organizations/[organizationId]/projects/route.ts";
import { POST as addProjectMember } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/members/route.ts";
import { PATCH as updateProjectMember } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/members/[userId]/route.ts";
import { POST as createTask } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/route.ts";
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

// Quoted-printable soft line breaks are "=" followed by CR LF; splitting on
// the two characters avoids backslash-escaping pitfalls in this file.
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

async function inviteAndAccept(
  ownerCookie: string,
  organizationId: string,
  email: string,
  role: "member" | "guest",
) {
  const invite = await inviteOrganizationMember(
    apiRequest(`/api/organizations/${organizationId}/members`, "POST", { email, role }, ownerCookie),
    { params: Promise.resolve({ organizationId }) },
  );
  assert.equal(invite.status, 201, await invite.clone().text());
  const token = tokenFromMessage(smtp?.messages.at(-1) ?? "", "/accept-invitation");
  const user = await registerVerifyAndLogin(email, "Matrix User", "matrix user password");
  const accepted = await acceptInvitation(
    apiRequest("/api/invitations/accept", "POST", { token }, user.cookie),
  );
  assert.equal(accepted.status, 200, await accepted.clone().text());
  return user;
}

test(
  "authorization matrix: org roles, project roles, non-members, and disabled members",
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
      "Matrix Owner",
      "matrix owner password",
    );
    const orgResponse = await createOrganization(
      apiRequest("/api/organizations", "POST", { name: "Matrix Workspace", slug: `authz-${owner.userId.slice(0, 8)}` }, owner.cookie),
    );
    assert.equal(orgResponse.status, 201);
    const organizationId = ((await orgResponse.json()) as { data: { organization: { id: string } } }).data.organization.id;

    const member = await inviteAndAccept(owner.cookie, organizationId, `${randomUUID()}@example.test`, "member");
    const guest = await inviteAndAccept(owner.cookie, organizationId, `${randomUUID()}@example.test`, "guest");
    const stranger = await registerVerifyAndLogin(
      `${randomUUID()}@example.test`,
      "Matrix Stranger",
      "matrix stranger password",
    );

    // Non-member: every organization route denies before business logic.
    const strangerRead = await getOrganization(
      apiRequest(`/api/organizations/${organizationId}`, "GET", undefined, stranger.cookie),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(strangerRead.status, 403);

    // Org member (not admin) cannot change organization settings.
    const memberSettings = await updateOrganization(
      apiRequest(`/api/organizations/${organizationId}`, "PATCH", { name: "Renamed", slug: `authz-${owner.userId.slice(0, 8)}`, storageQuotaBytes: null }, member.cookie),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(memberSettings.status, 403);

    // Org member (not admin) cannot change another member's role.
    const memberRoleChange = await updateOrganizationMember(
      apiRequest(`/api/organizations/${organizationId}/members/${guest.userId}`, "PATCH", { role: "member" }, member.cookie),
      { params: Promise.resolve({ organizationId, userId: guest.userId }) },
    );
    assert.equal(memberRoleChange.status, 403);

    // Org guest cannot create projects (member gate).
    const guestProject = await createProject(
      apiRequest(`/api/organizations/${organizationId}/projects`, "POST", { name: "Guest Project" }, guest.cookie),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(guestProject.status, 403);

    // Org member can create a project.
    const projectResponse = await createProject(
      apiRequest(`/api/organizations/${organizationId}/projects`, "POST", { name: "Matrix Project" }, member.cookie),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(projectResponse.status, 201, await projectResponse.clone().text());
    const projectId = ((await projectResponse.json()) as { data: { project: { id: string } } }).data.project.id;

    // Project viewer: read-only. Task creation is denied with 403, not a leak.
    const viewerAdded = await addProjectMember(
      apiRequest(`/api/organizations/${organizationId}/projects/${projectId}/members`, "POST", { userId: guest.userId, role: "viewer" }, owner.cookie),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(viewerAdded.status, 201, await viewerAdded.clone().text());
    const viewerTask = await createTask(
      apiRequest(`/api/organizations/${organizationId}/projects/${projectId}/tasks`, "POST", { title: "Viewer task" }, guest.cookie, { "idempotency-key": `authz-viewer-${randomUUID()}` }),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(viewerTask.status, 403);

    // Project member: task creation works.
    const memberTask = await createTask(
      apiRequest(`/api/organizations/${organizationId}/projects/${projectId}/tasks`, "POST", { title: "Member task" }, member.cookie, { "idempotency-key": `authz-member-${randomUUID()}` }),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(memberTask.status, 201, await memberTask.clone().text());

    // Promoting the viewer to member upgrades their write access.
    const promoted = await updateProjectMember(
      apiRequest(`/api/organizations/${organizationId}/projects/${projectId}/members/${guest.userId}`, "PATCH", { role: "member" }, owner.cookie),
      { params: Promise.resolve({ organizationId, projectId, userId: guest.userId }) },
    );
    assert.equal(promoted.status, 200, await promoted.clone().text());
    const promotedTask = await createTask(
      apiRequest(`/api/organizations/${organizationId}/projects/${projectId}/tasks`, "POST", { title: "Promoted task" }, guest.cookie, { "idempotency-key": `authz-promoted-${randomUUID()}` }),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(promotedTask.status, 201, await promotedTask.clone().text());

    // Disabled org membership loses access. The session itself is
    // revoked on disable, so the old cookie is unauthenticated (401)
    // rather than merely denied (403); the 403 shape is covered above
    // by the stranger case, where the session stays valid.
    const disabled = await updateOrganizationMember(
      apiRequest(`/api/organizations/${organizationId}/members/${member.userId}`, "PATCH", { status: "disabled" }, owner.cookie),
      { params: Promise.resolve({ organizationId, userId: member.userId }) },
    );
    assert.equal(disabled.status, 200, await disabled.clone().text());
    const disabledRead = await getOrganization(
      apiRequest(`/api/organizations/${organizationId}`, "GET", undefined, member.cookie),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(disabledRead.status, 401);
  },
);
