import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server.js";
import { POST as register } from "../src/app/api/auth/register/route.ts";
import { POST as login } from "../src/app/api/auth/login/route.ts";
import { POST as consumeVerification } from "../src/app/api/auth/verification/consume/route.ts";
import { POST as createOrganization } from "../src/app/api/organizations/route.ts";
import { POST as createProject } from "../src/app/api/organizations/[organizationId]/projects/route.ts";
import { POST as analyzeRisk } from "../src/app/api/organizations/[organizationId]/ai/risk/route.ts";
import { POST as askAssistant } from "../src/app/api/organizations/[organizationId]/ai/assistant/route.ts";
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
  return { cookie: `nexora_session=${cookie}` };
}

test(
  "AI risk analysis and project assistant are authorized, labelled, and recorded",
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

    const owner = await registerVerifyAndLogin("ai-risk-owner@example.test", "AI Risk Owner", "correct horse battery staple");
    const orgResponse = await createOrganization(
      apiRequest("/api/organizations", "POST", { name: "AI Risk Workspace", slug: "ai-risk-workspace" }, owner.cookie),
    );
    assert.equal(orgResponse.status, 201);
    const orgId = ((await orgResponse.json()) as { data: { organization: { id: string } } }).data.organization.id;
    const projectResponse = await createProject(
      apiRequest(`/api/organizations/${orgId}/projects`, "POST", { name: "Risk Target" }, owner.cookie),
      { params: Promise.resolve({ organizationId: orgId }) },
    );
    assert.equal(projectResponse.status, 201);
    const projectId = ((await projectResponse.json()) as { data: { project: { id: string } } }).data.project.id;
    const params = { params: Promise.resolve({ organizationId: orgId }) };
    const riskPath = `/api/organizations/${orgId}/ai/risk`;
    const assistantPath = `/api/organizations/${orgId}/ai/assistant`;

    // Anonymous is rejected before any provider work.
    const anonymous = await analyzeRisk(apiRequest(riskPath, "POST", { projectId }), params);
    assert.equal(anonymous.status, 401);

    // Unconfigured provider fails closed with no execution recorded.
    delete process.env.AI_PROVIDER;
    const unconfigured = await analyzeRisk(
      apiRequest(riskPath, "POST", { projectId }, owner.cookie),
      params,
    );
    assert.equal(unconfigured.status, 503);
    const executionsBefore = await listExecutions(
      apiRequest(`/api/organizations/${orgId}/ai/executions`, "GET", undefined, owner.cookie),
      params,
    );
    const executionsBeforeBody = (await executionsBefore.json()) as { data: { executions: unknown[] } };
    assert.equal(executionsBeforeBody.data.executions.length, 0);

    // Mock provider: labelled risks, and a succeeded execution row.
    process.env.AI_PROVIDER = "mock";
    const analyzed = await analyzeRisk(
      apiRequest(riskPath, "POST", { projectId }, owner.cookie),
      params,
    );
    assert.equal(analyzed.status, 200);
    const analyzedBody = (await analyzed.json()) as {
      data: { risks: { title: string; severity: string }[]; aiGenerated: boolean; executionId: string };
    };
    assert.equal(analyzedBody.data.aiGenerated, true);
    assert.equal(analyzedBody.data.risks[0].title, "Mock risk");
    assert.equal(analyzedBody.data.risks[0].severity, "medium");
    const executionsAfter = await listExecutions(
      apiRequest(`/api/organizations/${orgId}/ai/executions`, "GET", undefined, owner.cookie),
      params,
    );
    const executionsAfterBody = (await executionsAfter.json()) as {
      data: { executions: { id: string; workflow: string; status: string }[] };
    };
    const riskRow = executionsAfterBody.data.executions.find((row) => row.id === analyzedBody.data.executionId);
    assert.equal(riskRow?.workflow, "risk");
    assert.equal(riskRow?.status, "succeeded");

    // Assistant: labelled free-text answer from the same gates.
    const answered = await askAssistant(
      apiRequest(assistantPath, "POST", { projectId, question: "What is the status?" }, owner.cookie),
      params,
    );
    assert.equal(answered.status, 200);
    const answeredBody = (await answered.json()) as { data: { answer: string; aiGenerated: boolean } };
    assert.equal(answeredBody.data.aiGenerated, true);
    assert.ok(answeredBody.data.answer.length > 0);

    // Validation and authorization boundaries.
    const tooLong = await askAssistant(
      apiRequest(assistantPath, "POST", { projectId, question: "x".repeat(1001) }, owner.cookie),
      params,
    );
    assert.equal(tooLong.status, 400);
    const outsider = await registerVerifyAndLogin("ai-risk-outsider@example.test", "AI Outsider", "correct horse battery staple");
    const outsiderRisk = await analyzeRisk(
      apiRequest(riskPath, "POST", { projectId }, outsider.cookie),
      params,
    );
    assert.equal(outsiderRisk.status, 403);
    const otherOrgResponse = await createOrganization(
      apiRequest("/api/organizations", "POST", { name: "AI Risk Other", slug: "ai-risk-other" }, owner.cookie),
    );
    assert.equal(otherOrgResponse.status, 201);
    const otherOrgId = ((await otherOrgResponse.json()) as { data: { organization: { id: string } } }).data.organization.id;
    const crossOrg = await analyzeRisk(
      apiRequest(`/api/organizations/${otherOrgId}/ai/risk`, "POST", { projectId }, owner.cookie),
      { params: Promise.resolve({ organizationId: otherOrgId }) },
    );
    assert.equal(crossOrg.status, 404);
    delete process.env.AI_PROVIDER;
  },
);
