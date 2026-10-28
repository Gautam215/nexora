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
import { POST as summarizeMeeting } from "../src/app/api/organizations/[organizationId]/ai/summarize-meeting/route.ts";
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
  "AI scoped summaries and meeting summaries are authorized, labelled, and recorded",
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

    const owner = await registerVerifyAndLogin("ai-scoped-owner@example.test", "AI Scoped Owner", "correct horse battery staple");
    const orgResponse = await createOrganization(
      apiRequest("/api/organizations", "POST", { name: "AI Scoped Workspace", slug: "ai-scoped-workspace" }, owner.cookie),
    );
    assert.equal(orgResponse.status, 201);
    const orgId = ((await orgResponse.json()) as { data: { organization: { id: string } } }).data.organization.id;
    const projectResponse = await createProject(
      apiRequest(`/api/organizations/${orgId}/projects`, "POST", { name: "AI Scoped Project" }, owner.cookie),
      { params: Promise.resolve({ organizationId: orgId }) },
    );
    assert.equal(projectResponse.status, 201);
    const projectId = ((await projectResponse.json()) as { data: { project: { id: string } } }).data.project.id;

    // Meeting route: unauthenticated callers are rejected before any provider work.
    const anonymousMeeting = await summarizeMeeting(
      apiRequest(`/api/organizations/${orgId}/ai/summarize-meeting`, "POST", { notes: "We discussed the launch plan today." }),
      { params: Promise.resolve({ organizationId: orgId }) },
    );
    assert.equal(anonymousMeeting.status, 401);

    // No provider configured: fail closed, no fabricated summary.
    delete process.env.AI_PROVIDER;
    const unconfiguredMeeting = await summarizeMeeting(
      apiRequest(
        `/api/organizations/${orgId}/ai/summarize-meeting`,
        "POST",
        { notes: "We discussed the launch plan today." },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId: orgId }) },
    );
    assert.equal(unconfiguredMeeting.status, 503);
    assert.equal(
      ((await unconfiguredMeeting.json()) as { error: { code: string } }).error.code,
      "AI_UNAVAILABLE",
    );

    // Mock provider: labelled meeting summary plus a succeeded execution row.
    process.env.AI_PROVIDER = "mock";
    const meetingResponse = await summarizeMeeting(
      apiRequest(
        `/api/organizations/${orgId}/ai/summarize-meeting`,
        "POST",
        { notes: "We decided to launch the homepage first, then the pricing page." },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId: orgId }) },
    );
    assert.equal(meetingResponse.status, 200);
    const meetingBody = (await meetingResponse.json()) as {
      data: { summary: string; aiGenerated: boolean; executionId: string };
    };
    assert.equal(meetingBody.data.aiGenerated, true);
    assert.match(meetingBody.data.summary, /test provider/);
    assert.ok(meetingBody.data.executionId);

    // Meeting notes that are too short are rejected by validation.
    const shortNotes = await summarizeMeeting(
      apiRequest(`/api/organizations/${orgId}/ai/summarize-meeting`, "POST", { notes: "short" }, owner.cookie),
      { params: Promise.resolve({ organizationId: orgId }) },
    );
    assert.equal(shortNotes.status, 400);

    // Each project scope returns a labelled summary with the scope echoed.
    for (const scope of ["tasks", "comments", "activity", "milestones"]) {
      const scoped = await summarize(
        apiRequest(`/api/organizations/${orgId}/ai/summarize`, "POST", { projectId, scope }, owner.cookie),
        { params: Promise.resolve({ organizationId: orgId }) },
      );
      assert.equal(scoped.status, 200);
      const scopedBody = (await scoped.json()) as {
        data: { summary: string; aiGenerated: boolean; executionId: string; scope: string };
      };
      assert.equal(scopedBody.data.aiGenerated, true);
      assert.match(scopedBody.data.summary, /test provider/);
      assert.equal(scopedBody.data.scope, scope);
      assert.ok(scopedBody.data.executionId);
    }

    // No scope means the whole-project summary, as before.
    const defaultScoped = await summarize(
      apiRequest(`/api/organizations/${orgId}/ai/summarize`, "POST", { projectId }, owner.cookie),
      { params: Promise.resolve({ organizationId: orgId }) },
    );
    assert.equal(defaultScoped.status, 200);
    assert.equal(
      ((await defaultScoped.json()) as { data: { scope: string } }).data.scope,
      "project",
    );

    // An unknown scope is rejected by validation.
    const badScope = await summarize(
      apiRequest(`/api/organizations/${orgId}/ai/summarize`, "POST", { projectId, scope: "everything" }, owner.cookie),
      { params: Promise.resolve({ organizationId: orgId }) },
    );
    assert.equal(badScope.status, 400);

    // A user in another organization cannot use this org's meeting route.
    const stranger = await registerVerifyAndLogin("ai-scoped-stranger@example.test", "AI Scoped Stranger", "correct horse battery staple");
    const strangerOrg = await createOrganization(
      apiRequest("/api/organizations", "POST", { name: "AI Stranger Workspace", slug: "ai-scoped-stranger-workspace" }, stranger.cookie),
    );
    assert.equal(strangerOrg.status, 201);
    const strangerOrgId = ((await strangerOrg.json()) as { data: { organization: { id: string } } }).data.organization.id;
    const foreignMeeting = await summarizeMeeting(
      apiRequest(
        `/api/organizations/${orgId}/ai/summarize-meeting`,
        "POST",
        { notes: "We discussed the launch plan today." },
        stranger.cookie,
      ),
      { params: Promise.resolve({ organizationId: orgId }) },
    );
    assert.equal(foreignMeeting.status, 403);

    // A user in another organization cannot summarize this project
    // from their own organization: the project is invisible there.
    const crossOrgSummary = await summarize(
      apiRequest(`/api/organizations/${strangerOrgId}/ai/summarize`, "POST", { projectId, scope: "tasks" }, stranger.cookie),
      { params: Promise.resolve({ organizationId: strangerOrgId }) },
    );
    assert.equal(crossOrgSummary.status, 404);

    // And a non-member cannot even reach the organization's AI routes.
    const foreignSummary = await summarize(
      apiRequest(`/api/organizations/${orgId}/ai/summarize`, "POST", { projectId, scope: "tasks" }, stranger.cookie),
      { params: Promise.resolve({ organizationId: orgId }) },
    );
    assert.equal(foreignSummary.status, 403);

    // The meeting execution is recorded as a summarization row.
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
    const meetingExecution = executions.find((row) => row.id === meetingBody.data.executionId);
    assert.ok(meetingExecution);
    assert.equal(meetingExecution.workflow, "summarization");
    assert.equal(meetingExecution.status, "succeeded");
    assert.equal(meetingExecution.provider, "mock");
  },
);
