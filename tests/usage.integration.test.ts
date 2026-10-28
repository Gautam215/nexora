import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server.js";
import { POST as register } from "../src/app/api/auth/register/route.ts";
import { POST as login } from "../src/app/api/auth/login/route.ts";
import { POST as consumeVerification } from "../src/app/api/auth/verification/consume/route.ts";
import { POST as createOrganization } from "../src/app/api/organizations/route.ts";
import { POST as createProject } from "../src/app/api/organizations/[organizationId]/projects/route.ts";
import { POST as summarize } from "../src/app/api/organizations/[organizationId]/ai/summarize/route.ts";
import { POST as createInvitation } from "../src/app/api/organizations/[organizationId]/members/route.ts";
import { POST as acceptInvitation } from "../src/app/api/invitations/accept/route.ts";
import { GET as getUsage } from "../src/app/api/organizations/[organizationId]/usage/route.ts";
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

function apiRequest(path: string, method = "GET", body?: unknown, cookie?: string): NextRequest {
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
  // Note: this is a RegExp constructor string, not a regex literal,
  // so the ? needs a double backslash here to reach the regex as \?.
  const token = decoded.match(new RegExp(`${pathname}\\?token=([A-Za-z0-9._~-]+)`))?.[1];
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
  return `nexora_session=${cookie}`;
}

test(
  "organization usage is owner/admin-only and reports storage plus AI token usage",
  { skip: !connectionString },
  async () => {
    smtp = await startSmtpCaptureServer();
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_FROM = "noreply@nexora.example.test";
    process.env.SMTP_PORT = String(smtp.port);
    process.env.SMTP_SECURE = "false";
    process.env.SMTP_REQUIRE_TLS = "false";
    process.env.SMTP_USER = "";
    process.env.SMTP_PASSWORD = "";
    process.env.AI_PROVIDER = "mock";

    const ownerCookie = await registerVerifyAndLogin(
      "usage-owner@example.test",
      "Usage Owner",
      "correct horse battery staple",
    );
    const orgResponse = await createOrganization(
      apiRequest("/api/organizations", "POST", { name: "Usage Workspace", slug: "usage-workspace" }, ownerCookie),
    );
    assert.equal(orgResponse.status, 201);
    const orgId = ((await orgResponse.json()) as { data: { organization: { id: string } } }).data.organization.id;
    const projectResponse = await createProject(
      apiRequest(`/api/organizations/${orgId}/projects`, "POST", { name: "Usage Project" }, ownerCookie),
      { params: Promise.resolve({ organizationId: orgId }) },
    );
    assert.equal(projectResponse.status, 201);
    const projectId = ((await projectResponse.json()) as { data: { project: { id: string } } }).data.project.id;

    // Empty usage: no files, no quota env default, no AI executions yet.
    const empty = await getUsage(apiRequest(`/api/organizations/${orgId}/usage`, "GET", undefined, ownerCookie), {
      params: Promise.resolve({ organizationId: orgId }),
    });
    assert.equal(empty.status, 200);
    const emptyBody = (await empty.json()) as {
      data: {
        usage: {
          storage: { bytes: number; files: number; quotaBytes: number | null };
          ai: { allTime: unknown[]; last30Days: unknown[] };
        };
      };
    };
    assert.equal(emptyBody.data.usage.storage.bytes, 0);
    assert.equal(emptyBody.data.usage.storage.files, 0);
    assert.equal(emptyBody.data.usage.storage.quotaBytes, null);
    assert.deepEqual(emptyBody.data.usage.ai.allTime, []);
    assert.deepEqual(emptyBody.data.usage.ai.last30Days, []);

    // One mock summary run appears in both windows with its tokens.
    const summary = await summarize(
      apiRequest(`/api/organizations/${orgId}/ai/summarize`, "POST", { projectId }, ownerCookie),
      { params: Promise.resolve({ organizationId: orgId }) },
    );
    assert.equal(summary.status, 200);
    const used = await getUsage(apiRequest(`/api/organizations/${orgId}/usage`, "GET", undefined, ownerCookie), {
      params: Promise.resolve({ organizationId: orgId }),
    });
    assert.equal(used.status, 200);
    const usedBody = (await used.json()) as {
      data: {
        usage: {
          ai: {
            allTime: { workflow: string; executions: number; promptTokens: number; completionTokens: number }[];
            last30Days: { workflow: string; executions: number; promptTokens: number; completionTokens: number }[];
          };
        };
      };
    };
    assert.equal(usedBody.data.usage.ai.allTime.length, 1);
    assert.equal(usedBody.data.usage.ai.allTime[0].workflow, "summarization");
    assert.equal(usedBody.data.usage.ai.allTime[0].executions, 1);
    assert.equal(usedBody.data.usage.ai.allTime[0].completionTokens, 24);
    assert.ok(usedBody.data.usage.ai.allTime[0].promptTokens > 0);
    assert.equal(usedBody.data.usage.ai.last30Days.length, 1);

    // A stranger outside the organization cannot read usage at all.
    const strangerCookie = await registerVerifyAndLogin(
      "usage-stranger@example.test",
      "Usage Stranger",
      "correct horse battery staple",
    );
    const foreign = await getUsage(apiRequest(`/api/organizations/${orgId}/usage`, "GET", undefined, strangerCookie), {
      params: Promise.resolve({ organizationId: orgId }),
    });
    assert.equal(foreign.status, 403);

    // An invited member (non-admin) gets the management-required error.
    // The member and admin register first, then accept their invites.
    const memberCookie = await registerVerifyAndLogin(
      "usage-member@example.test",
      "Usage Member",
      "correct horse battery staple",
    );
    const adminCookie = await registerVerifyAndLogin(
      "usage-admin@example.test",
      "Usage Admin",
      "correct horse battery staple",
    );
    const inviteResponse = await createInvitation(
      apiRequest(
        `/api/organizations/${orgId}/members`,
        "POST",
        { email: "usage-member@example.test", role: "member" },
        ownerCookie,
      ),
      { params: Promise.resolve({ organizationId: orgId }) },
    );
    assert.equal(inviteResponse.status, 201);
    const invitationToken = tokenFromMessage(smtp?.messages.at(-1) ?? "", "/accept-invitation");
    const accepted = await acceptInvitation(
      apiRequest("/api/invitations/accept", "POST", { token: invitationToken }, memberCookie),
    );
    assert.equal(accepted.status, 200);
    const memberUsage = await getUsage(apiRequest(`/api/organizations/${orgId}/usage`, "GET", undefined, memberCookie), {
      params: Promise.resolve({ organizationId: orgId }),
    });
    assert.equal(memberUsage.status, 403);
    assert.equal(
      ((await memberUsage.json()) as { error: { code: string } }).error.code,
      "ORGANIZATION_MANAGEMENT_REQUIRED",
    );

    // An invited admin can read usage.
    const adminInvite = await createInvitation(
      apiRequest(
        `/api/organizations/${orgId}/members`,
        "POST",
        { email: "usage-admin@example.test", role: "admin" },
        ownerCookie,
      ),
      { params: Promise.resolve({ organizationId: orgId }) },
    );
    assert.equal(adminInvite.status, 201);
    const adminToken = tokenFromMessage(smtp?.messages.at(-1) ?? "", "/accept-invitation");
    const adminAccepted = await acceptInvitation(
      apiRequest("/api/invitations/accept", "POST", { token: adminToken }, adminCookie),
    );
    assert.equal(adminAccepted.status, 200);
    const adminUsage = await getUsage(apiRequest(`/api/organizations/${orgId}/usage`, "GET", undefined, adminCookie), {
      params: Promise.resolve({ organizationId: orgId }),
    });
    assert.equal(adminUsage.status, 200);
    delete process.env.AI_PROVIDER;
  },
);
