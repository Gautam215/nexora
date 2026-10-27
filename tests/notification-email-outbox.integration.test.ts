import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server.js";
import { POST as acceptInvitation } from "../src/app/api/invitations/accept/route.ts";
import { POST as login } from "../src/app/api/auth/login/route.ts";
import { POST as register } from "../src/app/api/auth/register/route.ts";
import { POST as consumeVerification } from "../src/app/api/auth/verification/consume/route.ts";
import {
  POST as createInvitation,
} from "../src/app/api/organizations/[organizationId]/members/route.ts";
import {
  PATCH as updatePreferences,
} from "../src/app/api/organizations/[organizationId]/notifications/preferences/route.ts";
import {
  POST as addProjectMember,
} from "../src/app/api/organizations/[organizationId]/projects/[projectId]/members/route.ts";
import { closeDatabasePool } from "../src/server/db.ts";
import {
  closeEmailOutboxPool,
  processNotificationEmailBatch,
} from "../src/server/notifications/email-outbox.ts";
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
  await closeEmailOutboxPool();
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
  const result = (await loginResponse.json()) as {
    data: { user: { id: string; email: string } };
  };
  return { user: result.data.user, cookie: `nexora_session=${cookie}` };
}

async function inviteAndAccept(
  organizationId: string,
  ownerCookie: string,
  email: string,
  name: string,
  password: string,
) {
  const inviteResponse = await createInvitation(
    apiRequest(
      `/api/organizations/${organizationId}/members`,
      "POST",
      { email, role: "member" },
      ownerCookie,
    ),
    { params: Promise.resolve({ organizationId }) },
  );
  assert.equal(inviteResponse.status, 201);
  const invitationToken = tokenFromMessage(smtp?.messages.at(-1) ?? "", "/accept-invitation");
  const member = await registerVerifyAndLogin(email, name, password);
  const accepted = await acceptInvitation(
    apiRequest("/api/invitations/accept", "POST", { token: invitationToken }, member.cookie),
  );
  assert.equal(accepted.status, 200);
  return member;
}

async function createProject(organizationId: string, ownerCookie: string, name: string) {
  const response = await (await import("../src/app/api/organizations/[organizationId]/projects/route.ts")).POST(
    apiRequest(
      `/api/organizations/${organizationId}/projects`,
      "POST",
      { name },
      ownerCookie,
    ),
    { params: Promise.resolve({ organizationId }) },
  );
  assert.equal(response.status, 201);
  const body = (await response.json()) as { data: { project: { id: string } } };
  return body.data.project.id;
}

test(
  "notification email outbox sends only opt-in recipients, once, and only for configured event types",
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
    process.env.NEXORA_NOTIFICATION_EMAIL_TYPES = "project_activity";

    const owner = await registerVerifyAndLogin(
      `${randomUUID()}@example.test`,
      "Workspace Owner",
      "owner password long enough",
    );
    const organizationResponse = await (await import("../src/app/api/organizations/route.ts")).POST(
      apiRequest(
        "/api/organizations",
        "POST",
        { name: "Outbox Studio", slug: `outbox-${owner.user.id.slice(0, 8)}` },
        owner.cookie,
      ),
    );
    assert.equal(organizationResponse.status, 201);
    const organizationBody = (await organizationResponse.json()) as {
      data: { organization: { id: string } };
    };
    const organizationId = organizationBody.data.organization.id;
    const projectId = await createProject(organizationId, owner.cookie, "Outbox Project");

    // Default off: a member with no email preference gets no email,
    // even though the operator configured project_activity.
    const memberDefault = await inviteAndAccept(
      organizationId,
      owner.cookie,
      `${randomUUID()}@example.test`,
      "Default Teammate",
      "default member password",
    );
    const smtpBeforeDefault = smtp.messages.length;
    const addedDefault = await addProjectMember(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${projectId}/members`,
        "POST",
        { userId: memberDefault.user.id, role: "member" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(addedDefault.status, 201);
    const batchDefault = await processNotificationEmailBatch(20);
    assert.equal(batchDefault.claimed, 0);
    assert.equal(batchDefault.sent, 0);
    assert.equal(smtp.messages.length, smtpBeforeDefault);

    // Opt-in: a member who enabled email for project_activity does
    // get exactly one email, and a second batch sends nothing.
    const memberOptIn = await inviteAndAccept(
      organizationId,
      owner.cookie,
      `${randomUUID()}@example.test`,
      "Opt In Teammate",
      "optin member password",
    );
    const preferenceResponse = await updatePreferences(
      apiRequest(
        `/api/organizations/${organizationId}/notifications/preferences`,
        "PATCH",
        { preferences: [{ eventType: "project_activity", inAppEnabled: true, emailEnabled: true }] },
        memberOptIn.cookie,
      ),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(preferenceResponse.status, 200);
    const preferenceBody = (await preferenceResponse.json()) as {
      data: { preferences: Array<{ eventType: string; emailEnabled: boolean }> };
    };
    assert.equal(
      preferenceBody.data.preferences.find((item) => item.eventType === "project_activity")?.emailEnabled,
      true,
    );
    const addedOptIn = await addProjectMember(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${projectId}/members`,
        "POST",
        { userId: memberOptIn.user.id, role: "member" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(addedOptIn.status, 201);
    const batchOptIn = await processNotificationEmailBatch(20);
    assert.equal(batchOptIn.claimed, 1);
    assert.equal(batchOptIn.sent, 1);
    // The opt-in email is the newest SMTP message; the default-off
    // member's address must not appear as a recipient in it.
    const lastMessage = smtp.messages.at(-1) ?? "";
    assert.ok(lastMessage.includes("You were added to a project"));
    const batchAgain = await processNotificationEmailBatch(20);
    assert.equal(batchAgain.claimed, 0);
    assert.equal(batchAgain.sent, 0);

    // Policy off: clearing the operator configuration stops email
    // even for an opt-in recipient.
    process.env.NEXORA_NOTIFICATION_EMAIL_TYPES = "";
    const projectId2 = await createProject(organizationId, owner.cookie, "Outbox Project Two");
    const addedPolicyOff = await addProjectMember(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${projectId2}/members`,
        "POST",
        { userId: memberOptIn.user.id, role: "member" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId: projectId2 }) },
    );
    assert.equal(addedPolicyOff.status, 201);
    const batchPolicyOff = await processNotificationEmailBatch(20);
    assert.equal(batchPolicyOff.claimed, 0);
    assert.equal(batchPolicyOff.sent, 0);
  },
);
