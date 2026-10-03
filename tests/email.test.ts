import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sendPasswordResetEmail, sendVerificationEmail } from "../src/server/email.ts";
import { startSmtpCaptureServer, type SmtpCapture } from "./smtp-server.ts";

const runtimeEnvironment = process.env as unknown as Record<string, string | undefined>;
let smtp: SmtpCapture | undefined;

after(async () => {
  await smtp?.close();
});

test("SMTP adapter emits single-use links against the canonical origin", async () => {
  smtp = await startSmtpCaptureServer();
  runtimeEnvironment.APP_ORIGIN = "https://nexora.example.test";
  runtimeEnvironment.SMTP_HOST = "127.0.0.1";
  runtimeEnvironment.SMTP_PORT = String(smtp.port);
  runtimeEnvironment.SMTP_SECURE = "false";
  runtimeEnvironment.SMTP_REQUIRE_TLS = "false";
  runtimeEnvironment.SMTP_USER = "";
  runtimeEnvironment.SMTP_PASSWORD = "";
  runtimeEnvironment.SMTP_FROM = "noreply@nexora.example.test";

  await sendVerificationEmail("member@example.test", "verification-token-test");
  await sendPasswordResetEmail("member@example.test", "password-reset-token-test");

  assert.equal(smtp.messages.length, 2);
  const decoded = smtp.messages.map((message) => message.replace(/=\r\n/g, "").replace(/=3D/gi, "="));
  assert.match(decoded[0], /https:\/\/nexora\.example\.test\/verify-email\?token=verification-token-test/);
  assert.match(decoded[1], /https:\/\/nexora\.example\.test\/reset-password\?token=password-reset-token-test/);
  assert.match(decoded[0], /Confirm your Nexora email/);
  assert.match(decoded[1], /Reset your Nexora password/);
});
