import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server.js";
import { GET as getHealth } from "../src/app/api/health/route.ts";
import { GET as getMetrics } from "../src/app/api/metrics/route.ts";
import { GET as getReady } from "../src/app/api/ready/route.ts";
import { closeDatabasePool } from "../src/server/db.ts";

const connectionString = process.env.NEXORA_TEST_DATABASE_URL;
const origin = "http://localhost:3000";
const runtimeEnvironment = process.env as unknown as Record<string, string | undefined>;
if (connectionString) process.env.DATABASE_URL = connectionString;
runtimeEnvironment.NODE_ENV = "test";
process.env.APP_ORIGIN = origin;
process.env.AUTH_RATE_LIMIT_HMAC_KEY = randomBytes(32).toString("hex");
delete process.env.NEXORA_TRUSTED_CLIENT_IP_HEADER;

after(async () => {
  await closeDatabasePool();
});

function apiRequest(path: string, token?: string): NextRequest {
  const headers = new Headers();
  if (token !== undefined) headers.set("x-nexora-metrics-token", token);
  return new NextRequest(`${origin}${path}`, { headers });
}

type MetricsBody = {
  data: {
    uptimeSeconds: number;
    requests: { total: number; success: number; clientError: number; serverError: number };
    paths: { path: string; count: number }[];
    failuresByOperation: { operation: string; count: number }[];
    database: { up: boolean; probeLatencyMs: number; pool: unknown };
  };
};

test(
  "metrics endpoint fails closed without a token and reports counters with one",
  { skip: !connectionString },
  async () => {
    const token = randomBytes(32).toString("hex");
    delete process.env.NEXORA_METRICS_TOKEN;
    const unconfigured = await getMetrics(apiRequest("/api/metrics", token));
    assert.equal(unconfigured.status, 503);

    process.env.NEXORA_METRICS_TOKEN = token;
    const wrongToken = await getMetrics(apiRequest("/api/metrics", "not-the-token"));
    assert.equal(wrongToken.status, 401);

    const before = (await (await getMetrics(apiRequest("/api/metrics", token))).json()) as MetricsBody;
    const health = await getHealth(apiRequest("/api/health"));
    assert.equal(health.status, 200);
    const after = (await (await getMetrics(apiRequest("/api/metrics", token))).json()) as MetricsBody;
    assert.equal(after.data.requests.total - before.data.requests.total, 2);
    // One health request plus the metrics request itself, which is
    // counted by the shared JSON helpers like any other response.
    const healthPath = after.data.paths.find((entry) => entry.path === "/api/health");
    assert.ok(healthPath);
    assert.ok(healthPath.count >= 1);
    assert.equal(typeof after.data.uptimeSeconds, "number");
    assert.equal(after.data.database.up, true);
    assert.equal(typeof after.data.database.probeLatencyMs, "number");
    assert.ok(after.data.database.pool !== null);
    // No user data, request bodies, or query strings in the payload.
    assert.equal(JSON.stringify(after.data).includes("@example.test"), false);

    const ready = await getReady(apiRequest("/api/ready"));
    assert.equal(ready.status, 200);
    const readyBody = (await ready.json()) as { data: { ready: boolean; database: string } };
    assert.equal(readyBody.data.ready, true);
    assert.equal(readyBody.data.database, "up");
    delete process.env.NEXORA_METRICS_TOKEN;
  },
);
