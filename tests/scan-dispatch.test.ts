import assert from "node:assert/strict";
import { after, test } from "node:test";
import { dispatchScanJob, getScanMode } from "../src/server/scan-dispatch.ts";
import { MalwareConfigurationError } from "../src/server/malware.ts";

// Unit tests for async scan dispatch (no database). fetch is
// stubbed per case and always restored; the S3 presigned URL
// is real SigV4 output for a dummy endpoint (no network is
// touched because fetch never runs).

const runtimeEnvironment = process.env as unknown as Record<string, string | undefined>;

let previousScanner: string | undefined;
let previousStorageProvider: string | undefined;
let previousS3Endpoint: string | undefined;
let previousS3Bucket: string | undefined;
let previousS3AccessKey: string | undefined;
let previousS3SecretKey: string | undefined;
let previousDispatchToken: string | undefined;
let previousScanRepo: string | undefined;
let previousFetch: typeof fetch | undefined;

after(() => {
  if (previousScanner === undefined) delete process.env.NEXORA_MALWARE_SCANNER;
  else process.env.NEXORA_MALWARE_SCANNER = previousScanner;
  if (previousStorageProvider === undefined) delete process.env.NEXORA_STORAGE_PROVIDER;
  else process.env.NEXORA_STORAGE_PROVIDER = previousStorageProvider;
  if (previousS3Endpoint === undefined) delete process.env.NEXORA_S3_ENDPOINT;
  else process.env.NEXORA_S3_ENDPOINT = previousS3Endpoint;
  if (previousS3Bucket === undefined) delete process.env.NEXORA_S3_BUCKET;
  else process.env.NEXORA_S3_BUCKET = previousS3Bucket;
  if (previousS3AccessKey === undefined) delete process.env.NEXORA_S3_ACCESS_KEY;
  else process.env.NEXORA_S3_ACCESS_KEY = previousS3AccessKey;
  if (previousS3SecretKey === undefined) delete process.env.NEXORA_S3_SECRET_KEY;
  else process.env.NEXORA_S3_SECRET_KEY = previousS3SecretKey;
  if (previousDispatchToken === undefined) delete process.env.NEXORA_GITHUB_DISPATCH_TOKEN;
  else process.env.NEXORA_GITHUB_DISPATCH_TOKEN = previousDispatchToken;
  if (previousScanRepo === undefined) delete process.env.NEXORA_SCAN_REPO;
  else process.env.NEXORA_SCAN_REPO = previousScanRepo;
  if (previousFetch !== undefined) globalThis.fetch = previousFetch;
});

function captureEnv() {
  previousScanner = process.env.NEXORA_MALWARE_SCANNER;
  previousStorageProvider = process.env.NEXORA_STORAGE_PROVIDER;
  previousS3Endpoint = process.env.NEXORA_S3_ENDPOINT;
  previousS3Bucket = process.env.NEXORA_S3_BUCKET;
  previousS3AccessKey = process.env.NEXORA_S3_ACCESS_KEY;
  previousS3SecretKey = process.env.NEXORA_S3_SECRET_KEY;
  previousDispatchToken = process.env.NEXORA_GITHUB_DISPATCH_TOKEN;
  previousScanRepo = process.env.NEXORA_SCAN_REPO;
  previousFetch = globalThis.fetch;
}

// Captured once, before any test mutates the environment, so
// after() restores the original values rather than the previous
// test's leftovers.
captureEnv();
runtimeEnvironment.NODE_ENV = "test";

function useS3() {
  process.env.NEXORA_STORAGE_PROVIDER = "s3";
  process.env.NEXORA_S3_ENDPOINT = "https://s3.test.invalid";
  process.env.NEXORA_S3_BUCKET = "test-bucket";
  process.env.NEXORA_S3_ACCESS_KEY = "test-access";
  process.env.NEXORA_S3_SECRET_KEY = "test-secret";
}

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function stubFetch(status: number, ok: boolean) {
  const calls: CapturedCall[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return { ok, status } as Response;
  }) as typeof fetch;
  return calls;
}

const input = {
  fileId: "11111111-1111-4111-8111-111111111111",
  version: 1,
  organizationId: "22222222-2222-4222-8222-222222222222",
  projectId: "33333333-3333-4333-8333-333333333333",
  taskId: "44444444-4444-4444-8444-444444444444",
  storageKey: "55555555-5555-4555-8555-555555555555",
  sha256: "a".repeat(64),
};

test("scan modes derive from NEXORA_MALWARE_SCANNER, unknown values throw", () => {
  runtimeEnvironment.NODE_ENV = "test";
  delete process.env.NEXORA_MALWARE_SCANNER;
  assert.equal(getScanMode(), "none");
  process.env.NEXORA_MALWARE_SCANNER = "none";
  assert.equal(getScanMode(), "none");
  process.env.NEXORA_MALWARE_SCANNER = "clamav";
  assert.equal(getScanMode(), "sync");
  process.env.NEXORA_MALWARE_SCANNER = "github-actions";
  assert.equal(getScanMode(), "async-github-actions");
  process.env.NEXORA_MALWARE_SCANNER = "bogus-scanner";
  assert.throws(() => getScanMode(), MalwareConfigurationError);
});

test("dispatch posts a repository_dispatch with a 900s presigned URL", async () => {
  useS3();
  process.env.NEXORA_GITHUB_DISPATCH_TOKEN = "test-dispatch-token";
  delete process.env.NEXORA_SCAN_REPO;
  const calls = stubFetch(204, true);
  const result = await dispatchScanJob(input);
  assert.equal(result.dispatched, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.github.com/repos/Gautam215/nexora/dispatches");
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer test-dispatch-token");
  const body = JSON.parse(String(calls[0]?.init.body)) as {
    event_type: string;
    client_payload: Record<string, unknown>;
  };
  assert.equal(body.event_type, "nexora-scan");
  assert.equal(body.client_payload.fileId, input.fileId);
  assert.equal(body.client_payload.version, 1);
  assert.equal(body.client_payload.sha256, input.sha256);
  const downloadUrl = String(body.client_payload.downloadUrl);
  assert.ok(downloadUrl.startsWith("https://s3.test.invalid/"));
  assert.ok(downloadUrl.includes("X-Amz-Expires=900"));
});

test("dispatch without a token never calls fetch", async () => {
  useS3();
  delete process.env.NEXORA_GITHUB_DISPATCH_TOKEN;
  const calls = stubFetch(204, true);
  const result = await dispatchScanJob(input);
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, "dispatch-not-configured");
  assert.equal(calls.length, 0);
});

test("dispatch without S3 presigning never calls fetch", async () => {
  delete process.env.NEXORA_STORAGE_PROVIDER;
  process.env.NEXORA_GITHUB_DISPATCH_TOKEN = "test-dispatch-token";
  const calls = stubFetch(204, true);
  const result = await dispatchScanJob(input);
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, "no-presigned-url");
  assert.equal(calls.length, 0);
});

test("dispatch failures never throw", async () => {
  useS3();
  process.env.NEXORA_GITHUB_DISPATCH_TOKEN = "test-dispatch-token";
  let calls = stubFetch(401, false);
  const rejected = await dispatchScanJob(input);
  assert.equal(rejected.dispatched, false);
  assert.equal(rejected.reason, "dispatch-rejected");
  assert.equal(calls.length, 1);
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  calls = [];
  const thrown = await dispatchScanJob(input);
  assert.equal(thrown.dispatched, false);
  assert.equal(thrown.reason, "dispatch-failed");
});

test("dispatch uses NEXORA_SCAN_REPO when set", async () => {
  useS3();
  process.env.NEXORA_GITHUB_DISPATCH_TOKEN = "test-dispatch-token";
  process.env.NEXORA_SCAN_REPO = "example-owner/example-repo";
  const calls = stubFetch(204, true);
  const result = await dispatchScanJob(input);
  assert.equal(result.dispatched, true);
  assert.equal(calls[0]?.url, "https://api.github.com/repos/example-owner/example-repo/dispatches");
});

test("dispatch rejects a malformed NEXORA_SCAN_REPO without calling fetch", async () => {
  useS3();
  process.env.NEXORA_GITHUB_DISPATCH_TOKEN = "test-dispatch-token";
  process.env.NEXORA_SCAN_REPO = "not-a-repo";
  const calls = stubFetch(204, true);
  const result = await dispatchScanJob(input);
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, "dispatch-not-configured");
  assert.equal(calls.length, 0);
});
