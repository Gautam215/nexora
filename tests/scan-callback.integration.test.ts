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
import { POST as createTask } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/route.ts";
import { POST as uploadTaskFile } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/[taskId]/files/route.ts";
import {
  DELETE as deleteTaskFile,
  GET as getTaskFile,
  PUT as replaceTaskFile,
} from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/[taskId]/files/[fileId]/route.ts";
import { POST as scanCallback } from "../src/app/api/internal/scan-result/route.ts";
import { closeDatabasePool } from "../src/server/db.ts";
import { startSmtpCaptureServer, type SmtpCapture } from "./smtp-server.ts";

// Scan-result callback integration tests (migration 0064).
// Uploads run with no scanner configured, so every row starts
// 'pending'; the callback is then exercised directly for each
// verdict and failure mode, and the download gate (signed-link
// issuance) proves what the user can actually download.

const connectionString = process.env.NEXORA_TEST_DATABASE_URL;
const origin = "http://localhost:3000";
const runtimeEnvironment = process.env as unknown as Record<string, string | undefined>;
if (connectionString) process.env.DATABASE_URL = connectionString;
runtimeEnvironment.NODE_ENV = "test";
process.env.APP_ORIGIN = origin;
process.env.AUTH_RATE_LIMIT_HMAC_KEY = randomBytes(32).toString("hex");
delete process.env.NEXORA_TRUSTED_CLIENT_IP_HEADER;

const CALLBACK_SECRET = randomBytes(32).toString("hex");

let smtp: SmtpCapture | undefined;
let privateFilesRoot: string | undefined;
let previousPrivateFileDirectory: string | undefined;
let previousFileSigningKey: string | undefined;
let previousScanner: string | undefined;
let previousCallbackSecret: string | undefined;

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
  if (previousCallbackSecret === undefined) delete process.env.NEXORA_SCAN_WEBHOOK_SECRET;
  else process.env.NEXORA_SCAN_WEBHOOK_SECRET = previousCallbackSecret;
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

function replaceFileRequest(
  pathName: string,
  bytes: Uint8Array,
  filename: string,
  cookie: string,
  version: number,
): NextRequest {
  const headers = new Headers();
  headers.set("origin", origin);
  headers.set("content-type", "text/plain");
  headers.set("x-file-name", encodeURIComponent(filename));
  headers.set("cookie", cookie);
  headers.set("if-match", `"${version}"`);
  return new NextRequest(`${origin}${pathName}`, {
    method: "PUT",
    headers,
    body: new Uint8Array(bytes),
  });
}

function callbackRequest(
  body: unknown,
  secret: string | null,
): NextRequest {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  if (secret !== null) headers.set("x-nexora-scan-secret", secret);
  return new NextRequest(`${origin}/api/internal/scan-result`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function tokenFromMessage(message: string, pathName: string): string {
  const decoded = message.split("=" + String.fromCharCode(13, 10)).join("").replace(/=3D/gi, "=");
  const marker = `${pathName}?token=`;
  const start = decoded.indexOf(marker);
  assert.ok(start >= 0, `expected ${pathName} token in captured email`);
  const token = decoded.slice(start + marker.length).split(/[^A-Za-z0-9._~-]/)[0];
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
  "scan callbacks move pending files to clean or quarantined, and stale, duplicate, and unauthorized callbacks change nothing",
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
    privateFilesRoot = await mkdtemp(path.join(os.tmpdir(), "nexora-callback-files-"));
    process.env.NEXORA_PRIVATE_FILE_DIR = privateFilesRoot;
    process.env.NEXORA_FILE_SIGNING_KEY = randomBytes(32).toString("hex");
    previousScanner = process.env.NEXORA_MALWARE_SCANNER;
    delete process.env.NEXORA_MALWARE_SCANNER;
    previousCallbackSecret = process.env.NEXORA_SCAN_WEBHOOK_SECRET;
    process.env.NEXORA_SCAN_WEBHOOK_SECRET = CALLBACK_SECRET;

    const owner = await registerVerifyAndLogin(`${randomUUID()}@example.test`, "Callback Owner", "callback owner password");
    const orgResponse = await createOrganization(
      apiRequest("/api/organizations", "POST", { name: "Callback Workspace", slug: `callback-${owner.userId.slice(0, 8)}` }, owner.cookie),
    );
    assert.equal(orgResponse.status, 201);
    const organizationId = ((await orgResponse.json()) as { data: { organization: { id: string } } }).data.organization.id;
    const projectResponse = await createProject(
      apiRequest(`/api/organizations/${organizationId}/projects`, "POST", { name: "Callback project" }, owner.cookie),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(projectResponse.status, 201);
    const projectId = ((await projectResponse.json()) as { data: { project: { id: string } } }).data.project.id;
    const taskResponse = await createTask(
      apiRequest(`/api/organizations/${organizationId}/projects/${projectId}/tasks`, "POST", { title: "Callback task" }, owner.cookie, { "idempotency-key": "callback-task-001" }),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(taskResponse.status, 201, await taskResponse.clone().text());
    const taskId = ((await taskResponse.json()) as { data: { task: { id: string } } }).data.task.id;
    const filePath = `/api/organizations/${organizationId}/projects/${projectId}/tasks/${taskId}/files`;
    const fileParams = { params: Promise.resolve({ organizationId, projectId, taskId }) };
    const fileParamsFor = (fileId: string) => ({
      params: Promise.resolve({ organizationId, projectId, taskId, fileId }),
    });

    async function upload(name: string, key: string) {
      const response = await uploadTaskFile(
        privateFileRequest(filePath, Buffer.from(`content for ${name}\n`), name, owner.cookie, { "idempotency-key": key }),
        fileParams,
      );
      assert.equal(response.status, 201, await response.clone().text());
      const body = (await response.json()) as { data: { file: { id: string; version: number; scan_status: string } } };
      assert.equal(body.data.file.scan_status, "pending");
      return body.data.file;
    }

    async function linkStatus(fileId: string) {
      const response = await getTaskFile(
        apiRequest(`${filePath}/${fileId}`, "GET", undefined, owner.cookie),
        fileParamsFor(fileId),
      );
      const body = (await response.json()) as { data?: unknown; error?: { code: string } };
      return { status: response.status, code: body.error?.code };
    }

    async function callback(fileId: string, version: number, outcome: string, runId: string, secret: string | null = CALLBACK_SECRET) {
      return scanCallback(callbackRequest({ fileId, version, outcome, runId }, secret));
    }

    // Clean callback: pending -> clean, and the download gate opens.
    const cleanFile = await upload("clean.txt", "callback-clean-001");
    assert.deepEqual(await linkStatus(cleanFile.id), { status: 409, code: "FILE_SCAN_PENDING" });
    const cleanResponse = await callback(cleanFile.id, cleanFile.version, "clean", "run-clean-1");
    assert.equal(cleanResponse.status, 200);
    assert.equal(((await cleanResponse.json()) as { data: { ok: boolean } }).data.ok, true);
    assert.equal((await linkStatus(cleanFile.id)).status, 200);

    // Duplicate delivery of the same verdict is a no-op, still 200.
    const duplicate = await callback(cleanFile.id, cleanFile.version, "clean", "run-clean-1");
    assert.equal(duplicate.status, 200);
    assert.equal((await linkStatus(cleanFile.id)).status, 200);

    // Infected callback: pending -> quarantined, download refused.
    const badFile = await upload("bad.txt", "callback-bad-001");
    assert.equal((await callback(badFile.id, badFile.version, "infected", "run-bad-1")).status, 200);
    assert.deepEqual(await linkStatus(badFile.id), { status: 409, code: "FILE_QUARANTINED" });

    // Error callback fails closed to quarantined, same as infected.
    const errorFile = await upload("error.txt", "callback-error-001");
    assert.equal((await callback(errorFile.id, errorFile.version, "error", "run-error-1")).status, 200);
    assert.deepEqual(await linkStatus(errorFile.id), { status: 409, code: "FILE_QUARANTINED" });

    // Wrong secret: 401, and the file stays pending.
    const guardedFile = await upload("guarded.txt", "callback-guarded-001");
    const wrongSecret = await callback(guardedFile.id, guardedFile.version, "clean", "run-wrong-1", "wrong-secret");
    assert.equal(wrongSecret.status, 401);
    assert.deepEqual(await linkStatus(guardedFile.id), { status: 409, code: "FILE_SCAN_PENDING" });

    // Unset secret: 503 fail closed, file still pending.
    delete process.env.NEXORA_SCAN_WEBHOOK_SECRET;
    try {
      const unsetSecret = await callback(guardedFile.id, guardedFile.version, "clean", "run-unset-1", CALLBACK_SECRET);
      assert.equal(unsetSecret.status, 503);
    } finally {
      process.env.NEXORA_SCAN_WEBHOOK_SECRET = CALLBACK_SECRET;
    }
    assert.deepEqual(await linkStatus(guardedFile.id), { status: 409, code: "FILE_SCAN_PENDING" });

    // Invalid payload: unknown outcome and unknown key are both 400, file still pending.
    const badOutcome = await callback(guardedFile.id, guardedFile.version, "bogus", "run-bad-outcome-1");
    assert.equal(badOutcome.status, 400);
    const unknownKey = await scanCallback(
      callbackRequest({ fileId: guardedFile.id, version: guardedFile.version, outcome: "clean", runId: "run-extra-1", tenantId: "not-trusted" }, CALLBACK_SECRET),
    );
    assert.equal(unknownKey.status, 400);
    assert.deepEqual(await linkStatus(guardedFile.id), { status: 409, code: "FILE_SCAN_PENDING" });

    // Stale version: replacing the file bumps the version, and the
    // old version's callback is ignored; the new version's is applied.
    const replaced = await replaceTaskFile(
      replaceFileRequest(`${filePath}/${guardedFile.id}`, Buffer.from("replaced content\n"), "guarded.txt", owner.cookie, guardedFile.version),
      fileParamsFor(guardedFile.id),
    );
    assert.equal(replaced.status, 200, await replaced.clone().text());
    const replacedBody = (await replaced.json()) as { data: { file: { version: number; scan_status: string } } };
    assert.equal(replacedBody.data.file.version, guardedFile.version + 1);
    assert.equal(replacedBody.data.file.scan_status, "pending");
    const stale = await callback(guardedFile.id, guardedFile.version, "clean", "run-stale-1");
    assert.equal(stale.status, 200);
    assert.deepEqual(await linkStatus(guardedFile.id), { status: 409, code: "FILE_SCAN_PENDING" });
    assert.equal((await callback(guardedFile.id, replacedBody.data.file.version, "clean", "run-fresh-1")).status, 200);
    assert.equal((await linkStatus(guardedFile.id)).status, 200);

    // Deleted file: the callback is a 200 no-op, never a resurrection.
    const doomedFile = await upload("doomed.txt", "callback-doomed-001");
    const deleted = await deleteTaskFile(
      apiRequest(`${filePath}/${doomedFile.id}`, "DELETE", undefined, owner.cookie),
      fileParamsFor(doomedFile.id),
    );
    assert.equal(deleted.status, 200, await deleted.clone().text());
    const afterDelete = await callback(doomedFile.id, doomedFile.version, "clean", "run-doomed-1");
    assert.equal(afterDelete.status, 200);
    assert.equal((await linkStatus(doomedFile.id)).status, 404);

    // Async-mode upload with no dispatch token: 201, still pending,
    // dispatch skipped without failing the upload.
    process.env.NEXORA_MALWARE_SCANNER = "github-actions";
    delete process.env.NEXORA_GITHUB_DISPATCH_TOKEN;
    try {
      const asyncFile = await upload("async.txt", "callback-async-001");
      assert.equal(asyncFile.scan_status, "pending");
    } finally {
      delete process.env.NEXORA_MALWARE_SCANNER;
    }
  },
);
