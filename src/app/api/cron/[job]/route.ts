import type { NextRequest } from "next/server";
import { jsonError, jsonOk, jsonServerFailure } from "../../../../server/api.ts";
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
// header x-nexora-cron-token: <NEXORA_CRON_TOKEN>.
//
// This route deliberately does NOT use the browser origin check:
// a cron caller is not a browser and sends no Origin. The token
// is the only authentication, so it must be a long random value,
// and the route fails closed with 503 when it is unset. Jobs are
// idempotent per day (see src/server/scheduled.ts), so a retried
// cron call replays instead of repeating work. This route does
// not schedule anything by itself — the schedule lives in the
// operator's scheduler, documented in docs/deployment.md §6.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ job: string }> },
) {
  const { job } = await params;
  if (!(SCHEDULED_JOBS as readonly string[]).includes(job)) {
    return jsonError(request, 404, "JOB_NOT_FOUND", "Scheduled job not found.");
  }
  try {
    if (!cronTokenMatches(request.headers.get("x-nexora-cron-token"))) {
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
