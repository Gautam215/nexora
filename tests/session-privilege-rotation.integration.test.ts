import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server.js";
import { POST as acceptInvitation } from "../src/app/api/invitations/accept/route.ts";
import { POST as login } from "../src/app/api/auth/login/route.ts";
import { POST as register } from "../src/app/api/auth/register/route.ts";
import { POST as consumeVerification } from "../src/app/api/auth/verification/consume/route.ts";
import { GET as listSessions } from "../src/app/api/auth/sessions/route.ts";
import {
  POST as createInvitation,
} from "../src/app/api/organizations/[organizationId]/members/route.ts";
import {
  PATCH as updateOrgMember,
} from "../src/app/api/organizations/[organizationId]/members/[userId]/route.ts";
import {
  POST as addProjectMember,
} from "../src/app/api/organizations/[organizationId]/projects/[projectId]/members/route.ts";
import {
  PATCH as updateProjectMember,
} from "../src/app/api/organizations/[organizationId]/projects/[projectId]/members/[userId]/route.ts";
import { closeDatabasePool } from "../src/server/db.ts";
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
): NextRequest {
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
  const verificationToken = tokenFromMessage(
    smtp?.messages.at(-1) ?? "",
    "/verify-email",
  );
  const verified = await consumeVerification(
    apiRequest("/api/auth/verification/consume", "POST", { token: verificationToken }),
  );
  assert.equal(verified.status, 200);
  return loginAs(email, password);
}

async function loginAs(email: string, password: string) {
  const loginResponse = await login(
    apiRequest("/api/auth/login", "POST", { email, password }),
  );
  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get("set-cookie")?.match(/nexora_session=([^;]+)/)?.[1];
  assert.ok(cookie);
  const result = (await loginResponse.json()) as {
    data: { user: { id: string; email: string } };
  };
  return { user: result.data.user, cookie: `nexora_session=${cookie}` };
}

async function sessionsStatus(cookie: string): Promise<number> {
  const response = await listSessions(apiRequest("/api/auth/sessions", "GET", undefined, cookie));
  return response.status;
}

test(
  "privilege changes revoke sessions on downgrade and disable, not on re-enable or project role-only change",
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
      "Workspace Owner",
      "owner password long enough",
    );
    const organizationResponse = await (await import("../src/app/api/organizations/route.ts")).POST(
      apiRequest(
        "/api/organizations",
        "POST",
        { name: "Rotation Studio", slug: `rotation-${owner.user.id.slice(0, 8)}` },
        owner.cookie,
      ),
    );
    assert.equal(organizationResponse.status, 201);
    const organizationBody = (await organizationResponse.json()) as {
      data: { organization: { id: string } };
    };
    const organizationId = organizationBody.data.organization.id;

    const memberEmail = `${randomUUID()}@example.test`;
    const memberPassword = "member password long enough";
    const inviteResponse = await createInvitation(
      apiRequest(
        `/api/organizations/${organizationId}/members`,
        "POST",
        { email: memberEmail, role: "admin" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(inviteResponse.status, 201);
    const invitationToken = tokenFromMessage(smtp.messages.at(-1) ?? "", "/accept-invitation");
    const member = await registerVerifyAndLogin(memberEmail, "Teammate", memberPassword);
    const accepted = await acceptInvitation(
      apiRequest("/api/invitations/accept", "POST", { token: invitationToken }, member.cookie),
    );
    assert.equal(accepted.status, 200);
    assert.equal(await sessionsStatus(member.cookie), 200);

    // Organization role downgrade admin -> member revokes the session.
    const downgraded = await updateOrgMember(
      apiRequest(
        `/api/organizations/${organizationId}/members/${member.user.id}`,
        "PATCH",
        { role: "member" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, userId: member.user.id }) },
    );
    assert.equal(downgraded.status, 200);
    const downgradedBody = (await downgraded.json()) as {
      data: { membership: { sessionsRevoked: number } };
    };
    assert.ok(downgradedBody.data.membership.sessionsRevoked >= 1);
    assert.equal(await sessionsStatus(member.cookie), 401);

    // Re-login, then disable: sessions are revoked again.
    const relogged = await loginAs(memberEmail, memberPassword);
    assert.equal(await sessionsStatus(relogged.cookie), 200);
    const disabled = await updateOrgMember(
      apiRequest(
        `/api/organizations/${organizationId}/members/${member.user.id}`,
        "PATCH",
        { status: "disabled" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, userId: member.user.id }) },
    );
    assert.equal(disabled.status, 200);
    assert.equal(await sessionsStatus(relogged.cookie), 401);

    // Re-enable, re-login: the new session works (re-enable alone
    // does not revoke, because there was nothing left to revoke).
    const reenabled = await updateOrgMember(
      apiRequest(
        `/api/organizations/${organizationId}/members/${member.user.id}`,
        "PATCH",
        { status: "active" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, userId: member.user.id }) },
    );
    assert.equal(reenabled.status, 200);
    const reenabledBody = (await reenabled.json()) as {
      data: { membership: { sessionsRevoked: number } };
    };
    assert.equal(reenabledBody.data.membership.sessionsRevoked, 0);
    const activeAgain = await loginAs(memberEmail, memberPassword);
    assert.equal(await sessionsStatus(activeAgain.cookie), 200);

    // Project membership: disable revokes, role-only change does not.
    const projectResponse = await (await import("../src/app/api/organizations/[organizationId]/projects/route.ts")).POST(
      apiRequest(
        `/api/organizations/${organizationId}/projects`,
        "POST",
        { name: "Rotation Project" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(projectResponse.status, 201);
    const projectBody = (await projectResponse.json()) as {
      data: { project: { id: string } };
    };
    const projectId = projectBody.data.project.id;
    const added = await addProjectMember(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${projectId}/members`,
        "POST",
        { userId: member.user.id, role: "member" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(added.status, 201);

    const projectDisabled = await updateProjectMember(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${projectId}/members/${member.user.id}`,
        "PATCH",
        { status: "disabled" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, userId: member.user.id }) },
    );
    assert.equal(projectDisabled.status, 200);
    const projectDisabledBody = (await projectDisabled.json()) as {
      data: { membership: { sessionsRevoked: number } };
    };
    assert.ok(projectDisabledBody.data.membership.sessionsRevoked >= 1);
    assert.equal(await sessionsStatus(activeAgain.cookie), 401);

    const projectReenabled = await updateProjectMember(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${projectId}/members/${member.user.id}`,
        "PATCH",
        { status: "active" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, userId: member.user.id }) },
    );
    assert.equal(projectReenabled.status, 200);
    const projectMember = await loginAs(memberEmail, memberPassword);
    const roleOnly = await updateProjectMember(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${projectId}/members/${member.user.id}`,
        "PATCH",
        { role: "viewer" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId, userId: member.user.id }) },
    );
    assert.equal(roleOnly.status, 200);
    const roleOnlyBody = (await roleOnly.json()) as {
      data: { membership: { sessionsRevoked: number } };
    };
    assert.equal(roleOnlyBody.data.membership.sessionsRevoked, 0);
    assert.equal(await sessionsStatus(projectMember.cookie), 200);
  },
);
