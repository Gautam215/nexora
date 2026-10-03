import { createHmac, timingSafeEqual } from "node:crypto";
import { extname } from "node:path";

export const MAX_PRIVATE_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TASK_FILE_COUNT = 20;
export const MAX_TASK_FILE_BYTES = 100 * 1024 * 1024;
export const PRIVATE_FILE_LINK_TTL_SECONDS = 5 * 60;

const FILE_TYPES: Record<string, { mimeType: string; kind: "text" | "pdf" | "png" | "jpeg" | "gif" | "webp" }> = {
  csv: { mimeType: "text/csv", kind: "text" },
  gif: { mimeType: "image/gif", kind: "gif" },
  jpeg: { mimeType: "image/jpeg", kind: "jpeg" },
  jpg: { mimeType: "image/jpeg", kind: "jpeg" },
  json: { mimeType: "application/json", kind: "text" },
  md: { mimeType: "text/markdown", kind: "text" },
  pdf: { mimeType: "application/pdf", kind: "pdf" },
  png: { mimeType: "image/png", kind: "png" },
  txt: { mimeType: "text/plain", kind: "text" },
  webp: { mimeType: "image/webp", kind: "webp" },
};

export type PrivateFileValidation =
  | { ok: true; filename: string; mimeType: string; extension: string }
  | { ok: false; code: "INVALID_FILENAME" | "UNSUPPORTED_FILE_TYPE" | "MIME_MISMATCH" | "INVALID_FILE_CONTENT"; message: string };

export interface SignedPrivateFileClaims {
  organizationId: string;
  projectId: string;
  taskId: string;
  fileId: string;
  userId: string;
  version: number;
  expiresAt: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validatePrivateFile(
  suppliedFilename: string,
  declaredMimeType: string,
  bytes: Uint8Array,
): PrivateFileValidation {
  const filename = safePrivateFilename(suppliedFilename);
  if (!filename) {
    return { ok: false, code: "INVALID_FILENAME", message: "Use a safe filename with a supported extension." };
  }
  const extension = extname(filename).slice(1).toLowerCase();
  const type = FILE_TYPES[extension];
  if (!type) {
    return { ok: false, code: "UNSUPPORTED_FILE_TYPE", message: "This file type is not supported." };
  }
  if (declaredMimeType.trim().toLowerCase() !== type.mimeType) {
    return { ok: false, code: "MIME_MISMATCH", message: "The file type does not match its extension." };
  }
  if (!matchesFileContent(type.kind, bytes)) {
    return { ok: false, code: "INVALID_FILE_CONTENT", message: "The file contents do not match the selected file type." };
  }
  return { ok: true, filename, mimeType: type.mimeType, extension };
}

export function safePrivateFilename(input: string): string | null {
  const basename = input.replaceAll("\\", "/").split("/").at(-1)?.normalize("NFC") ?? "";
  const rawExtension = extname(basename).slice(1).toLowerCase();
  if (!rawExtension || !/^[a-z0-9]{1,8}$/.test(rawExtension)) return null;
  const rawStem = basename.slice(0, -(rawExtension.length + 1));
  const stem = [...rawStem.replace(/[^\p{L}\p{N}._() -]/gu, "_")]
    .slice(0, 160)
    .join("")
    .replace(/^[. ]+|[. ]+$/g, "")
    .replace(/[. ]+$/g, "");
  if (!stem || stem === "." || stem === "..") return null;
  return `${stem}.${rawExtension}`;
}

function matchesFileContent(
  kind: (typeof FILE_TYPES)[string]["kind"],
  bytes: Uint8Array,
): boolean {
  const startsWith = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (kind === "pdf") return bytes.byteLength >= 8 && new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
  if (kind === "png") return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (kind === "jpeg") return startsWith(0xff, 0xd8, 0xff);
  if (kind === "gif") return ["GIF87a", "GIF89a"].some((signature) => new TextDecoder().decode(bytes.subarray(0, 6)) === signature);
  if (kind === "webp") {
    return bytes.byteLength >= 12 &&
      new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
      new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP";
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text);
  } catch {
    return false;
  }
}

export function createPrivateFileToken(
  claims: SignedPrivateFileClaims,
  secret: string,
): string {
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("NEXORA_FILE_SIGNING_KEY must contain at least 32 bytes");
  }
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyPrivateFileToken(
  token: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): SignedPrivateFileClaims | null {
  if (Buffer.byteLength(secret, "utf8") < 32 || token.length > 2048) return null;
  const [payload, suppliedSignature, extra] = token.split(".");
  if (!payload || !suppliedSignature || extra !== undefined) return null;
  const expectedSignature = createHmac("sha256", secret).update(payload).digest();
  let actualSignature: Buffer;
  try {
    actualSignature = Buffer.from(suppliedSignature, "base64url");
  } catch {
    return null;
  }
  if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<SignedPrivateFileClaims>;
    if (
      typeof claims.organizationId !== "string" || !UUID_PATTERN.test(claims.organizationId) ||
      typeof claims.projectId !== "string" || !UUID_PATTERN.test(claims.projectId) ||
      typeof claims.taskId !== "string" || !UUID_PATTERN.test(claims.taskId) ||
      typeof claims.fileId !== "string" || !UUID_PATTERN.test(claims.fileId) ||
      typeof claims.userId !== "string" || !UUID_PATTERN.test(claims.userId) ||
      !Number.isSafeInteger(claims.version) || (claims.version ?? 0) < 1 ||
      !Number.isSafeInteger(claims.expiresAt) || (claims.expiresAt ?? 0) <= nowSeconds
    ) return null;
    return claims as SignedPrivateFileClaims;
  } catch {
    return null;
  }
}

export type BoundedFileBody =
  | { ok: true; bytes: Buffer }
  | { ok: false; status: 400 | 413; code: "INVALID_REQUEST" | "FILE_TOO_LARGE"; message: string };

export async function readBoundedFileBody(request: Request): Promise<BoundedFileBody> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      return { ok: false, status: 400, code: "INVALID_REQUEST", message: "The file request is invalid." };
    }
    if (Number(declaredLength) > MAX_PRIVATE_FILE_BYTES) {
      return { ok: false, status: 413, code: "FILE_TOO_LARGE", message: "Files must be 10 MB or smaller." };
    }
  }

  const reader = request.body?.getReader();
  if (!reader) return { ok: false, status: 400, code: "INVALID_REQUEST", message: "The file is missing." };
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_PRIVATE_FILE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, status: 413, code: "FILE_TOO_LARGE", message: "Files must be 10 MB or smaller." };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, code: "INVALID_REQUEST", message: "The file request is invalid." };
  } finally {
    reader.releaseLock();
  }
  if (!length) return { ok: false, status: 400, code: "INVALID_REQUEST", message: "The file is empty." };
  return { ok: true, bytes: Buffer.concat(chunks, length) };
}
