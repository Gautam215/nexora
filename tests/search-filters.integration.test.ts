import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { NextRequest } from "next/server.js";
import { POST as register } from "../src/app/api/auth/register/route.ts";
import { POST as login } from "../src/app/api/auth/login/route.ts";
import { POST as consumeVerification } from "../src/app/api/auth/verification/consume/route.ts";
import { POST as createOrganization } from "../src/app/api/organizations/route.ts";
import { POST as createProject } from "../src/app/api/organizations/[organizationId]/projects/route.ts";
import { PATCH as updateProject } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/route.ts";
import { POST as createTask } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/route.ts";
import { POST as createComment } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/[taskId]/comments/route.ts";
import { POST as uploadTaskFile } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/[taskId]/files/route.ts";
import { GET as search } from "../src/app/api/organizations/[organizationId]/search/route.ts";
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
let privateFilesRoot: string | undefined;
let previousPrivateFileDirectory: string | undefined;
let previousFileSigningKey: string | undefined;
let previousScanner: string | undefined;

after(async () => {
  await smtp?.close();
  await closeDatabasePool();
  if (privateFilesRoot) await rm(privateFilesRoot, { recursive: true, force: true });
  if (previousPrivateFileDirectory === undefined) delete process.env.NEXORA_PRIVATE_FILE_DIR;
  else process.env.NEXORA_PRIVATE_FILE_DIR = previousPrivateFileDirectory;
  if (previousFileSigningKey === undefined) delete process.env.NEXORA_FILE_SIGNING_KEY;
  else process.env.NEXORA_FILE_SIGNING_KEY = previousFileSigningKey;
  if (previousScanner === undefined) delete process.env.NEXORA_MALWARE_SCANNER;
  else process.env.NEXORA_MALWARE_SCANNER = previousScanner;
});

function apiRequest(
  pathName: string,
  method = "GET",
  body?: unknown,
  cookie?: string,
  extraHeaders?: Record<string, string>,
): NextRequest {
  const headers = new Headers(extraHeaders);
  if (method !== "GET") headers.set("origin", origin);
  if (body !== undefined) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  return new NextRequest(`${origin}${pathName}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function tokenFromMessage(message: string): string {
  const decoded = message.replace(/=\r\n/g, "").replace(/=3D/gi, "=");
  const token = decoded.match(/\/verify-email\?token=([A-Za-z0-9._~-]+)/)?.[1];
  assert.ok(token, "expected verification token in captured email");
  return token;
}

async function registerVerifyAndLogin(email: string, name: string, password: string) {
  const registered = await register(apiRequest("/api/auth/register", "POST", { name, email, password }));
  assert.equal(registered.status, 202);
  const verificationToken = tokenFromMessage(smtp?.messages.at(-1) ?? "");
  const verified = await consumeVerification(apiRequest("/api/auth/verification/consume", "POST", { token: verificationToken }));
  assert.equal(verified.status, 200);
  const loginResponse = await login(apiRequest("/api/auth/login", "POST", { email, password }));
  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get("set-cookie")?.match(/nexora_session=([^;]+)/)?.[1];
  assert.ok(cookie);
  const result = (await loginResponse.json()) as { data: { user: { id: string } } };
  return { userId: result.data.user.id, cookie: `nexora_session=${cookie}` };
}

interface SearchPage {
  results: Array<{ entity_type: string; title: string }>;
  pagination: { total: number };
}

async function runSearch(organizationId: string, query: string, cookie: string): Promise<SearchPage> {
  const response = await search(
    apiRequest(`/api/organizations/${organizationId}/search?${query}`, "GET", undefined, cookie),
    { params: Promise.resolve({ organizationId }) },
  );
  assert.equal(response.status, 200, await response.clone().text());
  const body = (await response.json()) as { data: SearchPage };
  return body.data;
}

test(
  "workspace search filters scope by project, person, project status, and date",
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
    previousPrivateFileDirectory = process.env.NEXORA_PRIVATE_FILE_DIR;
    previousFileSigningKey = process.env.NEXORA_FILE_SIGNING_KEY;
    previousScanner = process.env.NEXORA_MALWARE_SCANNER;
    privateFilesRoot = await mkdtemp(path.join(os.tmpdir(), "nexora-search-files-"));
    process.env.NEXORA_PRIVATE_FILE_DIR = privateFilesRoot;
    process.env.NEXORA_FILE_SIGNING_KEY = randomBytes(32).toString("hex");
    process.env.NEXORA_MALWARE_SCANNER = "none";

    const owner = await registerVerifyAndLogin(`${randomUUID()}@example.test`, "Search Owner", "search owner password");
    const orgResponse = await createOrganization(
      apiRequest("/api/organizations", "POST", { name: "Search Workspace", slug: `search-${owner.userId.slice(0, 8)}` }, owner.cookie),
    );
    assert.equal(orgResponse.status, 201);
    const organizationId = ((await orgResponse.json()) as { data: { organization: { id: string } } }).data.organization.id;

    const projectOneResponse = await createProject(
      apiRequest(`/api/organizations/${organizationId}/projects`, "POST", { name: "Launch pad" }, owner.cookie),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(projectOneResponse.status, 201);
    const projectOneId = ((await projectOneResponse.json()) as { data: { project: { id: string } } }).data.project.id;
    const activated = await updateProject(
      apiRequest(`/api/organizations/${organizationId}/projects/${projectOneId}`, "PATCH", { status: "active", expectedVersion: 1 }, owner.cookie),
      { params: Promise.resolve({ organizationId, projectId: projectOneId }) },
    );
    assert.equal(activated.status, 200, await activated.clone().text());

    const projectTwoResponse = await createProject(
      apiRequest(`/api/organizations/${organizationId}/projects`, "POST", { name: "Vault notes" }, owner.cookie),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(projectTwoResponse.status, 201);
    const projectTwoId = ((await projectTwoResponse.json()) as { data: { project: { id: string } } }).data.project.id;

    const taskResponse = await createTask(
      apiRequest(`/api/organizations/${organizationId}/projects/${projectOneId}/tasks`, "POST", { title: "Launch checklist" }, owner.cookie, { "idempotency-key": "search-task-001" }),
      { params: Promise.resolve({ organizationId, projectId: projectOneId }) },
    );
    assert.equal(taskResponse.status, 201, await taskResponse.clone().text());
    const taskId = ((await taskResponse.json()) as { data: { task: { id: string } } }).data.task.id;

    const commentResponse = await createComment(
      apiRequest(`/api/organizations/${organizationId}/projects/${projectOneId}/tasks/${taskId}/comments`, "POST", { body: "launch review notes" }, owner.cookie, { "idempotency-key": "search-comment-001" }),
      { params: Promise.resolve({ organizationId, projectId: projectOneId, taskId }) },
    );
    assert.equal(commentResponse.status, 201, await commentResponse.clone().text());

    const fileHeaders = new Headers({ origin, "content-type": "text/plain", "x-file-name": encodeURIComponent("launch brief.txt"), cookie: owner.cookie, "idempotency-key": "search-file-001" });
    const fileResponse = await uploadTaskFile(
      new NextRequest(`${origin}/api/organizations/${organizationId}/projects/${projectOneId}/tasks/${taskId}/files`, {
        method: "POST",
        headers: fileHeaders,
        body: new Uint8Array(Buffer.from("launch brief content\n")),
      }),
      { params: Promise.resolve({ organizationId, projectId: projectOneId, taskId }) },
    );
    assert.equal(fileResponse.status, 201, await fileResponse.clone().text());

    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    const plain = await runSearch(organizationId, "q=launch", owner.cookie);
    assert.equal(plain.pagination.total, 4);
    assert.deepEqual(
      plain.results.map((result) => result.entity_type).sort(),
      ["comment", "file", "project", "task"],
    );

    const otherProject = await runSearch(organizationId, `q=launch&projectId=${projectTwoId}`, owner.cookie);
    assert.equal(otherProject.pagination.total, 0);
    const ownProject = await runSearch(organizationId, `q=launch&projectId=${projectOneId}`, owner.cookie);
    assert.equal(ownProject.pagination.total, 4);

    const activeOnly = await runSearch(organizationId, "q=launch&status=active", owner.cookie);
    assert.equal(activeOnly.pagination.total, 4);
    const plannedOnly = await runSearch(organizationId, "q=launch&status=planned", owner.cookie);
    assert.equal(plannedOnly.pagination.total, 0);
    const vaultPlanned = await runSearch(organizationId, "q=vault&status=planned", owner.cookie);
    assert.equal(vaultPlanned.pagination.total, 1);
    assert.equal(vaultPlanned.results[0]?.entity_type, "project");

    // The owner filter matches a project's owner, a comment's author, and a
    // file's uploader, but not an unassigned task.
    const owned = await runSearch(organizationId, `q=launch&ownerId=${owner.userId}`, owner.cookie);
    assert.equal(owned.pagination.total, 3);
    assert.deepEqual(
      owned.results.map((result) => result.entity_type).sort(),
      ["comment", "file", "project"],
    );

    const future = await runSearch(organizationId, `q=launch&from=${tomorrow}`, owner.cookie);
    assert.equal(future.pagination.total, 0);
    const past = await runSearch(organizationId, `q=launch&to=${yesterday}`, owner.cookie);
    assert.equal(past.pagination.total, 0);
    const current = await runSearch(organizationId, `q=launch&from=${today}`, owner.cookie);
    assert.equal(current.pagination.total, 4);

    const person = await runSearch(organizationId, `q=owner&ownerId=${owner.userId}`, owner.cookie);
    assert.equal(person.pagination.total, 1);
    assert.equal(person.results[0]?.entity_type, "member");
    assert.equal(person.results[0]?.title, "Search Owner");

    // Member-only searches must not fail on the unreferenced status parameter.
    const memberOnly = await runSearch(organizationId, "q=owner&type=member", owner.cookie);
    assert.equal(memberOnly.pagination.total, 1);
    assert.equal(memberOnly.results[0]?.entity_type, "member");

    const invalidRange = await search(
      apiRequest(`/api/organizations/${organizationId}/search?q=launch&from=${tomorrow}&to=${yesterday}`, "GET", undefined, owner.cookie),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(invalidRange.status, 400);
  },
);
