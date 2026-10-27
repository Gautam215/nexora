import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
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
import { GET as getTaskFile } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/[taskId]/files/[fileId]/route.ts";
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
let previousClamHost: string | undefined;
let previousClamPort: string | undefined;

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
  if (previousClamHost === undefined) delete process.env.NEXORA_CLAMAV_HOST;
  else process.env.NEXORA_CLAMAV_HOST = previousClamHost;
  if (previousClamPort === undefined) delete process.env.NEXORA_CLAMAV_PORT;
  else process.env.NEXORA_CLAMAV_PORT = previousClamPort;
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
  "task file uploads are scanned: infected files are quarantined and undownloadable, clean files download",
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
    privateFilesRoot = await mkdtemp(path.join(os.tmpdir(), "nexora-scan-files-"));
    process.env.NEXORA_PRIVATE_FILE_DIR = privateFilesRoot;
    process.env.NEXORA_FILE_SIGNING_KEY = randomBytes(32).toString("hex");

    // Fake clamd whose mode the test flips between uploads.
    let mode: "clean" | "infected" = "infected";
    const clamd = createServer((socket) => {
      let buffer = Buffer.alloc(0);
      let headerConsumed = false;
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!headerConsumed) {
          if (buffer.byteLength < 10) return;
          buffer = buffer.subarray(10);
          headerConsumed = true;
        }
        for (;;) {
          if (buffer.byteLength < 4) return;
          const length = buffer.readUInt32BE(0);
          if (buffer.byteLength < 4 + length) return;
          buffer = buffer.subarray(4 + length);
          if (length === 0) {
            socket.end(mode === "clean" ? "stream: OK\n" : "stream: Eicar-Test-Signature FOUND\n");
            return;
          }
        }
      });
    });
    await new Promise<void>((resolve) => clamd.listen(0, "127.0.0.1", resolve));
    const clamdAddress = clamd.address();
    assert.ok(clamdAddress && typeof clamdAddress !== "string");
    previousScanner = process.env.NEXORA_MALWARE_SCANNER;
    previousClamHost = process.env.NEXORA_CLAMAV_HOST;
    previousClamPort = process.env.NEXORA_CLAMAV_PORT;
    process.env.NEXORA_MALWARE_SCANNER = "clamav";
    process.env.NEXORA_CLAMAV_HOST = "127.0.0.1";
    process.env.NEXORA_CLAMAV_PORT = String(clamdAddress.port);

    try {
      const owner = await registerVerifyAndLogin(`${randomUUID()}@example.test`, "Scan Owner", "scan owner password");
      const orgResponse = await createOrganization(
        apiRequest("/api/organizations", "POST", { name: "Scan Workspace", slug: `scan-${owner.userId.slice(0, 8)}` }, owner.cookie),
      );
      assert.equal(orgResponse.status, 201);
      const organizationId = ((await orgResponse.json()) as { data: { organization: { id: string } } }).data.organization.id;
      const projectResponse = await createProject(
        apiRequest(`/api/organizations/${organizationId}/projects`, "POST", { name: "Scan project" }, owner.cookie),
        { params: Promise.resolve({ organizationId }) },
      );
      assert.equal(projectResponse.status, 201);
      const projectId = ((await projectResponse.json()) as { data: { project: { id: string } } }).data.project.id;
      const taskResponse = await createTask(
        apiRequest(`/api/organizations/${organizationId}/projects/${projectId}/tasks`, "POST", { title: "Scan task" }, owner.cookie, { "idempotency-key": "scan-task-001" }),
        { params: Promise.resolve({ organizationId, projectId }) },
      );
      assert.equal(taskResponse.status, 201, await taskResponse.clone().text());
      const taskId = ((await taskResponse.json()) as { data: { task: { id: string } } }).data.task.id;
      const filePath = `/api/organizations/${organizationId}/projects/${projectId}/tasks/${taskId}/files`;
      const fileParams = { params: Promise.resolve({ organizationId, projectId, taskId }) };

      // Infected upload: row is created, status quarantined.
      mode = "infected";
      const badUpload = await uploadTaskFile(
        privateFileRequest(filePath, Buffer.from("not actually malware\n"), "bad.txt", owner.cookie, { "idempotency-key": "scan-bad-001" }),
        fileParams,
      );
      assert.equal(badUpload.status, 201, await badUpload.clone().text());
      const badBody = (await badUpload.json()) as { data: { file: { id: string; scan_status: string } } };
      assert.equal(badBody.data.file.scan_status, "quarantined");
      const badFileId = badBody.data.file.id;

      // Signed-link creation for a quarantined file is refused.
      const badLink = await getTaskFile(
        apiRequest(`/api/organizations/${organizationId}/projects/${projectId}/tasks/${taskId}/files/${badFileId}`, "GET", undefined, owner.cookie),
        { params: Promise.resolve({ organizationId, projectId, taskId, fileId: badFileId }) },
      );
      assert.equal(badLink.status, 409);
      assert.equal(((await badLink.json()) as { error: { code: string } }).error.code, "FILE_QUARANTINED");

      // Clean upload: status clean, and a signed download succeeds.
      mode = "clean";
      const goodUpload = await uploadTaskFile(
        privateFileRequest(filePath, Buffer.from("clean content\n"), "good.txt", owner.cookie, { "idempotency-key": "scan-good-001" }),
        fileParams,
      );
      assert.equal(goodUpload.status, 201, await goodUpload.clone().text());
      const goodBody = (await goodUpload.json()) as { data: { file: { id: string; scan_status: string } } };
      assert.equal(goodBody.data.file.scan_status, "clean");
      const goodFileId = goodBody.data.file.id;
      const goodLink = await getTaskFile(
        apiRequest(`/api/organizations/${organizationId}/projects/${projectId}/tasks/${taskId}/files/${goodFileId}`, "GET", undefined, owner.cookie),
        { params: Promise.resolve({ organizationId, projectId, taskId, fileId: goodFileId }) },
      );
      assert.equal(goodLink.status, 200, await goodLink.clone().text());
      const signedUrl = ((await goodLink.json()) as { data: { url: string } }).data.url;
      const download = await getTaskFile(
        apiRequest(signedUrl, "GET", undefined, owner.cookie),
        { params: Promise.resolve({ organizationId, projectId, taskId, fileId: goodFileId }) },
      );
      assert.equal(download.status, 200);
      assert.equal(await download.text(), "clean content\n");
    } finally {
      await new Promise<void>((resolve) => clamd.close(() => resolve()));
    }
  },
);
