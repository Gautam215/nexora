import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server.js";
import { POST as acceptInvitation } from "../src/app/api/invitations/accept/route.ts";
import { POST as login } from "../src/app/api/auth/login/route.ts";
import { POST as register } from "../src/app/api/auth/register/route.ts";
import { POST as consumeVerification } from "../src/app/api/auth/verification/consume/route.ts";
import {
  GET as getOrganization,
} from "../src/app/api/organizations/[organizationId]/route.ts";
import {
  DELETE as revokeInvitation,
} from "../src/app/api/organizations/[organizationId]/invitations/[invitationId]/route.ts";
import {
  GET as getMembers,
  POST as createInvitation,
} from "../src/app/api/organizations/[organizationId]/members/route.ts";
import {
  PATCH as updateMember,
} from "../src/app/api/organizations/[organizationId]/members/[userId]/route.ts";
import { withOrganizationContext, closeDatabasePool } from "../src/server/db.ts";
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

test(
  "workspace invitations are email-bound, audited, revocable, and manager-controlled",
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

    const ownerEmail = `${randomUUID()}@example.test`;
    const ownerPassword = "owner password long enough";
    const owner = await registerVerifyAndLogin(ownerEmail, "Workspace Owner", ownerPassword);
    const organizationResponse = await (await import("../src/app/api/organizations/route.ts")).POST(
      apiRequest(
        "/api/organizations",
        "POST",
        { name: "Invitation Studio", slug: `invite-${owner.user.id.slice(0, 8)}` },
        owner.cookie,
      ),
    );
    assert.equal(organizationResponse.status, 201);
    const organizationBody = (await organizationResponse.json()) as {
      data: { organization: { id: string } };
    };
    const organizationId = organizationBody.data.organization.id;

    const invitedEmail = `${randomUUID()}@example.test`;
    const inviteResponse = await createInvitation(
      apiRequest(
        `/api/organizations/${organizationId}/members`,
        "POST",
        { email: invitedEmail, role: "member" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(inviteResponse.status, 201);
    const invitationBody = (await inviteResponse.json()) as {
      data: { invitation: { id: string; role: string }; emailAccepted: boolean };
    };
    assert.equal(invitationBody.data.emailAccepted, true);
    assert.equal(invitationBody.data.invitation.role, "member");
    const invitationToken = tokenFromMessage(
      smtp.messages.at(-1) ?? "",
      "/accept-invitation",
    );

    const ownerView = await getMembers(
      apiRequest(`/api/organizations/${organizationId}/members`, "GET", undefined, owner.cookie),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(ownerView.status, 200);
    const ownerViewBody = (await ownerView.json()) as {
      data: {
        viewerRole: string;
        viewerUserId: string;
        members: Array<{ user_id: string; role: string }>;
        invitations: Array<{ id: string; email: string }>;
      };
    };
    assert.equal(ownerViewBody.data.viewerRole, "owner");
    assert.equal(ownerViewBody.data.viewerUserId, owner.user.id);
    assert.equal(ownerViewBody.data.members.length, 1);
    assert.equal(ownerViewBody.data.invitations[0]?.email, invitedEmail);

    const invited = await registerVerifyAndLogin(
      invitedEmail,
      "Invited Teammate",
      "invited account password",
    );
    const accepted = await acceptInvitation(
      apiRequest("/api/invitations/accept", "POST", { token: invitationToken }, invited.cookie),
    );
    assert.equal(accepted.status, 200);
    const replayed = await acceptInvitation(
      apiRequest("/api/invitations/accept", "POST", { token: invitationToken }, invited.cookie),
    );
    assert.equal(replayed.status, 400);

    const acceptedView = await getMembers(
      apiRequest(`/api/organizations/${organizationId}/members`, "GET", undefined, owner.cookie),
      { params: Promise.resolve({ organizationId }) },
    );
    const acceptedViewBody = (await acceptedView.json()) as {
      data: { members: Array<{ user_id: string; role: string }>; invitations: unknown[] };
    };
    assert.equal(acceptedViewBody.data.members.length, 2);
    assert.equal(acceptedViewBody.data.invitations.length, 0);

    const promoted = await updateMember(
      apiRequest(
        `/api/organizations/${organizationId}/members/${invited.user.id}`,
        "PATCH",
        { role: "admin" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, userId: invited.user.id }) },
    );
    assert.equal(promoted.status, 200);

    const thirdEmail = `${randomUUID()}@example.test`;
    const adminInvite = await createInvitation(
      apiRequest(
        `/api/organizations/${organizationId}/members`,
        "POST",
        { email: thirdEmail, role: "guest" },
        invited.cookie,
      ),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(adminInvite.status, 201);
    const adminInviteBody = (await adminInvite.json()) as {
      data: { invitation: { id: string } };
    };
    const thirdInvitationToken = tokenFromMessage(
      smtp.messages.at(-1) ?? "",
      "/accept-invitation",
    );

    const revoked = await revokeInvitation(
      apiRequest(
        `/api/organizations/${organizationId}/invitations/${adminInviteBody.data.invitation.id}`,
        "DELETE",
        undefined,
        owner.cookie,
      ),
      {
        params: Promise.resolve({
          organizationId,
          invitationId: adminInviteBody.data.invitation.id,
        }),
      },
    );
    assert.equal(revoked.status, 200);
    const revokedAcceptance = await acceptInvitation(
      apiRequest("/api/invitations/accept", "POST", { token: thirdInvitationToken }, invited.cookie),
    );
    assert.equal(revokedAcceptance.status, 400);

    const demoted = await updateMember(
      apiRequest(
        `/api/organizations/${organizationId}/members/${invited.user.id}`,
        "PATCH",
        { role: "guest" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, userId: invited.user.id }) },
    );
    assert.equal(demoted.status, 200);
    const guestInviteAttempt = await createInvitation(
      apiRequest(
        `/api/organizations/${organizationId}/members`,
        "POST",
        { email: `${randomUUID()}@example.test`, role: "member" },
        invited.cookie,
      ),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(guestInviteAttempt.status, 403);

    const disabled = await updateMember(
      apiRequest(
        `/api/organizations/${organizationId}/members/${invited.user.id}`,
        "PATCH",
        { status: "disabled" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, userId: invited.user.id }) },
    );
    assert.equal(disabled.status, 200);
    const inaccessible = await getOrganization(
      apiRequest(`/api/organizations/${organizationId}`, "GET", undefined, invited.cookie),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(inaccessible.status, 403);

    const reenabled = await updateMember(
      apiRequest(
        `/api/organizations/${organizationId}/members/${invited.user.id}`,
        "PATCH",
        { status: "active" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, userId: invited.user.id }) },
    );
    assert.equal(reenabled.status, 200);
    const accessible = await getOrganization(
      apiRequest(`/api/organizations/${organizationId}`, "GET", undefined, invited.cookie),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(accessible.status, 200);

    const actions = await withOrganizationContext(
      owner.user.id,
      organizationId,
      async (transaction) => {
        const result = await transaction.query<{ action: string }>(
          "SELECT action FROM nexora.audit_events WHERE organization_id = $1",
          [organizationId],
        );
        return result.rows.map((row) => row.action);
      },
    );
    assert.ok(actions.includes("invitation.created"));
    assert.ok(actions.includes("invitation.accepted"));
    assert.ok(actions.includes("invitation.revoked"));
    assert.ok(actions.includes("membership.updated"));
  },
);
