import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { jsonError, jsonOk } from "../../../server/api.ts";
import { isIpRateLimited } from "../../../server/auth-rate-limit.ts";
import { RateLimitConfigurationError } from "../../../security/rate-limit.ts";
import {
  checkDatabaseConnection,
  getDatabasePoolStats,
  queryOperatorAggregates,
} from "../../../server/db.ts";
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
  if (!tokenMatches(request)) {
    console.error(JSON.stringify({ event: "operator.auth_failed", endpoint: "metrics" }));
    return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
  }
  const probeStarted = Date.now();
  const databaseUp = await checkDatabaseConnection();
  const databaseLatencyMs = Date.now() - probeStarted;
  // DB-backed operator aggregates (PRD 33: AI latency/tokens, queue
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
