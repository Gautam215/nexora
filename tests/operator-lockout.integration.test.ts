import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server.js";
import { GET as runCron } from "../src/app/api/cron/[job]/route.ts";
import { GET as getMetrics } from "../src/app/api/metrics/route.ts";
import { closeDatabasePool } from "../src/server/db.ts";
import { startSmtpCaptureServer, type SmtpCapture } from "./smtp-server.ts";

const connectionString = process.env.NEXORA_TEST_DATABASE_URL;
const origin = "https://nexora.example.test";

if (connectionString) process.env.DATABASE_URL = connectionString;

process.env.AUTH_RATE_LIMIT_HMAC_KEY = randomBytes(32).toString("hex");
process.env.NEXORA_CRON_TOKEN = randomBytes(32).toString("hex");
process.env.NEXORA_METRICS_TOKEN = randomBytes(32).toString("hex");
process.env.NEXORA_ALERT_EMAIL = "operator-alert@nexora.example.test";
let smtp: SmtpCapture | undefined;

after(async () => {
  await smtp?.close();
  await closeDatabasePool();
});

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

// Migration 0066: five failed metrics-token attempts from one IP lock
// that IP out for 15 minutes, even for the correct token afterwards.
test(
  "metrics operator endpoint locks an IP out after five failed tokens",
  { skip: !connectionString },
  async () => {
    await withTrustedClientIp(async (ipHeader) => {
      const ip = "203.0.113.79";
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const response = await getMetrics(metricsRequest("wrong-token", ipHeader, ip));
        assert.equal(response.status, 401, `attempt ${attempt} should be 401`);
      }
      const sixth = await getMetrics(metricsRequest("wrong-token", ipHeader, ip));
      assert.equal(sixth.status, 429);
      const validWhileLocked = await getMetrics(
        metricsRequest(process.env.NEXORA_METRICS_TOKEN ?? "", ipHeader, ip),
      );
      assert.equal(validWhileLocked.status, 429);
    });
  },
);

// Cron authenticates before routing: an unknown job with a wrong
// token is a 401 (not a 404 that would leak which jobs exist), and
// an unknown job with a valid token is a 404.
test(
  "cron operator endpoint authenticates before routing to a job",
  { skip: !connectionString },
  async () => {
    await withTrustedClientIp(async (ipHeader) => {
      const ip = "203.0.113.80";
      const unknownWrong = await runCron(cronRequest("no-such-job", "wrong-token", ipHeader, ip), {
        params: Promise.resolve({ job: "no-such-job" }),
      });
      assert.equal(unknownWrong.status, 401);
      const unknownValid = await runCron(
        cronRequest("no-such-job", process.env.NEXORA_CRON_TOKEN ?? "", ipHeader, ip),
        { params: Promise.resolve({ job: "no-such-job" }) },
      );
      assert.equal(unknownValid.status, 404);
      const knownWrong = await runCron(cronRequest("due-date", "wrong-token", ipHeader, ip), {
        params: Promise.resolve({ job: "due-date" }),
      });
      assert.equal(knownWrong.status, 401);
    });
  },
);

// Ten failed metrics tokens in an hour trigger exactly one alert
// email; further failures within the hour are suppressed. The five
// failures from the lockout test above count toward the same global
// total, so the alert fires during the first five failures here and
// the later ten must not produce a second email.
test(
  "metrics operator failures alert once per hour, then suppress",
  { skip: !connectionString },
  async () => {
    smtp = await startSmtpCaptureServer();
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = String(smtp.port);
    process.env.SMTP_USER = "";
    process.env.SMTP_PASSWORD = "";
    process.env.SMTP_FROM = "noreply@nexora.example.test";
    process.env.SMTP_REQUIRE_TLS = "false";
    await withTrustedClientIp(async (ipHeader) => {
      for (const ip of ["203.0.113.81", "203.0.113.82", "203.0.113.83"]) {
        for (let attempt = 1; attempt <= 5; attempt += 1) {
          const response = await getMetrics(metricsRequest("wrong-token", ipHeader, ip));
          assert.equal(response.status, 401, `${ip} attempt ${attempt} should be 401`);
        }
      }
    });
    assert.equal(smtp?.messages.length, 1);
    assert.ok(smtp?.messages[0]?.includes("operator authentication failures"));
  },
);
