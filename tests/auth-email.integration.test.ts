import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server.js";
import { Client } from "pg";
import { POST as register } from "../src/app/api/auth/register/route.ts";
import { POST as requestPasswordReset } from "../src/app/api/auth/password-reset/request/route.ts";
import { POST as resendVerification } from "../src/app/api/auth/verification/resend/route.ts";
import { createOpaqueToken, hashOpaqueToken } from "../src/security/tokens.ts";
import { closeDatabasePool } from "../src/server/db.ts";
import { startSmtpCaptureServer, type SmtpCapture } from "./smtp-server.ts";

const connectionString = process.env.NEXORA_TEST_DATABASE_URL;
const origin = "http://localhost:3000";
const runtimeEnvironment = process.env as unknown as Record<string, string | undefined>;
if (connectionString) process.env.DATABASE_URL = connectionString;
runtimeEnvironment.NODE_ENV = "test";
process.env.APP_ORIGIN = origin;
process.env.AUTH_RATE_LIMIT_HMAC_KEY = randomBytes(32).toString("hex");
delete process.env.NEXORA_TRUSTED_CLIENT_IP_HEADER;

let smtp: SmtpCapture | undefined;
const userEmail = `${randomUUID()}@example.test`;
const password = "correct horse battery staple";

function post(route: string, handler: (request: NextRequest) => Promise<Response>, body: unknown) {
  return handler(
    new NextRequest(`${origin}${route}`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

before(async () => {
  if (!connectionString) return;
  smtp = await startSmtpCaptureServer();
  runtimeEnvironment.SMTP_HOST = "127.0.0.1";
  runtimeEnvironment.SMTP_PORT = String(smtp.port);
  runtimeEnvironment.SMTP_SECURE = "false";
  runtimeEnvironment.SMTP_REQUIRE_TLS = "false";
  runtimeEnvironment.SMTP_USER = "";
  runtimeEnvironment.SMTP_PASSWORD = "";
  runtimeEnvironment.SMTP_FROM = "noreply@nexora.example.test";
});

after(async () => {
  await smtp?.close();
  await closeDatabasePool();
});

test(
  "missing SMTP configuration returns 503, not a claimed delivery",
  { skip: !connectionString },
  async () => {
    delete runtimeEnvironment.SMTP_HOST;
    const response = await post("/api/auth/register", register, {
      name: "Missing Config",
      email: `${randomUUID()}@example.test`,
      password,
    });
    const body = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(response.status, 503);
    assert.equal(body.error.code, "SERVICE_UNAVAILABLE");
    assert.ok(!body.error.message.includes("SMTP"));
    // Restore for the remaining tests, before any transporter is cached.
    runtimeEnvironment.SMTP_HOST = "127.0.0.1";
  },
);

test(
  "registration and resend succeed and actually deliver when SMTP is up",
  { skip: !connectionString },
  async () => {
    const registered = await post("/api/auth/register", register, {
      name: "Email Test",
      email: userEmail,
      password,
    });
    const registeredBody = (await registered.json()) as { data: { message: string } };
    assert.equal(registered.status, 202);
    assert.match(registeredBody.data.message, /will arrive by email/);
    assert.ok(smtp);
    assert.equal(smtp.messages.length, 1);
    assert.match(smtp.messages[0], /\/verify-email\?token=/);

    const resent = await post("/api/auth/verification/resend", resendVerification, {
      email: userEmail,
    });
    assert.equal(resent.status, 202);
    assert.equal(smtp.messages.length, 2);
    assert.match(smtp.messages[1], /\/verify-email\?token=/);
  },
);

test(
  "SMTP outage returns 503 for eligible and ineligible addresses alike",
  { skip: !connectionString },
  async () => {
    // Verify the registered user, so the reset request below is eligible.
    const client = new Client({ connectionString });
    await client.connect();
    try {
      const token = createOpaqueToken();
      const tokenHash = hashOpaqueToken(token);
      assert.ok(tokenHash);
      await client.query("SELECT nexora.issue_email_verification($1, $2, $3, $4)", [
        userEmail,
        randomUUID(),
        tokenHash,
        new Date(Date.now() + 60 * 60 * 1000),
      ]);
      await client.query("SELECT nexora.consume_email_verification($1)", [tokenHash]);
    } finally {
      await client.end();
    }

    // Close the SMTP server: from here, delivery must fail, not succeed.
    await smtp?.close();
    smtp = undefined;
    const messagesBefore = 2;

    // Thunks, not pre-built promises: the cases must run sequentially,
    // not concurrently, so that each response is attributable to its own
    // request and rate-limit state is deterministic.
    const cases: Array<[string, () => Promise<Response>]> = [
      [
        "register",
        () =>
          post("/api/auth/register", register, {
            name: "Outage Test",
            email: `${randomUUID()}@example.test`,
            password,
          }),
      ],
      [
        "reset eligible",
        () => post("/api/auth/password-reset/request", requestPasswordReset, { email: userEmail }),
      ],
      [
        "reset ineligible",
        () =>
          post("/api/auth/password-reset/request", requestPasswordReset, {
            email: `${randomUUID()}@example.test`,
          }),
      ],
      [
        "resend",
        () => post("/api/auth/verification/resend", resendVerification, { email: userEmail }),
      ],
    ];
    for (const [label, run] of cases) {
      const response = await run();
      const body = (await response.json()) as {
        error: { code: string; message: string };
        data?: { message: string };
      };
      assert.equal(response.status, 503, label);
      assert.equal(body.error.code, "EMAIL_DELIVERY_UNAVAILABLE", label);
      assert.equal(
        body.error.message,
        "Email delivery is unavailable right now. Please try again later.",
        label,
      );
      assert.ok(!body.data?.message?.includes("will arrive"), label);
    }
    assert.ok(messagesBefore === 2);
  },
);
