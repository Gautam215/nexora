import assert from "node:assert/strict";
import { NextRequest } from "next/server.js";
import test from "node:test";
import { jsonServerFailure } from "../src/server/api.ts";
import {
  EmailDeliveryError,
  sendVerificationEmail,
  verifyEmailDelivery,
} from "../src/server/email.ts";
import { startSmtpCaptureServer } from "./smtp-server.ts";

const runtimeEnvironment = process.env as unknown as Record<string, string | undefined>;

async function closedPort(): Promise<number> {
  // Bind a capture server only to learn a free local port, then close it,
  // so the port that follows is (transiently) refusing connections.
  const server = await startSmtpCaptureServer();
  const port = server.port;
  await server.close();
  return port;
}

test("SMTP delivery failure is reported as a typed error, without SMTP detail", async () => {
  const port = await closedPort();
  runtimeEnvironment.APP_ORIGIN = "https://nexora.example.test";
  runtimeEnvironment.SMTP_HOST = "127.0.0.1";
  runtimeEnvironment.SMTP_PORT = String(port);
  runtimeEnvironment.SMTP_SECURE = "false";
  runtimeEnvironment.SMTP_REQUIRE_TLS = "false";
  runtimeEnvironment.SMTP_USER = "";
  runtimeEnvironment.SMTP_PASSWORD = "";
  runtimeEnvironment.SMTP_FROM = "noreply@nexora.example.test";

  await assert.rejects(verifyEmailDelivery(), (error: unknown) => {
    assert.ok(error instanceof EmailDeliveryError);
    assert.equal((error as Error).message, "Authentication email delivery failed");
    assert.ok(!(error as Error).message.includes("127.0.0.1"));
    assert.ok(!(error as Error).message.includes(String(port)));
    return true;
  });

  await assert.rejects(sendVerificationEmail("member@example.test", "token-test"), (error: unknown) => {
    assert.ok(error instanceof EmailDeliveryError);
    return true;
  });
});

test("delivery failure maps to a safe 503, never a success or an SMTP detail", async () => {
  const response = jsonServerFailure(
    new NextRequest("https://nexora.example.test/api/auth/register"),
    "auth.register",
    new EmailDeliveryError(),
  );
  const body = (await response.json()) as {
    error: { code: string; message: string };
    requestId: string;
  };
  assert.equal(response.status, 503);
  assert.equal(body.error.code, "EMAIL_DELIVERY_UNAVAILABLE");
  assert.equal(body.error.message, "Email delivery is unavailable right now. Please try again later.");
  assert.ok(!body.error.message.includes("127.0.0.1"));
  assert.ok(!body.error.message.includes("SMTP"));
});
