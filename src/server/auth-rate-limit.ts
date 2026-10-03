import "server-only";
import { isIP } from "node:net";
import type { NextRequest } from "next/server";
import { consumeAuthRateLimit } from "./db.ts";
import {
  hashRateLimitSubject,
  RateLimitConfigurationError,
} from "../security/rate-limit.ts";

export async function isRateLimited(
  request: NextRequest,
  scope: string,
  email: string,
  emailLimit: number,
  windowSeconds: number,
  ipLimit: number,
): Promise<boolean> {
  const emailHash = hashRateLimitSubject(`${scope}:email`, email);
  const emailAllowed = await consumeAuthRateLimit(scope, emailHash, emailLimit, windowSeconds);
  const ipAllowed = await consumeIpLimit(request, scope, ipLimit, windowSeconds);
  return !emailAllowed || !ipAllowed;
}

export async function isTokenRateLimited(
  request: NextRequest,
  scope: string,
  tokenHash: string,
  tokenLimit: number,
  windowSeconds: number,
  ipLimit: number,
): Promise<boolean> {
  const tokenSubjectHash = hashRateLimitSubject(`${scope}:token`, tokenHash);
  const tokenAllowed = await consumeAuthRateLimit(
    scope,
    tokenSubjectHash,
    tokenLimit,
    windowSeconds,
  );
  const ipAllowed = await consumeIpLimit(request, scope, ipLimit, windowSeconds);
  return !tokenAllowed || !ipAllowed;
}

async function consumeIpLimit(
  request: NextRequest,
  scope: string,
  ipLimit: number,
  windowSeconds: number,
): Promise<boolean> {
  const ipHeader = process.env.NEXORA_TRUSTED_CLIENT_IP_HEADER;
  if (!ipHeader) {
    if (process.env.NODE_ENV === "production") {
      throw new RateLimitConfigurationError();
    }
    return true;
  }
  if (!/^[A-Za-z0-9-]{1,100}$/.test(ipHeader)) {
    throw new RateLimitConfigurationError();
  }

  const clientIp = request.headers.get(ipHeader)?.trim();
  if (!clientIp || isIP(clientIp) === 0) throw new RateLimitConfigurationError();
  const ipHash = hashRateLimitSubject(`${scope}:ip`, clientIp);
  return consumeAuthRateLimit(scope, ipHash, ipLimit, windowSeconds);
}
