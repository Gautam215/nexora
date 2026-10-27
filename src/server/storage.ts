import "server-only";
import { createHash, createHmac } from "node:crypto";
import {
  listStalePrivateFileKeys,
  readPrivateFile,
  removePrivateFile,
  writePrivateFile,
} from "./private-file-storage.ts";

// Storage abstraction (approved default, 2026-10-26).
// The codebase previously called the local filesystem directly
// from every file route. That made shared storage impossible
// without touching every route, and it made the storage choice
// invisible. This module is the single place that chooses a
// provider, and every file route and the cleanup script must go
// through it.
//
// Providers:
// - `local` (default): the existing private filesystem directory
//   (NEXORA_PRIVATE_FILE_DIR), with the same 0600/0700
//   permissions, integrity, and orphan-scan behaviour as before.
//   This is the only provider that is live-verified in tests.
// - `s3`: an S3-compatible provider (AWS S3, MinIO, and other
//   S3-compatible stores) implemented with plain fetch and SigV4
//   signing — no new dependency. It is implemented and unit-tested
//   against a fake HTTP server, but it is NOT live-verified
//   against a real S3 endpoint, and must not be claimed as
//   operational until an operator configures it and runs a
//   copy-then-verify migration (see docs/deployment.md).
//   Selecting `s3` without a complete configuration fails closed
//   with StorageConfigurationError, never silently falling back
//   to local storage (a silent fallback would split files across
//   two stores and lose them).
//
// Authorization is NOT the provider's job, and a presigned URL
// does not bypass it: file routes still check project/task
// authorization, version, and integrity before reading from any
// provider, and the primary download path remains the Nexora
// route (which re-checks at download time). A presigned URL is
// short-lived (300 seconds, matching the existing signed-link
// TTL) and is issued only after authorization, for a future
// direct-download optimization — it is not used as the download
// path by the current routes.

export class StorageConfigurationError extends Error {
  constructor(message = "File storage is not configured") {
    super(message);
    this.name = "StorageConfigurationError";
  }
}

export class StorageError extends Error {
  constructor(message = "File storage operation failed") {
    super(message);
    this.name = "StorageError";
  }
}

export interface StorageProvider {
  readonly name: "local" | "s3";
  writeObject(storageKey: string, bytes: Uint8Array): Promise<void>;
  readObject(storageKey: string, maxBytes: number): Promise<Buffer>;
  removeObject(storageKey: string): Promise<void>;
  listStaleObjectKeys(olderThan: Date): Promise<string[]>;
  /** Returns null for providers without presigned downloads. */
  presignedDownloadUrl(storageKey: string, expiresSeconds?: number): string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateStorageKey(storageKey: string): string {
  if (!UUID_PATTERN.test(storageKey)) throw new StorageError("Invalid private file storage key");
  return storageKey.toLowerCase();
}

function objectKey(storageKey: string): string {
  return `${validateStorageKey(storageKey)}.blob`;
}

const localProvider: StorageProvider = {
  name: "local",
  async writeObject(storageKey, bytes) {
    await writePrivateFile(validateStorageKey(storageKey), bytes);
  },
  async readObject(storageKey, maxBytes) {
    return readPrivateFile(validateStorageKey(storageKey), maxBytes);
  },
  async removeObject(storageKey) {
    await removePrivateFile(validateStorageKey(storageKey));
  },
  async listStaleObjectKeys(olderThan) {
    return listStalePrivateFileKeys(olderThan);
  },
  presignedDownloadUrl() {
    return null;
  },
};

export interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
}

export function parseS3Config(): S3Config | null {
  if ((process.env.NEXORA_STORAGE_PROVIDER ?? "local").trim().toLowerCase() !== "s3") return null;
  const endpoint = process.env.NEXORA_S3_ENDPOINT?.trim();
  const bucket = process.env.NEXORA_S3_BUCKET?.trim();
  const region = process.env.NEXORA_S3_REGION?.trim() || "us-east-1";
  const accessKey = process.env.NEXORA_S3_ACCESS_KEY?.trim();
  const secretKey = process.env.NEXORA_S3_SECRET_KEY?.trim();
  const forcePathStyle = process.env.NEXORA_S3_FORCE_PATH_STYLE !== "false";
  if (!endpoint || !bucket || !accessKey || !secretKey) {
    throw new StorageConfigurationError(
      "S3 storage is selected but NEXORA_S3_ENDPOINT, NEXORA_S3_BUCKET, NEXORA_S3_ACCESS_KEY, or NEXORA_S3_SECRET_KEY is missing",
    );
  }
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw new StorageConfigurationError("NEXORA_S3_ENDPOINT is not a valid URL");
  }
  if (endpointUrl.protocol !== "http:" && endpointUrl.protocol !== "https:") {
    throw new StorageConfigurationError("NEXORA_S3_ENDPOINT must be http or https");
  }
  if (process.env.NODE_ENV === "production" && endpointUrl.protocol !== "https:") {
    throw new StorageConfigurationError("S3 storage in production must use https");
  }
  return { endpoint: endpointUrl.toString().replace(/\/$/, ""), bucket, region, accessKey, secretKey, forcePathStyle };
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function signatureKey(secretKey: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmacSha256(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

function amzDate(now: Date): { dateStamp: string; amzDateTime: string } {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return { dateStamp: iso.slice(0, 8), amzDateTime: iso };
}

function objectUrl(config: S3Config, key: string): string {
  const endpoint = new URL(config.endpoint);
  if (config.forcePathStyle) {
    return `${config.endpoint}/${encodeURIComponent(config.bucket)}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
  }
  // Virtual-host style: bucket.endpoint
  const host = `${config.bucket}.${endpoint.host}`;
  return `${endpoint.protocol}//${host}${endpoint.pathname.replace(/\/$/, "")}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
}

function signedHeaders(host: string, payloadHash: string, amzDateTime: string): Record<string, string> {
  return {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDateTime,
  };
}

function canonicalRequest(
  method: string,
  url: URL,
  headers: Record<string, string>,
  payloadHash: string,
): string {
  const sortedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderNames.map((name) => `${name}:${headers[name]!.trim()}\n`).join("");
  const signedHeaderNames = sortedHeaderNames.join(";");
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .sort()
    .join("&");
  return [
    method,
    decodeURIComponent(url.pathname),
    canonicalQuery,
    canonicalHeaders,
    signedHeaderNames,
    payloadHash,
  ].join("\n");
}

function authorizationHeader(
  config: S3Config,
  method: string,
  url: URL,
  payloadHash: string,
  now: Date,
): string {
  const { dateStamp, amzDateTime } = amzDate(now);
  const headers = signedHeaders(url.host, payloadHash, amzDateTime);
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDateTime,
    scope,
    sha256Hex(canonicalRequest(method, url, headers, payloadHash)),
  ].join("\n");
  const signature = hmacSha256(signatureKey(config.secretKey, dateStamp, config.region, "s3"), stringToSign).toString("hex");
  return `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`;
}

async function s3Request(
  config: S3Config,
  method: string,
  key: string,
  body?: Uint8Array,
  now: Date = new Date(),
): Promise<Response> {
  const url = new URL(objectUrl(config, key));
  const payload = body ?? new Uint8Array(0);
  const payloadHash = sha256Hex(payload);
  const { amzDateTime } = amzDate(now);
  const headers: Record<string, string> = {
    Authorization: authorizationHeader(config, method, url, payloadHash, now),
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDateTime,
  };
  if (method === "PUT") headers["content-length"] = String(payload.byteLength);
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method,
      headers,
      body: method === "PUT" ? payload : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new StorageError("S3 storage request failed");
  }
  if (!response.ok && !(method === "DELETE" && response.status === 404)) {
    throw new StorageError("S3 storage request failed");
  }
  return response;
}

export function createS3PresignedUrl(
  config: S3Config,
  key: string,
  expiresSeconds = 300,
  now: Date = new Date(),
): string {
  const clamped = Math.max(1, Math.min(expiresSeconds, 604800));
  const { dateStamp, amzDateTime } = amzDate(now);
  const url = new URL(objectUrl(config, key));
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set("X-Amz-Credential", `${config.accessKey}/${dateStamp}/${config.region}/s3/aws4_request`);
  url.searchParams.set("X-Amz-Date", amzDateTime);
  url.searchParams.set("X-Amz-Expires", String(clamped));
  url.searchParams.set("X-Amz-SignedHeaders", "host");
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .sort()
    .join("&");
  const canonicalRequestText = [
    "GET",
    decodeURIComponent(url.pathname),
    canonicalQuery,
    `host:${url.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDateTime, scope, sha256Hex(canonicalRequestText)].join("\n");
  const signature = hmacSha256(signatureKey(config.secretKey, dateStamp, config.region, "s3"), stringToSign).toString("hex");
  url.searchParams.set("X-Amz-Signature", signature);
  return url.toString();
}

function s3Provider(config: S3Config): StorageProvider {
  return {
    name: "s3",
    async writeObject(storageKey, bytes) {
      await s3Request(config, "PUT", objectKey(storageKey), bytes);
    },
    async readObject(storageKey, maxBytes) {
      const response = await s3Request(config, "GET", objectKey(storageKey));
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength < 1 || buffer.byteLength > maxBytes) {
        throw new StorageError("Private file object failed integrity checks");
      }
      return buffer;
    },
    async removeObject(storageKey) {
      await s3Request(config, "DELETE", objectKey(storageKey));
    },
    async listStaleObjectKeys(olderThan) {
      // ListObjectsV2 with a minimal XML scan. Pagination is
      // followed via continuation tokens; the scan is bounded by
      // the bucket's object count, and a malformed entry is
      // skipped rather than failing the whole cleanup run.
      const keys: string[] = [];
      let continuationToken: string | undefined;
      for (let page = 0; page < 1000; page += 1) {
        // List at the bucket root: query the bucket URL directly.
        const listUrl = new URL(`${config.endpoint}/${encodeURIComponent(config.bucket)}`);
        listUrl.searchParams.set("list-type", "2");
        if (continuationToken) listUrl.searchParams.set("continuation-token", continuationToken);
        const payloadHash = sha256Hex(new Uint8Array(0));
        const { amzDateTime } = amzDate(new Date());
        let response: Response;
        try {
          response = await fetch(listUrl.toString(), {
            headers: {
              Authorization: authorizationHeader(config, "GET", listUrl, payloadHash, new Date()),
              "x-amz-content-sha256": payloadHash,
              "x-amz-date": amzDateTime,
            },
            signal: AbortSignal.timeout(15_000),
          });
        } catch {
          throw new StorageError("S3 storage list failed");
        }
        if (!response.ok) throw new StorageError("S3 storage list failed");
        const xml = await response.text();
        const contents = xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g);
        for (const match of contents) {
          const block = match[1] ?? "";
          const keyMatch = /<Key>([^<]+)<\/Key>/.exec(block);
          const dateMatch = /<LastModified>([^<]+)<\/LastModified>/.exec(block);
          if (!keyMatch || !dateMatch) continue;
          const key = decodeURIComponent(keyMatch[1]!);
          const modified = new Date(dateMatch[1]!);
          if (Number.isNaN(modified.getTime()) || modified > olderThan) continue;
          const storageKeyMatch = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.blob$/i.exec(key);
          if (storageKeyMatch) keys.push(storageKeyMatch[1]!);
        }
        const truncated = /<IsTruncated>(true|false)<\/IsTruncated>/.exec(xml)?.[1] === "true";
        const nextToken = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1];
        if (!truncated || !nextToken) break;
        continuationToken = nextToken;
      }
      return keys;
    },
    presignedDownloadUrl(storageKey, expiresSeconds = 300) {
      return createS3PresignedUrl(config, objectKey(storageKey), expiresSeconds);
    },
  };
}

export function getStorageProvider(): StorageProvider {
  const s3Config = parseS3Config();
  if (s3Config) return s3Provider(s3Config);
  const provider = (process.env.NEXORA_STORAGE_PROVIDER ?? "local").trim().toLowerCase();
  if (provider !== "" && provider !== "local") {
    throw new StorageConfigurationError(`Unknown storage provider: ${provider}`);
  }
  return localProvider;
}

export async function writeObject(storageKey: string, bytes: Uint8Array): Promise<void> {
  await getStorageProvider().writeObject(storageKey, bytes);
}

export async function readObject(storageKey: string, maxBytes: number): Promise<Buffer> {
  return getStorageProvider().readObject(storageKey, maxBytes);
}

export async function removeObject(storageKey: string): Promise<void> {
  await getStorageProvider().removeObject(storageKey);
}

export async function listStaleObjectKeys(olderThan: Date): Promise<string[]> {
  return getStorageProvider().listStaleObjectKeys(olderThan);
}

export function presignedDownloadUrl(storageKey: string, expiresSeconds = 300): string | null {
  return getStorageProvider().presignedDownloadUrl(storageKey, expiresSeconds);
}
