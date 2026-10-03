import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_PRIVATE_FILE_BYTES,
  createPrivateFileToken,
  readBoundedFileBody,
  safePrivateFilename,
  validatePrivateFile,
  verifyPrivateFileToken,
} from "../src/security/private-files.ts";
import {
  listStalePrivateFileKeys,
  readPrivateFile,
  removePrivateFile,
  writePrivateFile,
} from "../src/server/private-file-storage.ts";

const secret = "test-signing-key-that-is-at-least-32-bytes-long";
const claims = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  projectId: "20000000-0000-4000-8000-000000000002",
  taskId: "30000000-0000-4000-8000-000000000003",
  fileId: "40000000-0000-4000-8000-000000000004",
  userId: "50000000-0000-4000-8000-000000000005",
  version: 2,
  expiresAt: 2000,
};

test("private filenames strip path segments and unsafe characters", () => {
  assert.equal(safePrivateFilename("../../R&D launch plan.pdf"), "R_D launch plan.pdf");
  assert.equal(safePrivateFilename("..\\budget.csv"), "budget.csv");
  assert.equal(safePrivateFilename(".hidden.pdf"), "hidden.pdf");
  assert.equal(safePrivateFilename("../only-a-name"), null);
  assert.equal(safePrivateFilename("../unsafe.svg"), "unsafe.svg");
  assert.equal(validatePrivateFile("../unsafe.svg", "image/svg+xml", Buffer.from("<svg/>", "utf8")).ok, false);
});

test("private file validation requires an allowlisted extension, MIME, and matching bytes", () => {
  const pdf = Buffer.from("%PDF-1.7\nexample\n%%EOF\n", "ascii");
  assert.deepEqual(validatePrivateFile("proposal.pdf", "application/pdf", pdf), {
    ok: true,
    filename: "proposal.pdf",
    mimeType: "application/pdf",
    extension: "pdf",
  });
  assert.equal(validatePrivateFile("proposal.pdf", "text/plain", pdf).ok, false);
  assert.equal(validatePrivateFile("proposal.pdf", "application/pdf", Buffer.from("not a PDF")).ok, false);
  assert.equal(validatePrivateFile("image.png", "image/png", Buffer.from("<svg/>")).ok, false);
  assert.equal(validatePrivateFile("notes.txt", "text/plain", Buffer.from("safe text\n", "utf8")).ok, true);
  assert.equal(validatePrivateFile("notes.txt", "text/plain", Buffer.from([0x61, 0x00])).ok, false);
});

test("temporary file tokens are tamper-evident, short-lived, and carry a file version", () => {
  const token = createPrivateFileToken(claims, secret);
  assert.deepEqual(verifyPrivateFileToken(token, secret, 1999), claims);
  assert.equal(verifyPrivateFileToken(token, secret, 2000), null);
  assert.equal(verifyPrivateFileToken(token, `${secret}x`, 1999), null);
  const [payload, signature] = token.split(".");
  assert.ok(payload && signature);
  const changedSignature = `${signature.slice(0, -1)}${signature.endsWith("a") ? "b" : "a"}`;
  assert.equal(verifyPrivateFileToken(`${payload}.${changedSignature}`, secret, 1999), null);
  assert.throws(() => createPrivateFileToken(claims, "short"), /at least 32 bytes/);
});

test("file request bodies reject oversized declarations and accept bounded bytes", async () => {
  const oversized = new Request("https://nexora.invalid/upload", {
    method: "POST",
    headers: { "content-length": String(MAX_PRIVATE_FILE_BYTES + 1) },
  });
  assert.deepEqual(await readBoundedFileBody(oversized), {
    ok: false,
    status: 413,
    code: "FILE_TOO_LARGE",
    message: "Files must be 10 MB or smaller.",
  });
  const valid = new Request("https://nexora.invalid/upload", { method: "POST", body: "small file" });
  const result = await readBoundedFileBody(valid);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.bytes.toString("utf8"), "small file");
  const empty = new Request("https://nexora.invalid/upload", { method: "POST", body: "" });
  assert.equal((await readBoundedFileBody(empty)).ok, false);
});

test("private storage uses private permissions, opaque keys, and safe deletion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexora-private-files-"));
  const previousDirectory = process.env.NEXORA_PRIVATE_FILE_DIR;
  process.env.NEXORA_PRIVATE_FILE_DIR = root;
  const key = "60000000-0000-4000-8000-000000000006";
  try {
    const bytes = Buffer.from("private bytes");
    await writePrivateFile(key, bytes);
    assert.deepEqual(await readPrivateFile(key, 1024), bytes);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(root, `${key}.blob`))).mode & 0o777, 0o600);
    assert.deepEqual(await listStalePrivateFileKeys(new Date(Date.now() + 60_000)), [key]);
    await assert.rejects(() => readPrivateFile("../../outside", 1024), /Invalid private file storage key/);
    await removePrivateFile(key);
    await assert.rejects(() => readPrivateFile(key, 1024));
  } finally {
    if (previousDirectory === undefined) delete process.env.NEXORA_PRIVATE_FILE_DIR;
    else process.env.NEXORA_PRIVATE_FILE_DIR = previousDirectory;
    await rm(root, { recursive: true, force: true });
  }
});
