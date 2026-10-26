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
import { GET as listExecutions } from "../src/app/api/organizations/[organizationId]/ai/executions/route.ts";
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

function tokenFromMessage(message: string): string {
  const decoded = message.replace(/=\r\n/g, "").replace(/=3D/gi, "=");
  const token = decoded.match(/\/verify-email\?token=([A-Za-z0-9._~-]+)/)?.[1];
  assert.ok(token);
  return token;
}

async function registerVerifyAndLogin(email: string, name: string, password: string) {
  const registered = await register(apiRequest("/api/auth/register", "POST", { name, email, password }));
  assert.equal(registered.status, 202);
  const verificationToken = tokenFromMessage(smtp?.messages.at(-1) ?? "");
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
  "AI summarization is authorized, labelled, and recorded",
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

    const owner = await registerVerifyAndLogin("ai-owner@example.test", "AI Owner", "correct horse battery staple");
    const orgResponse = await createOrganization(
      apiRequest("/api/organizations", "POST", { name: "AI Workspace", slug: "ai-workspace" }, owner.cookie),
    );
    assert.equal(orgResponse.status, 201);
    const orgId = ((await orgResponse.json()) as { data: { organization: { id: string } } }).data.organization.id;
    const projectResponse = await createProject(
      apiRequest(`/api/organizations/${orgId}/projects`, "POST", { name: "AI Project" }, owner.cookie),
      { params: Promise.resolve({ organizationId: orgId }) },
    );
    assert.equal(projectResponse.status, 201);
    const projectId = ((await projectResponse.json()) as { data: { project: { id: string } } }).data.project.id;

    // Unauthenticated callers are rejected before any provider work.
    const anonymous = await summarize(
      apiRequest(`/api/organizations/${orgId}/ai/summarize`, "POST", { projectId }),
      { params: Promise.resolve({ organizationId: orgId }) },
    );
    assert.equal(anonymous.status, 401);

    // No provider configured: fail closed, no fabricated summary.
    delete process.env.AI_PROVIDER;
    const unconfigured = await summarize(
      apiRequest(`/api/organizations/${orgId}/ai/summarize`, "POST", { projectId }, owner.cookie),
      { params: Promise.resolve({ organizationId: orgId }) },
    );
    assert.equal(unconfigured.status, 503);
    assert.equal(
      ((await unconfigured.json()) as { error: { code: string } }).error.code,
      "AI_UNAVAILABLE",
    );

    // Mock provider: labelled summary plus a succeeded execution row.
    process.env.AI_PROVIDER = "mock";
    const response = await summarize(
      apiRequest(`/api/organizations/${orgId}/ai/summarize`, "POST", { projectId }, owner.cookie),
      { params: Promise.resolve({ organizationId: orgId }) },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      data: { summary: string; aiGenerated: boolean; executionId: string };
    };
    assert.equal(body.data.aiGenerated, true);
    assert.match(body.data.summary, /test provider/);
    assert.ok(body.data.executionId);

    const executionsResponse = await listExecutions(
      apiRequest(`/api/organizations/${orgId}/ai/executions`, "GET", undefined, owner.cookie),
      { params: Promise.resolve({ organizationId: orgId }) },
    );
    assert.equal(executionsResponse.status, 200);
    const executions = (
      (await executionsResponse.json()) as {
        data: { executions: { id: string; workflow: string; status: string; provider: string }[] };
      }
    ).data.executions;
    assert.equal(executions.length, 1);
    assert.equal(executions[0].id, body.data.executionId);
    assert.equal(executions[0].workflow, "summarization");
    assert.equal(executions[0].status, "succeeded");
    assert.equal(executions[0].provider, "mock");

    // A user in another organization cannot summarize this project:
    // the project is invisible outside its organization.
    const outsider = await registerVerifyAndLogin("ai-outsider@example.test", "AI Outsider", "correct horse battery staple");
    const outsiderOrg = await createOrganization(
      apiRequest("/api/organizations", "POST", { name: "Other Workspace", slug: "ai-other-workspace" }, outsider.cookie),
    );
    assert.equal(outsiderOrg.status, 201);
    const outsiderOrgId = ((await outsiderOrg.json()) as { data: { organization: { id: string } } }).data.organization.id;
    const crossOrg = await summarize(
      apiRequest(`/api/organizations/${outsiderOrgId}/ai/summarize`, "POST", { projectId }, outsider.cookie),
      { params: Promise.resolve({ organizationId: outsiderOrgId }) },
    );
    assert.equal(crossOrg.status, 404);
    // And a non-member cannot even reach the organization's AI routes.
    const nonMember = await summarize(
      apiRequest(`/api/organizations/${orgId}/ai/summarize`, "POST", { projectId }, outsider.cookie),
      { params: Promise.resolve({ organizationId: orgId }) },
    );
    assert.equal(nonMember.status, 403);
    delete process.env.AI_PROVIDER;
  },
);
