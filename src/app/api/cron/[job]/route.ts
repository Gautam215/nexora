import type { NextRequest } from "next/server";
import { jsonError, jsonOk, jsonServerFailure } from "../../../../server/api.ts";
import { isIpRateLimited } from "../../../../server/auth-rate-limit.ts";
import { RateLimitConfigurationError } from "../../../../security/rate-limit.ts";
import {
  CronAuthenticationError,
  CronConfigurationError,
  cronTokenMatches,
  runScheduledJob,
  SCHEDULED_JOBS,
  type ScheduledJob,
} from "../../../../server/scheduled.ts";

export const runtime = "nodejs";

// Token-gated scheduled jobs. Called by the operator's scheduler
// (Vercel Cron, or any cron caller) as GET /api/cron/<job> with
// header x-nexora-cron-token: <NEXORA_CRON_TOKEN>, or with
// header Authorization: Bearer <NEXORA_CRON_TOKEN> — the form
// Vercel Cron sends when CRON_SECRET holds the same value.
// Either header must carry the same token; the token is never
// optional and never read from any other header.
//
// This route deliberately does NOT use the browser origin check:
// a cron caller is not a browser and sends no Origin. The token
// is the only authentication, so it must be a long random value,
// and the route fails closed with 503 when it is unset. Jobs are
// idempotent per day (see src/server/scheduled.ts), so a retried
// cron call replays instead of repeating work. The schedule
// itself lives in vercel.json, documented in docs/deployment.md §6.
// Operator hardening: every call consumes the DB-backed per-IP
// rate limit (scope operator-cron, 120/hour — migration 0063),
// and every failed authentication is logged as a structured
// operator.auth_failed event (endpoint only, never the token).
// A correct token never fails, so legitimate cron traffic is
// unaffected by the limit.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ job: string }> },
) {
  const { job } = await params;
  if (!(SCHEDULED_JOBS as readonly string[]).includes(job)) {
    return jsonError(request, 404, "JOB_NOT_FOUND", "Scheduled job not found.");
  }
  try {
    try {
      if (await isIpRateLimited(request, "operator-cron", 120, 3600)) {
        return jsonError(
          request,
          429,
          "RATE_LIMITED",
          "Too many attempts. Wait before trying again.",
          { "retry-after": "3600" },
        );
      }
    } catch (error) {
      if (error instanceof RateLimitConfigurationError) {
        return jsonError(request, 503, "SERVICE_UNAVAILABLE", "Scheduled jobs are not configured.");
      }
      throw error;
    }
    const authorization = request.headers.get("authorization");
    const bearer = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : null;
    if (
      !cronTokenMatches(request.headers.get("x-nexora-cron-token")) &&
      !cronTokenMatches(bearer)
    ) {
      console.error(JSON.stringify({ event: "operator.auth_failed", endpoint: `cron.${job}` }));
      throw new CronAuthenticationError();
    }
    const result = await runScheduledJob(job as ScheduledJob);
    return jsonOk(request, { job, replay: result.replay, detail: result.detail });
  } catch (error) {
    if (error instanceof CronConfigurationError) {
      return jsonError(request, 503, "SERVICE_UNAVAILABLE", "Scheduled jobs are not configured.");
    }
    if (error instanceof CronAuthenticationError) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    return jsonServerFailure(request, `cron.${job}`, error);
  }
}
