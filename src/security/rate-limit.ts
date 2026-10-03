import "server-only";
import { createHmac } from "node:crypto";

export class RateLimitConfigurationError extends Error {
  constructor() {
    super("Authentication rate-limit key is not configured");
    this.name = "RateLimitConfigurationError";
  }
}

export function hashRateLimitSubject(namespace: string, subject: string): string {
  const secret = process.env.AUTH_RATE_LIMIT_HMAC_KEY;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new RateLimitConfigurationError();
  }

  return createHmac("sha256", secret)
    .update(namespace, "utf8")
    .update("\0")
    .update(subject, "utf8")
    .digest("hex");
}
