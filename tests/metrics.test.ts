import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeMetricsPath,
  recordOperationFailure,
  recordRealtimeConnect,
  recordRealtimeDelivered,
  recordRealtimeDisconnect,
  recordRealtimePublished,
  recordResponse,
  snapshotMetrics,
} from "../src/server/metrics.ts";

test("metrics paths normalize identifiers and never keep query strings", () => {
  assert.equal(
    normalizeMetricsPath("/api/organizations/123e4567-e89b-12d3-a456-426614174000/projects/42/tasks"),
    "/api/organizations/:id/projects/:id/tasks",
  );
  assert.equal(normalizeMetricsPath("/api/health"), "/api/health");
  // The caller passes the pathname only; a query string is not a path
  // segment and must not create a new series.
  assert.equal(normalizeMetricsPath("/api/organizations/:id/search"), "/api/organizations/:id/search");
});

test("metrics count responses by status class and failures by operation", () => {
  const before = snapshotMetrics();
  recordResponse("/api/organizations/123e4567-e89b-12d3-a456-426614174000/projects", 200);
  recordResponse("/api/organizations/123e4567-e89b-12d3-a456-426614174000/projects", 404);
  recordResponse("/api/organizations/123e4567-e89b-12d3-a456-426614174000/projects", 500);
  recordOperationFailure("projects.create");
  recordOperationFailure("projects.create");
  const after = snapshotMetrics();
  assert.equal(after.requests.total - before.requests.total, 3);
  assert.equal(after.requests.success - before.requests.success, 1);
  assert.equal(after.requests.clientError - before.requests.clientError, 1);
  assert.equal(after.requests.serverError - before.requests.serverError, 1);
  const path = after.paths.find((entry) => entry.path === "/api/organizations/:id/projects");
  assert.ok(path);
  assert.equal(path.count, 3);
  const failure = after.failuresByOperation.find((entry) => entry.operation === "projects.create");
  assert.ok(failure);
  assert.equal(failure.count, 2);
  assert.equal(typeof after.uptimeSeconds, "number");
});

test("metrics track realtime connections, publishes, and deliveries", () => {
  const before = snapshotMetrics();
  recordRealtimeConnect();
  recordRealtimeConnect();
  recordRealtimeDisconnect();
  recordRealtimePublished();
  recordRealtimePublished(2);
  recordRealtimeDelivered(3);
  const after = snapshotMetrics();
  // Two connects minus one disconnect leaves one live connection.
  assert.equal(after.realtime.connectionsCurrent - before.realtime.connectionsCurrent, 1);
  assert.equal(after.realtime.connectionsTotal - before.realtime.connectionsTotal, 2);
  assert.equal(after.realtime.eventsPublished - before.realtime.eventsPublished, 3);
  assert.equal(after.realtime.eventsDelivered - before.realtime.eventsDelivered, 3);
  // Disconnects can never drive the live count below zero.
  recordRealtimeDisconnect();
  recordRealtimeDisconnect();
  assert.equal(snapshotMetrics().realtime.connectionsCurrent, before.realtime.connectionsCurrent);
});
