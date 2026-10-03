import "server-only";
import { createHash, randomBytes } from "node:crypto";

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function createOpaqueToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashOpaqueToken(token: string | null | undefined): string | null {
  if (!token || !TOKEN_PATTERN.test(token)) return null;

  const bytes = Buffer.from(token, "base64url");
  if (bytes.length !== TOKEN_BYTES || bytes.toString("base64url") !== token) return null;
  return createHash("sha256").update(bytes).digest("hex");
}
