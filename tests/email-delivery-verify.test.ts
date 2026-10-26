import assert from "node:assert/strict";
import { after, test } from "node:test";
import { verifyEmailDelivery } from "../src/server/email.ts";
import { startSmtpCaptureServer, type SmtpCapture } from "./smtp-server.ts";

const runtimeEnvironment = process.env as unknown as Record<string, string | undefined>;
let smtp: SmtpCapture | undefined;

after(async () => {
  await smtp?.close();
});

test("SMTP verify succeeds against a reachable server, so valid config is not blocked", async () => {
  smtp = await startSmtpCaptureServer();
  runtimeEnvironment.APP_ORIGIN = "https://nexora.example.test";
  runtimeEnvironment.SMTP_HOST = "127.0.0.1";
  runtimeEnvironment.SMTP_PORT = String(smtp.port);
  runtimeEnvironment.SMTP_SECURE = "false";
  runtimeEnvironment.SMTP_REQUIRE_TLS = "false";
  runtimeEnvironment.SMTP_USER = "";
  runtimeEnvironment.SMTP_PASSWORD = "";
  runtimeEnvironment.SMTP_FROM = "noreply@nexora.example.test";

  await verifyEmailDelivery();
  assert.ok(true);
});
