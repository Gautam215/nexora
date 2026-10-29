import "server-only";
import { isIP } from "node:net";
import type { NextRequest } from "next/server";
import { consumeAuthRateLimit, countAuthRateLimitAttempts } from "./db.ts";
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

/**
 * IP-only rate limit for endpoints with no user-typed subject yet
 * Same mechanism, same trusted-IP-header rule,
 * and the same development bypass as the IP half of isRateLimited;
 * it does not bypass any existing protection.
 */
export async function isIpRateLimited(
  request: NextRequest,
  scope: string,
  ipLimit: number,
  windowSeconds: number,
): Promise<boolean> {
  return !(await consumeIpLimit(request, scope, ipLimit, windowSeconds));
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

// Shared trusted-IP-header rule for every IP-based limit: the
// header name is validated, a missing or non-IP value fails closed
// in production, and non-production without the header bypasses
// (null) exactly as the original IP limit did.
function getClientIpHash(request: NextRequest, scope: string): string | null {
  const ipHeader = process.env.NEXORA_TRUSTED_CLIENT_IP_HEADER;
  if (!ipHeader) {
    if (process.env.NODE_ENV === "production") {
      throw new RateLimitConfigurationError();
    }
    return null;
  }
  if (!/^[A-Za-z0-9-]{1,100}$/.test(ipHeader)) {
    throw new RateLimitConfigurationError();
  }

  const clientIp = request.headers.get(ipHeader)?.trim();
  if (!clientIp || isIP(clientIp) === 0) throw new RateLimitConfigurationError();
  return hashRateLimitSubject(`${scope}:ip`, clientIp);
}

async function consumeIpLimit(
  request: NextRequest,
  scope: string,
  ipLimit: number,
  windowSeconds: number,
): Promise<boolean> {
  const ipHash = getClientIpHash(request, scope);
  if (ipHash === null) return true;
  return consumeAuthRateLimit(scope, ipHash, ipLimit, windowSeconds);
}

// Metrics-only failure lockout (migration 0066): failures are
// recorded in their own scope, so legitimate traffic never counts
// toward the lockout, and the check only reads that scope's rows —
// it never consumes, so a lockout expires on its own when its
// window passes. The cron endpoint deliberately has no lockout:
// token spam must never be able to deny scheduled jobs.
export async function isIpLockedOut(
  request: NextRequest,
  lockoutScope: string,
  maxFailures: number,
  windowSeconds: number,
): Promise<boolean> {
  const ipHash = getClientIpHash(request, lockoutScope);
  if (ipHash === null) return false;
  const failures = await countAuthRateLimitAttempts(lockoutScope, ipHash, windowSeconds);
  return failures >= maxFailures;
}

export async function recordIpAuthFailure(
  request: NextRequest,
  lockoutScope: string,
  maxFailures: number,
  windowSeconds: number,
): Promise<void> {
  const ipHash = getClientIpHash(request, lockoutScope);
  if (ipHash === null) return;
  await consumeAuthRateLimit(lockoutScope, ipHash, maxFailures, windowSeconds);
}
