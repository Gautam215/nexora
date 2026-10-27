import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createS3PresignedUrl,
  getStorageProvider,
  parseS3Config,
  StorageConfigurationError,
} from "../src/server/storage.ts";

const KEY = "123e4567-e89b-12d3-a456-426614174000";

function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const previous: Record<string, string | undefined> = {};
  const names = [
    "NEXORA_STORAGE_PROVIDER",
    "NEXORA_S3_ENDPOINT",
    "NEXORA_S3_BUCKET",
    "NEXORA_S3_REGION",
    "NEXORA_S3_ACCESS_KEY",
    "NEXORA_S3_SECRET_KEY",
    "NEXORA_S3_FORCE_PATH_STYLE",
    "NEXORA_PRIVATE_FILE_DIR",
  ];
  for (const name of names) {
    previous[name] = process.env[name];
    const value = env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
}

test("local provider round-trips a file and rejects an invalid key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nexora-storage-test-"));
  try {
    await withEnv({ NEXORA_PRIVATE_FILE_DIR: dir }, async () => {
      const provider = getStorageProvider();
      assert.equal(provider.name, "local");
      assert.equal(provider.presignedDownloadUrl(KEY), null);
      await provider.writeObject(KEY, Buffer.from("hello storage"));
      const bytes = await provider.readObject(KEY, 1024);
      assert.equal(bytes.toString(), "hello storage");
      await assert.rejects(() => provider.writeObject("not-a-uuid", Buffer.from("x")));
      await provider.removeObject(KEY);
      await assert.rejects(() => provider.readObject(KEY, 1024));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("s3 selected without credentials fails closed instead of falling back to local", async () => {
  await withEnv(
    {
      NEXORA_STORAGE_PROVIDER: "s3",
      NEXORA_S3_ENDPOINT: "http://127.0.0.1:1",
      NEXORA_S3_BUCKET: "nexora-test",
    },
    () => {
      assert.throws(() => parseS3Config(), StorageConfigurationError);
      assert.throws(() => getStorageProvider(), StorageConfigurationError);
    },
  );
});

test("unknown storage provider fails closed", async () => {
  await withEnv({ NEXORA_STORAGE_PROVIDER: "gcs" }, () => {
    assert.throws(() => getStorageProvider(), StorageConfigurationError);
  });
});

test("s3 provider talks SigV4-signed HTTP to a fake server and presigns a download URL", async () => {
  const requests: Array<{ method: string; url: string; authorization: string }> = [];
  const store = new Map<string, Buffer>();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        authorization: request.headers.authorization ?? "",
      });
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "PUT") {
        store.set(url.pathname, Buffer.concat(chunks));
        response.writeHead(200).end();
      } else if (request.method === "GET") {
        const body = store.get(url.pathname);
        if (!body) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200).end(body);
      } else if (request.method === "DELETE") {
        store.delete(url.pathname);
        response.writeHead(204).end();
      } else {
        response.writeHead(405).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake S3 server did not bind");
  try {
    await withEnv(
      {
        NEXORA_STORAGE_PROVIDER: "s3",
        NEXORA_S3_ENDPOINT: `http://127.0.0.1:${address.port}`,
        NEXORA_S3_BUCKET: "nexora-test",
        NEXORA_S3_REGION: "us-east-1",
        NEXORA_S3_ACCESS_KEY: "test-access",
        NEXORA_S3_SECRET_KEY: "test-secret",
        NEXORA_S3_FORCE_PATH_STYLE: "true",
      },
      async () => {
        const provider = getStorageProvider();
        assert.equal(provider.name, "s3");
        await provider.writeObject(KEY, Buffer.from("s3 hello"));
        const bytes = await provider.readObject(KEY, 1024);
        assert.equal(bytes.toString(), "s3 hello");
        assert.ok(requests.every((entry) => entry.authorization.startsWith("AWS4-HMAC-SHA256 Credential=test-access/")));
        const config = parseS3Config();
        assert.ok(config);
        const presigned = createS3PresignedUrl(config, `${KEY}.blob`, 300, new Date("2026-10-26T00:00:00.000Z"));
        const parsed = new URL(presigned);
        assert.equal(parsed.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
        assert.equal(parsed.searchParams.get("X-Amz-Expires"), "300");
        assert.match(parsed.searchParams.get("X-Amz-Signature") ?? "", /^[0-9a-f]{64}$/);
        assert.equal(provider.presignedDownloadUrl(KEY, 300)?.includes("X-Amz-Signature="), true);
        await provider.removeObject(KEY);
        await assert.rejects(() => provider.readObject(KEY, 1024));
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
