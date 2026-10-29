import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { evaluateOperatorAuthAlert } from "../../../server/alerts.ts";
import { jsonError, jsonOk } from "../../../server/api.ts";
import {
  isIpLockedOut,
  isIpRateLimited,
  recordIpAuthFailure,
} from "../../../server/auth-rate-limit.ts";
import {
  checkDatabaseConnection,
  countAuthRateLimitAttempts,
  getAlertStateLastSent,
  getDatabasePoolStats,
  queryOperatorAggregates,
  upsertAlertStateSent,
} from "../../../server/db.ts";
import { sendNotificationEmail } from "../../../server/email.ts";
import { RateLimitConfigurationError } from "../../../security/rate-limit.ts";
import { snapshotMetrics } from "../../../server/metrics.ts";

export const runtime = "nodejs";

// Operator metrics. Authenticated by a shared bearer token, not by a
// user session: a monitoring job cannot sign in, and metrics must not
// be public. If NEXORA_METRICS_TOKEN is unset, the endpoint fails
// closed with 503 rather than serving metrics unauthenticated. The
// token comparison is constant-time when the lengths match. The
// response contains counts, latencies, and pool counters only — never
// user data, request bodies, query strings, or credentials. Counters
// are process-local (see src/server/metrics.ts); a multi-instance
// deployment aggregates across instances externally.
// Operator hardening: every call consumes the DB-backed per-IP
// rate limit (scope operator-metrics, 120/hour — migration 0063),
// and every failed authentication is logged as a structured
// operator.auth_failed event (endpoint only, never the token).
// Since migration 0066, failures additionally feed a failures-only
// lockout (scope operator-metrics-lockout, 5 per 15 minutes per
// IP, checked before the token) and, at 10 failures in an hour,
// one alert email via the alerts job's table and mailer (at most
// one an hour). The lockout and the alert read the same rate-limit
// rows nothing else writes, so no duplicate counter exists.
function tokenMatches(request: NextRequest): boolean {
  const configured = process.env.NEXORA_METRICS_TOKEN;
  if (!configured) return false;
  const presented = request.headers.get("x-nexora-metrics-token") ?? "";
  const configuredBuffer = Buffer.from(configured, "utf8");
  const presentedBuffer = Buffer.from(presented, "utf8");
  if (presentedBuffer.length !== configuredBuffer.length) return false;
  return timingSafeEqual(presentedBuffer, configuredBuffer);
}

export async function GET(request: NextRequest) {
  if (!process.env.NEXORA_METRICS_TOKEN) {
    return jsonError(
      request,
      503,
      "SERVICE_UNAVAILABLE",
      "Metrics are not configured.",
    );
  }
  try {
    if (await isIpRateLimited(request, "operator-metrics", 120, 3600)) {
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
      return jsonError(request, 503, "SERVICE_UNAVAILABLE", "Metrics are not configured.");
    }
    throw error;
  }
  try {
    if (await isIpLockedOut(request, "operator-metrics-lockout", 5, 900)) {
      return jsonError(
        request,
        429,
        "RATE_LIMITED",
        "Too many attempts. Wait before trying again.",
        { "retry-after": "900" },
      );
    }
  } catch (error) {
    if (error instanceof RateLimitConfigurationError) {
      return jsonError(request, 503, "SERVICE_UNAVAILABLE", "Metrics are not configured.");
    }
    throw error;
  }
  if (!tokenMatches(request)) {
    console.error(JSON.stringify({ event: "operator.auth_failed", endpoint: "metrics" }));
    await recordOperatorMetricsFailure(request);
    return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
  }
  const probeStarted = Date.now();
  const databaseUp = await checkDatabaseConnection();
  const databaseLatencyMs = Date.now() - probeStarted;
  // DB-backed operator aggregates (AI latency/tokens, queue
  // depth, job failures). Null when migration 0061 has not been
  // applied yet or the database is unreachable: the in-memory
  // counters above are still served, and the null itself tells the
  // operator the aggregates are unavailable.
  let operator: Awaited<ReturnType<typeof queryOperatorAggregates>> | null = null;
  try {
    operator = await queryOperatorAggregates();
  } catch {
    operator = null;
  }
  return jsonOk(request, {
    ...snapshotMetrics(),
    operator,
    database: {
      up: databaseUp,
      probeLatencyMs: databaseLatencyMs,
      pool: getDatabasePoolStats(),
    },
  });
}

// Best-effort: a failure anywhere here must never change the 401
// above, and must never log the token. The failure count comes
// from the lockout scope's own rows; suppression uses the alerts
// job's alert_state row, and sending uses its mailer.
async function recordOperatorMetricsFailure(request: NextRequest): Promise<void> {
  try {
    await recordIpAuthFailure(request, "operator-metrics-lockout", 5, 900);
    const failures = await countAuthRateLimitAttempts("operator-metrics-lockout", null, 3600);
    const recipient = process.env.NEXORA_ALERT_EMAIL?.trim() ?? "";
    if (!recipient) return;
    const lastSentAt = await getAlertStateLastSent("operator-auth-failures");
    const evaluation = evaluateOperatorAuthAlert(failures, 10, lastSentAt, new Date());
    if (!evaluation.triggered) return;
    await sendNotificationEmail(
      recipient,
      "Nexora alert: operator authentication failures",
      evaluation.detail,
    );
    await upsertAlertStateSent("operator-auth-failures", failures);
  } catch {
    console.error(JSON.stringify({ event: "operator.alert_failed", endpoint: "metrics" }));
  }
}
