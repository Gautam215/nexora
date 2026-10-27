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
import { GET as getOrganization, PATCH as updateOrganization } from "../src/app/api/organizations/[organizationId]/route.ts";
import { POST as createOrganization } from "../src/app/api/organizations/route.ts";
import { POST as createProject } from "../src/app/api/organizations/[organizationId]/projects/route.ts";
import { POST as createTask } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/route.ts";
import { POST as uploadTaskFile } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/[taskId]/files/route.ts";
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

after(async () => {
  await smtp?.close();
  await closeDatabasePool();
  if (privateFilesRoot) await rm(privateFilesRoot, { recursive: true, force: true });
  if (previousPrivateFileDirectory === undefined) delete process.env.NEXORA_PRIVATE_FILE_DIR;
  else process.env.NEXORA_PRIVATE_FILE_DIR = previousPrivateFileDirectory;
  if (previousFileSigningKey === undefined) delete process.env.NEXORA_FILE_SIGNING_KEY;
  else process.env.NEXORA_FILE_SIGNING_KEY = previousFileSigningKey;
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

function privateFileRequest(
  pathName: string,
  bytes: Uint8Array,
  filename: string,
  cookie: string,
  extraHeaders?: Record<string, string>,
): NextRequest {
  const headers = new Headers(extraHeaders);
  headers.set("origin", origin);
  headers.set("content-type", "text/plain");
  headers.set("x-file-name", encodeURIComponent(filename));
  headers.set("cookie", cookie);
  return new NextRequest(`${origin}${pathName}`, {
    method: "POST",
    headers,
    body: new Uint8Array(bytes),
  });
}

function tokenFromMessage(message: string, pathName: string): string {
  const decoded = message.replace(/=\r\n/g, "").replace(/=3D/gi, "=");
  const token = decoded.match(new RegExp(`${pathName}\\?token=([^\\s"']+)`))?.[1];
  assert.ok(token, `expected ${pathName} token in captured email`);
  return token;
}

async function registerVerifyAndLogin(email: string, name: string, password: string) {
  const registered = await register(apiRequest("/api/auth/register", "POST", { name, email, password }));
  assert.equal(registered.status, 202);
  const verificationToken = tokenFromMessage(smtp?.messages.at(-1) ?? "", "/verify-email");
  const verified = await consumeVerification(apiRequest("/api/auth/verification/consume", "POST", { token: verificationToken }));
  assert.equal(verified.status, 200);
  const loginResponse = await login(apiRequest("/api/auth/login", "POST", { email, password }));
  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get("set-cookie")?.match(/nexora_session=([^;]+)/)?.[1];
  assert.ok(cookie);
  const result = (await loginResponse.json()) as { data: { user: { id: string } } };
  return { userId: result.data.user.id, cookie: `nexora_session=${cookie}` };
}

test(
  "organization storage quota blocks uploads over quota and clears when the quota is removed",
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
    privateFilesRoot = await mkdtemp(path.join(os.tmpdir(), "nexora-quota-files-"));
    process.env.NEXORA_PRIVATE_FILE_DIR = privateFilesRoot;
    process.env.NEXORA_FILE_SIGNING_KEY = randomBytes(32).toString("hex");

    const owner = await registerVerifyAndLogin(`${randomUUID()}@example.test`, "Quota Owner", "quota owner password");
    const orgResponse = await createOrganization(
      apiRequest("/api/organizations", "POST", { name: "Quota Workspace", slug: `quota-${owner.userId.slice(0, 8)}` }, owner.cookie),
    );
    assert.equal(orgResponse.status, 201);
    const organizationId = ((await orgResponse.json()) as { data: { organization: { id: string } } }).data.organization.id;
    const orgParams = { params: Promise.resolve({ organizationId }) };

    // No quota by default.
    const initial = await getOrganization(apiRequest(`/api/organizations/${organizationId}`, "GET", undefined, owner.cookie), orgParams);
    assert.equal(initial.status, 200);
    const initialBody = (await initial.json()) as { data: { organization: { storage_quota_bytes: number | null; storage_usage_bytes: number } } };
    assert.equal(initialBody.data.organization.storage_quota_bytes, null);
    assert.equal(initialBody.data.organization.storage_usage_bytes, 0);

    // Invalid quota values are rejected by the schema.
    const zeroQuota = await updateOrganization(
      apiRequest(`/api/organizations/${organizationId}`, "PATCH", { storageQuotaBytes: 0 }, owner.cookie),
      orgParams,
    );
    assert.equal(zeroQuota.status, 400);

    // Set a 100-byte quota.
    const setQuota = await updateOrganization(
      apiRequest(`/api/organizations/${organizationId}`, "PATCH", { storageQuotaBytes: 100 }, owner.cookie),
      orgParams,
    );
    assert.equal(setQuota.status, 200, await setQuota.clone().text());
    const quotaBody = (await setQuota.json()) as { data: { organization: { storage_quota_bytes: number } } };
    assert.equal(quotaBody.data.organization.storage_quota_bytes, 100);

    const projectResponse = await createProject(
      apiRequest(`/api/organizations/${organizationId}/projects`, "POST", { name: "Quota project" }, owner.cookie),
      orgParams,
    );
    assert.equal(projectResponse.status, 201);
    const projectId = ((await projectResponse.json()) as { data: { project: { id: string } } }).data.project.id;
    const taskResponse = await createTask(
      apiRequest(`/api/organizations/${organizationId}/projects/${projectId}/tasks`, "POST", { title: "Quota task" }, owner.cookie, { "idempotency-key": "quota-task-001" }),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(taskResponse.status, 201, await taskResponse.clone().text());
    const taskId = ((await taskResponse.json()) as { data: { task: { id: string } } }).data.task.id;
    const filePath = `/api/organizations/${organizationId}/projects/${projectId}/tasks/${taskId}/files`;
    const fileParams = { params: Promise.resolve({ organizationId, projectId, taskId }) };

    // 60 bytes fits under the 100-byte quota.
    const first = await uploadTaskFile(
      privateFileRequest(filePath, Buffer.alloc(60, "a"), "first.txt", owner.cookie, { "idempotency-key": "quota-first-001" }),
      fileParams,
    );
    assert.equal(first.status, 201, await first.clone().text());

    // 60 more bytes would exceed it: blocked, and the staged bytes are cleaned up.
    const second = await uploadTaskFile(
      privateFileRequest(filePath, Buffer.alloc(60, "b"), "second.txt", owner.cookie, { "idempotency-key": "quota-second-001" }),
      fileParams,
    );
    assert.equal(second.status, 409);
    assert.equal(((await second.json()) as { error: { code: string } }).error.code, "ORGANIZATION_STORAGE_LIMIT");

    // Clearing the quota (null) unblocks uploads.
    const cleared = await updateOrganization(
      apiRequest(`/api/organizations/${organizationId}`, "PATCH", { storageQuotaBytes: null }, owner.cookie),
      orgParams,
    );
    assert.equal(cleared.status, 200, await cleared.clone().text());
    const clearedBody = (await cleared.json()) as { data: { organization: { storage_quota_bytes: number | null; storage_usage_bytes: number } } };
    assert.equal(clearedBody.data.organization.storage_quota_bytes, null);
    assert.equal(clearedBody.data.organization.storage_usage_bytes, 60);
    const third = await uploadTaskFile(
      privateFileRequest(filePath, Buffer.alloc(60, "c"), "third.txt", owner.cookie, { "idempotency-key": "quota-third-001" }),
      fileParams,
    );
    assert.equal(third.status, 201, await third.clone().text());
  },
);
