import assert from "node:assert/strict";
import test from "node:test";
import {
  EmailConfigurationError,
  sendVerificationEmail,
  validateEmailDeliveryConfig,
} from "../src/server/email.ts";

const runtimeEnvironment = process.env as unknown as Record<string, string | undefined>;

function setBaseConfig() {
  runtimeEnvironment.APP_ORIGIN = "https://nexora.example.test";
  runtimeEnvironment.SMTP_HOST = "127.0.0.1";
  runtimeEnvironment.SMTP_PORT = "2525";
  runtimeEnvironment.SMTP_SECURE = "false";
  runtimeEnvironment.SMTP_REQUIRE_TLS = "false";
  runtimeEnvironment.SMTP_USER = "";
  runtimeEnvironment.SMTP_PASSWORD = "";
  runtimeEnvironment.SMTP_FROM = "noreply@nexora.example.test";
}

test("missing SMTP configuration is a configuration error, not a silent success", () => {
  setBaseConfig();
  delete runtimeEnvironment.SMTP_HOST;
  assert.throws(validateEmailDeliveryConfig, EmailConfigurationError);
});

test("missing app origin is a configuration error, not a silent success", () => {
  setBaseConfig();
  delete runtimeEnvironment.APP_ORIGIN;
  assert.throws(validateEmailDeliveryConfig, EmailConfigurationError);
});

test("sending with missing configuration rejects with a configuration error", async () => {
  setBaseConfig();
  delete runtimeEnvironment.SMTP_HOST;
  await assert.rejects(
    sendVerificationEmail("member@example.test", "token-test"),
    EmailConfigurationError,
  );
});
