import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { NextRequest } from "next/server.js";
import { GET as runCron } from "../src/app/api/cron/[job]/route.ts";
import { GET as getMetrics } from "../src/app/api/metrics/route.ts";

const connectionString = process.env.NEXORA_TEST_DATABASE_URL;
const origin = "https://nexora.example.test";

if (connectionString) process.env.DATABASE_URL = connectionString;

process.env.AUTH_RATE_LIMIT_HMAC_KEY = randomBytes(32).toString("hex");
process.env.NEXORA_CRON_TOKEN = randomBytes(32).toString("hex");
process.env.NEXORA_METRICS_TOKEN = randomBytes(32).toString("hex");

async function withTrustedClientIp<T>(work: (headerName: string) => Promise<T>): Promise<T> {
  const headerName = "x-nexora-test-client-ip";
  const previousHeader = process.env.NEXORA_TRUSTED_CLIENT_IP_HEADER;
  process.env.NEXORA_TRUSTED_CLIENT_IP_HEADER = headerName;
  try {
    return await work(headerName);
  } finally {
    if (previousHeader === undefined) delete process.env.NEXORA_TRUSTED_CLIENT_IP_HEADER;
    else process.env.NEXORA_TRUSTED_CLIENT_IP_HEADER = previousHeader;
  }
}

function cronRequest(job: string, token: string, ipHeader: string, ip: string): NextRequest {
  const headers = new Headers();
  headers.set("x-nexora-cron-token", token);
  headers.set(ipHeader, ip);
  return new NextRequest(`${origin}/api/cron/${job}`, { method: "GET", headers });
}

function metricsRequest(token: string, ipHeader: string, ip: string): NextRequest {
  const headers = new Headers();
  headers.set("x-nexora-metrics-token", token);
  headers.set(ipHeader, ip);
  return new NextRequest(`${origin}/api/metrics`, { method: "GET", headers });
}

// Operator token endpoints had no rate limit: token guessing was
// bounded by entropy alone. 120 wrong-token attempts per hour per IP
// are allowed (migration 0063 scopes); the 121st is rejected with
// 429 before the token is even checked.
test(
  "cron operator endpoint rate-limits repeated wrong tokens per IP",
  { skip: !connectionString },
  async () => {
    await withTrustedClientIp(async (ipHeader) => {
      const ip = "203.0.113.77";
      for (let attempt = 1; attempt <= 120; attempt += 1) {
        const response = await runCron(cronRequest("due-date", "wrong-token", ipHeader, ip), {
          params: Promise.resolve({ job: "due-date" }),
        });
        assert.equal(response.status, 401, `attempt ${attempt} should be 401`);
      }
      const limited = await runCron(cronRequest("due-date", "wrong-token", ipHeader, ip), {
        params: Promise.resolve({ job: "due-date" }),
      });
      assert.equal(limited.status, 429);
    });
  },
);

test(
  "metrics operator endpoint rate-limits repeated wrong tokens per IP",
  { skip: !connectionString },
  async () => {
    await withTrustedClientIp(async (ipHeader) => {
      const ip = "203.0.113.78";
      for (let attempt = 1; attempt <= 120; attempt += 1) {
        const response = await getMetrics(metricsRequest("wrong-token", ipHeader, ip));
        assert.equal(response.status, 401, `attempt ${attempt} should be 401`);
      }
      const limited = await getMetrics(metricsRequest("wrong-token", ipHeader, ip));
      assert.equal(limited.status, 429);
    });
  },
);
