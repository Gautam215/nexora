import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { jsonError, jsonOk } from "../../../server/api.ts";
import { checkDatabaseConnection, getDatabasePoolStats } from "../../../server/db.ts";
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
  if (!tokenMatches(request)) {
    return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
  }
  const probeStarted = Date.now();
  const databaseUp = await checkDatabaseConnection();
  const databaseLatencyMs = Date.now() - probeStarted;
  return jsonOk(request, {
    ...snapshotMetrics(),
    database: {
      up: databaseUp,
      probeLatencyMs: databaseLatencyMs,
      pool: getDatabasePoolStats(),
    },
  });
}
