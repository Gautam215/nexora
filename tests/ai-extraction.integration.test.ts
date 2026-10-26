import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server.js";
import { POST as register } from "../src/app/api/auth/register/route.ts";
import { POST as login } from "../src/app/api/auth/login/route.ts";
import { POST as consumeVerification } from "../src/app/api/auth/verification/consume/route.ts";
import { POST as createOrganization } from "../src/app/api/organizations/route.ts";
import { POST as createProject } from "../src/app/api/organizations/[organizationId]/projects/route.ts";
import { GET as listTasks } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/route.ts";
import { POST as generateExtraction } from "../src/app/api/organizations/[organizationId]/ai/extraction/generate/route.ts";
import { POST as confirmExtraction } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/ai/extraction/confirm/route.ts";
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
  idempotencyKey?: string,
): NextRequest {
  const headers = new Headers();
  if (method !== "GET") headers.set("origin", origin);
  if (body !== undefined) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
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

async function taskTitles(cookie: string, organizationId: string, projectId: string) {
  const response = await listTasks(
    apiRequest(`/api/organizations/${organizationId}/projects/${projectId}/tasks`, "GET", undefined, cookie),
    { params: Promise.resolve({ organizationId, projectId }) },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    data: { tasks: { id: string; title: string; description: string | null; due_date: string | null }[] };
  };
  return body.data.tasks;
}

test(
  "AI extraction generates without creating, then confirms tasks atomically with idempotency",
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

    const owner = await registerVerifyAndLogin("ai-extract-owner@example.test", "AI Extract Owner", "correct horse battery staple");
    const orgResponse = await createOrganization(
      apiRequest("/api/organizations", "POST", { name: "AI Extract Workspace", slug: "ai-extract-workspace" }, owner.cookie),
    );
    assert.equal(orgResponse.status, 201);
    const orgId = ((await orgResponse.json()) as { data: { organization: { id: string } } }).data.organization.id;
    const projectResponse = await createProject(
      apiRequest(`/api/organizations/${orgId}/projects`, "POST", { name: "Extract Target" }, owner.cookie),
      { params: Promise.resolve({ organizationId: orgId }) },
    );
    assert.equal(projectResponse.status, 201);
    const projectId = ((await projectResponse.json()) as { data: { project: { id: string } } }).data.project.id;
    const orgParams = { params: Promise.resolve({ organizationId: orgId }) };
    const projectParams = { params: Promise.resolve({ organizationId: orgId, projectId }) };
    const confirmPath = `/api/organizations/${orgId}/projects/${projectId}/ai/extraction/confirm`;

    // Unconfigured provider: fail closed, nothing created.
    delete process.env.AI_PROVIDER;
    const unconfigured = await generateExtraction(
      apiRequest(`/api/organizations/${orgId}/ai/extraction/generate`, "POST", { notes: "We discussed the launch plan today." }, owner.cookie),
      orgParams,
    );
    assert.equal(unconfigured.status, 503);
    assert.equal((await taskTitles(owner.cookie, orgId, projectId)).length, 0);

    // Mock provider: draft returned, still nothing created.
    process.env.AI_PROVIDER = "mock";
    const generated = await generateExtraction(
      apiRequest(`/api/organizations/${orgId}/ai/extraction/generate`, "POST", { notes: "We discussed the launch plan today." }, owner.cookie),
      orgParams,
    );
    assert.equal(generated.status, 200);
    const generatedBody = (await generated.json()) as {
      data: { draft: { tasks: { title: string }[]; decisions: string[] }; aiGenerated: boolean };
    };
    assert.equal(generatedBody.data.aiGenerated, true);
    assert.equal(generatedBody.data.draft.tasks[0].title, "Mock extracted task");
    assert.equal(generatedBody.data.draft.decisions[0], "Mock decision");
    assert.equal((await taskTitles(owner.cookie, orgId, projectId)).length, 0);

    // Confirm with a hand-built draft: an ISO deadline becomes a due
    // date, a named owner and a vague deadline stay as text lines —
    // nothing is invented or resolved.
    const draft = {
      tasks: [
        { title: "Design homepage", owner: "Priya", deadline: "2026-12-01" },
        { title: "Write copy", owner: null, deadline: "next Friday" },
      ],
      decisions: ["Ship the homepage first"],
      followUps: ["Priya to share mockups"],
      risks: ["Copy may slip"],
    };
    const key = "ai-extract-confirm-key-1";
    const confirmed = await confirmExtraction(
      apiRequest(confirmPath, "POST", { draft }, owner.cookie, key),
      projectParams,
    );
    assert.equal(confirmed.status, 201);
    const confirmedBody = (await confirmed.json()) as {
      data: { tasks: { id: string; title: string }[]; decisions: string[]; aiGenerated: boolean };
    };
    assert.equal(confirmedBody.data.aiGenerated, true);
    assert.equal(confirmedBody.data.tasks.length, 2);
    assert.deepEqual(confirmedBody.data.decisions, ["Ship the homepage first"]);
    const tasks = await taskTitles(owner.cookie, orgId, projectId);
    assert.equal(tasks.length, 2);
    const homepage = tasks.find((task) => task.title === "Design homepage");
    const copy = tasks.find((task) => task.title === "Write copy");
    assert.ok(homepage && copy);
    assert.equal(homepage.due_date, "2026-12-01");
    assert.match(homepage.description ?? "", /Suggested owner: Priya/);
    assert.equal(copy.due_date, null);
    assert.match(copy.description ?? "", /Suggested deadline: next Friday/);

    // Replay with the same key and body returns the same tasks.
    const replayed = await confirmExtraction(
      apiRequest(confirmPath, "POST", { draft }, owner.cookie, key),
      projectParams,
    );
    assert.equal(replayed.status, 201);
    const replayedBody = (await replayed.json()) as { data: { tasks: { id: string }[] } };
    assert.deepEqual(
      replayedBody.data.tasks.map((task) => task.id),
      confirmedBody.data.tasks.map((task) => task.id),
    );
    assert.equal((await taskTitles(owner.cookie, orgId, projectId)).length, 2);

    // Same key with a different body conflicts; missing key is a 400.
    const conflict = await confirmExtraction(
      apiRequest(confirmPath, "POST", { draft: { ...draft, decisions: ["Changed"] } }, owner.cookie, key),
      projectParams,
    );
    assert.equal(conflict.status, 409);
    const noKey = await confirmExtraction(
      apiRequest(confirmPath, "POST", { draft }, owner.cookie),
      projectParams,
    );
    assert.equal(noKey.status, 400);

    // Non-member is denied; a project from another organization is a
    // 404 even for a member of this organization.
    const outsider = await registerVerifyAndLogin("ai-extract-outsider@example.test", "AI Outsider", "correct horse battery staple");
    const outsiderConfirm = await confirmExtraction(
      apiRequest(confirmPath, "POST", { draft }, outsider.cookie, "ai-extract-outsider-1"),
      projectParams,
    );
    assert.equal(outsiderConfirm.status, 403);
    const otherOrgResponse = await createOrganization(
      apiRequest("/api/organizations", "POST", { name: "AI Extract Other", slug: "ai-extract-other" }, owner.cookie),
    );
    assert.equal(otherOrgResponse.status, 201);
    const otherOrgId = ((await otherOrgResponse.json()) as { data: { organization: { id: string } } }).data.organization.id;
    const crossTenant = await confirmExtraction(
      apiRequest(
        `/api/organizations/${otherOrgId}/projects/${projectId}/ai/extraction/confirm`,
        "POST",
        { draft },
        owner.cookie,
        "ai-extract-cross-tenant-1",
      ),
      { params: Promise.resolve({ organizationId: otherOrgId, projectId }) },
    );
    assert.equal(crossTenant.status, 404);
    assert.equal((await taskTitles(owner.cookie, orgId, projectId)).length, 2);
    delete process.env.AI_PROVIDER;
  },
);
