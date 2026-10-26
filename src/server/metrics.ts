import "server-only";

// In-process API metrics, collected at the shared JSON response helpers
// (src/server/api.ts), which every JSON route funnels through. No new
// dependency, no external backend, no per-route code: jsonResponse
// counts every response by normalized path and status class, and
// jsonServerFailure additionally counts failures by operation name.
//
// Deliberate limits, so the counters themselves cannot become a
// problem:
// - Paths are normalized (UUID and numeric segments become ":id") and
//   query strings are never recorded, so cardinality is bounded by the
//   route table, not by user data. No user id, email, token, or request
//   body is ever recorded.
// - The path table is capped; beyond the cap, further paths aggregate
//   under "_other" instead of growing memory.
// - Counters are process-local. On a multi-instance deployment each
//   instance reports its own counters; an external monitor aggregates
//   them. Nothing here pretends to be a global view.
// - OAuth 302 redirects bypass the JSON helpers and are not counted;
//   their failures are still covered by the structured failure logs.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_PATTERN = /^\d+$/;
const MAX_PATHS = 500;

const startedAt = Date.now();

interface PathStats {
  count: number;
  success: number;
  clientError: number;
  serverError: number;
}

const paths = new Map<string, PathStats>();
const failuresByOperation = new Map<string, number>();
let total = 0;
let success = 0;
let clientError = 0;
let serverError = 0;

// Realtime counters (PRD 25/33): connections are counted when a
// project stream is accepted and decremented when it closes, so
// `current` is the live connection count for this process.
// `delivered` counts events enqueued to a stream controller, not
// client acknowledgements — SSE has none, and a slow or dead client
// may never read what was enqueued. Like the request counters,
// these are process-local; an external monitor aggregates across
// instances.
let realtimeConnectionsCurrent = 0;
let realtimeConnectionsTotal = 0;
let realtimeEventsPublished = 0;
let realtimeEventsDelivered = 0;

export function recordRealtimeConnect(): void {
  realtimeConnectionsCurrent += 1;
  realtimeConnectionsTotal += 1;
}

export function recordRealtimeDisconnect(): void {
  realtimeConnectionsCurrent = Math.max(0, realtimeConnectionsCurrent - 1);
}

export function recordRealtimePublished(count = 1): void {
  realtimeEventsPublished += count;
}

export function recordRealtimeDelivered(count = 1): void {
  realtimeEventsDelivered += count;
}

export function normalizeMetricsPath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) =>
      UUID_PATTERN.test(segment) || NUMERIC_PATTERN.test(segment) ? ":id" : segment,
    )
    .join("/");
}

export function recordResponse(pathname: string, status: number): void {
  const path = normalizeMetricsPath(pathname);
  total += 1;
  const bucket =
    status >= 500 ? "serverError" : status >= 400 ? "clientError" : "success";
  if (bucket === "serverError") serverError += 1;
  else if (bucket === "clientError") clientError += 1;
  else success += 1;
  let stats = paths.get(path);
  if (!stats) {
    if (paths.size >= MAX_PATHS) {
      stats = paths.get("_other") ?? { count: 0, success: 0, clientError: 0, serverError: 0 };
      paths.set("_other", stats);
    } else {
      stats = { count: 0, success: 0, clientError: 0, serverError: 0 };
      paths.set(path, stats);
    }
  }
  stats.count += 1;
  stats[bucket] += 1;
}

export function recordOperationFailure(operation: string): void {
  failuresByOperation.set(operation, (failuresByOperation.get(operation) ?? 0) + 1);
}

export interface MetricsSnapshot {
  uptimeSeconds: number;
  requests: {
    total: number;
    success: number;
    clientError: number;
    serverError: number;
  };
  realtime: {
    connectionsCurrent: number;
    connectionsTotal: number;
    eventsPublished: number;
    eventsDelivered: number;
  };
  paths: { path: string; count: number; success: number; clientError: number; serverError: number }[];
  failuresByOperation: { operation: string; count: number }[];
}

export function snapshotMetrics(): MetricsSnapshot {
  return {
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    requests: { total, success, clientError, serverError },
    realtime: {
      connectionsCurrent: realtimeConnectionsCurrent,
      connectionsTotal: realtimeConnectionsTotal,
      eventsPublished: realtimeEventsPublished,
      eventsDelivered: realtimeEventsDelivered,
    },
    paths: [...paths.entries()]
      .map(([path, stats]) => ({ path, ...stats }))
      .sort((a, b) => b.count - a.count),
    failuresByOperation: [...failuresByOperation.entries()]
      .map(([operation, count]) => ({ operation, count }))
      .sort((a, b) => b.count - a.count),
  };
}
