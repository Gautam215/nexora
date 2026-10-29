import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server.js";
import { Client } from "pg";
import { POST as register } from "../src/app/api/auth/register/route.ts";
import { POST as login } from "../src/app/api/auth/login/route.ts";
import { POST as consumeVerification } from "../src/app/api/auth/verification/consume/route.ts";
import { DELETE as deleteAccount } from "../src/app/api/account/route.ts";
import { POST as totpSetup } from "../src/app/api/account/totp/setup/route.ts";
import { POST as totpVerify } from "../src/app/api/account/totp/verify/route.ts";
import { POST as totpDisable } from "../src/app/api/account/totp/disable/route.ts";
import { GET as totpStatus } from "../src/app/api/account/totp/status/route.ts";
import { POST as createOrganization } from "../src/app/api/organizations/route.ts";
import { DELETE as deleteOrganization } from "../src/app/api/organizations/[organizationId]/route.ts";
import { closeDatabasePool, withUserContext } from "../src/server/db.ts";
import { totpCode } from "../src/security/totp.ts";
import { startSmtpCaptureServer, type SmtpCapture } from "./smtp-server.ts";

const connectionString = process.env.NEXORA_TEST_DATABASE_URL;
const origin = "http://localhost:3000";
const runtimeEnvironment = process.env as unknown as Record<string, string | undefined>;
if (connectionString) process.env.DATABASE_URL = connectionString;
runtimeEnvironment.NODE_ENV = "test";
process.env.APP_ORIGIN = origin;
process.env.AUTH_RATE_LIMIT_HMAC_KEY = randomBytes(32).toString("hex");
process.env.NEXORA_TOTP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
delete process.env.NEXORA_TRUSTED_CLIENT_IP_HEADER;
let smtp: SmtpCapture | undefined;

after(async () => {
  await smtp?.close();
  await closeDatabasePool();
});

function apiRequest(
  path: string,
  method = "GET",
  body?: unknown,
  cookie?: string,
): NextRequest {
  const headers = new Headers();
  if (method !== "GET") headers.set("origin", origin);
  if (body !== undefined) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  return new NextRequest(`${origin}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function tokenFromMessage(message: string, pathname: string): string {
  const decoded = message
    .split(`=${String.fromCharCode(13, 10)}`)
    .join("")
    .replaceAll("=3D", "=");
  const marker = `${pathname}?token=`;
  const start = decoded.indexOf(marker);
  assert.ok(start >= 0, `expected ${pathname} token in captured email`);
  const rest = decoded.slice(start + marker.length);
  const end = rest.search(/[^A-Za-z0-9._~-]/);
  return end === -1 ? rest : rest.slice(0, end);
}

async function registerVerifyAndLogin(email: string, password: string) {
  const registered = await register(
    apiRequest("/api/auth/register", "POST", { name: "Totp User", email, password }),
  );
  assert.equal(registered.status, 202);
  const verificationToken = tokenFromMessage(smtp?.messages.at(-1) ?? "", "/verify-email");
  const verified = await consumeVerification(
    apiRequest("/api/auth/verification/consume", "POST", { token: verificationToken }),
  );
  assert.equal(verified.status, 200);
  const loginResponse = await login(
    apiRequest("/api/auth/login", "POST", { email, password }),
  );
  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get("set-cookie")?.match(/nexora_session=([^;]+)/)?.[1];
  assert.ok(cookie);
  const result = (await loginResponse.json()) as { data: { user: { id: string } } };
  return { userId: result.data.user.id, cookie: `nexora_session=${cookie}` };
}

async function enrollTotp(cookie: string) {
  const setup = await totpSetup(apiRequest("/api/account/totp/setup", "POST", {}, cookie));
  assert.equal(setup.status, 200, await setup.clone().text());
  const setupBody = (await setup.json()) as { data: { setup: { secret: string; otpauthUrl: string } } };
  const secret = setupBody.data.setup.secret;
  assert.ok(secret);
  assert.ok(setupBody.data.setup.otpauthUrl.includes(secret));
  const statusBefore = await totpStatus(apiRequest("/api/account/totp/status", "GET", undefined, cookie));
  const statusBeforeBody = (await statusBefore.json()) as { data: { enrolled: boolean } };
  assert.equal(statusBeforeBody.data.enrolled, false);
  const wrong = wrongCode(totpCode(secret, Date.now()));
  const wrongVerify = await totpVerify(apiRequest("/api/account/totp/verify", "POST", { code: wrong }, cookie));
  assert.equal(wrongVerify.status, 401, await wrongVerify.clone().text());
  const verified = await totpVerify(
    apiRequest("/api/account/totp/verify", "POST", { code: totpCode(secret, Date.now()) }, cookie),
  );
  assert.equal(verified.status, 200, await verified.clone().text());
  const statusAfter = await totpStatus(apiRequest("/api/account/totp/status", "GET", undefined, cookie));
  const statusAfterBody = (await statusAfter.json()) as { data: { enrolled: boolean } };
  assert.equal(statusAfterBody.data.enrolled, true);
  return secret;
}

function wrongCode(correct: string): string {
  return (correct[0] === "0" ? "1" : "0") + correct.slice(1);
}

test(
  "totp: enrollment, cross-user denial, delete gates, and disable",
  { skip: !connectionString },
  async () => {
    smtp = await startSmtpCaptureServer();
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = String(smtp.port);
    process.env.SMTP_USER = "";
    process.env.SMTP_PASSWORD = "";
    process.env.SMTP_FROM = "noreply@nexora.example.test";
    process.env.SMTP_REQUIRE_TLS = "false";

    // Unauthenticated calls fail as session errors, not factor errors.
    const anonStatus = await totpStatus(apiRequest("/api/account/totp/status"));
    assert.equal(anonStatus.status, 401);
    const anonStatusBody = (await anonStatus.json()) as { error: { code: string } };
    assert.equal(anonStatusBody.error.code, "AUTHENTICATION_REQUIRED");

    // Enrollment flow: pending until verified, wrong code rejected.
    const userA = await registerVerifyAndLogin("totp-a@nexora.example.test", "totp user password a");
    const secretA = await enrollTotp(userA.cookie);
    const alreadyVerified = await totpVerify(
      apiRequest("/api/account/totp/verify", "POST", { code: totpCode(secretA, Date.now()) }, userA.cookie),
    );
    assert.equal(alreadyVerified.status, 409);
    const alreadyBody = (await alreadyVerified.json()) as { error: { code: string } };
    assert.equal(alreadyBody.error.code, "TOTP_NOT_PENDING");

    // Cross-user denial: another member's context sees no TOTP row at all.
    const userB = await registerVerifyAndLogin("totp-b@nexora.example.test", "totp user password b");
    const client = new Client({ connectionString });
    await client.connect();
    try {
      await withUserContext(userB.userId, async (transaction) => {
        const rows = await transaction.query(
          "SELECT user_id FROM nexora.user_totp_credentials WHERE user_id = $1",
          [userA.userId],
        );
        assert.equal(rows.rowCount, 0);
        const own = await transaction.query("SELECT user_id FROM nexora.user_totp_credentials");
        assert.equal(own.rowCount, 0);
      });
    } finally {
      await client.end();
    }

    // Account delete gates: missing and wrong codes fail, the right code deletes.
    const userC = await registerVerifyAndLogin("totp-c@nexora.example.test", "totp user password c");
    const secretC = await enrollTotp(userC.cookie);
    const noCode = await deleteAccount(
      apiRequest("/api/account", "DELETE", { confirmation: "totp-c@nexora.example.test", password: "totp user password c" }, userC.cookie),
    );
    assert.equal(noCode.status, 401);
    const noCodeBody = (await noCode.json()) as { error: { code: string } };
    assert.equal(noCodeBody.error.code, "INVALID_CREDENTIALS");
    const badCode = await deleteAccount(
      apiRequest("/api/account", "DELETE", { confirmation: "totp-c@nexora.example.test", password: "totp user password c", totpCode: wrongCode(totpCode(secretC, Date.now())) }, userC.cookie),
    );
    assert.equal(badCode.status, 401);
    const deleted = await deleteAccount(
      apiRequest("/api/account", "DELETE", { confirmation: "totp-c@nexora.example.test", password: "totp user password c", totpCode: totpCode(secretC, Date.now()) }, userC.cookie),
    );
    assert.equal(deleted.status, 200, await deleted.clone().text());
    const deletedBody = (await deleted.json()) as { data: { deleted: boolean } };
    assert.equal(deletedBody.data.deleted, true);

    // Workspace delete gates for an enrolled owner.
    const userD = await registerVerifyAndLogin("totp-d@nexora.example.test", "totp user password d");
    const secretD = await enrollTotp(userD.cookie);
    const created = await createOrganization(
      apiRequest("/api/organizations", "POST", { name: "Totp Org", slug: "totp-org" }, userD.cookie),
    );
    assert.equal(created.status, 201, await created.clone().text());
    const createdBody = (await created.json()) as { data: { organization: { id: string } } };
    const orgId = createdBody.data.organization.id;
    const orgParams = { params: Promise.resolve({ organizationId: orgId }) };
    const orgNoCode = await deleteOrganization(
      apiRequest(`/api/organizations/${orgId}`, "DELETE", { slug: "totp-org", password: "totp user password d" }, userD.cookie),
      orgParams,
    );
    assert.equal(orgNoCode.status, 401);
    const orgDeleted = await deleteOrganization(
      apiRequest(`/api/organizations/${orgId}`, "DELETE", { slug: "totp-org", password: "totp user password d", totpCode: totpCode(secretD, Date.now()) }, userD.cookie),
      orgParams,
    );
    assert.equal(orgDeleted.status, 200, await orgDeleted.clone().text());

    // Disable flow: wrong code fails, right code disables, and the
    // account then deletes on password alone.
    const userE = await registerVerifyAndLogin("totp-e@nexora.example.test", "totp user password e");
    const secretE = await enrollTotp(userE.cookie);
    const badDisable = await totpDisable(
      apiRequest("/api/account/totp/disable", "POST", { password: "totp user password e", code: wrongCode(totpCode(secretE, Date.now())) }, userE.cookie),
    );
    assert.equal(badDisable.status, 401);
    const disabled = await totpDisable(
      apiRequest("/api/account/totp/disable", "POST", { password: "totp user password e", code: totpCode(secretE, Date.now()) }, userE.cookie),
    );
    assert.equal(disabled.status, 200, await disabled.clone().text());
    const statusOff = await totpStatus(apiRequest("/api/account/totp/status", "GET", undefined, userE.cookie));
    const statusOffBody = (await statusOff.json()) as { data: { enrolled: boolean } };
    assert.equal(statusOffBody.data.enrolled, false);
    const deletedAfterDisable = await deleteAccount(
      apiRequest("/api/account", "DELETE", { confirmation: "totp-e@nexora.example.test", password: "totp user password e" }, userE.cookie),
    );
    assert.equal(deletedAfterDisable.status, 200, await deletedAfterDisable.clone().text());
  },
);

test(
  "totp: re-enrollment setup requires the current code when already enrolled",
  { skip: !connectionString },
  async () => {
    if (!smtp) {
      smtp = await startSmtpCaptureServer();
      process.env.SMTP_HOST = "127.0.0.1";
      process.env.SMTP_PORT = String(smtp.port);
      process.env.SMTP_USER = "";
      process.env.SMTP_PASSWORD = "";
      process.env.SMTP_FROM = "noreply@nexora.example.test";
      process.env.SMTP_REQUIRE_TLS = "false";
    }

    const user = await registerVerifyAndLogin("totp-f@nexora.example.test", "totp user password f");
    const secret = await enrollTotp(user.cookie);

    // A bodyless re-setup must not silently replace the verified row
    // with a pending one: without a body there is no current code.
    const noBody = await totpSetup(apiRequest("/api/account/totp/setup", "POST", undefined, user.cookie));
    assert.equal(noBody.status, 415, await noBody.clone().text());
    const emptyBody = await totpSetup(apiRequest("/api/account/totp/setup", "POST", {}, user.cookie));
    assert.equal(emptyBody.status, 400, await emptyBody.clone().text());
    const wrong = await totpSetup(
      apiRequest("/api/account/totp/setup", "POST", { code: wrongCode(totpCode(secret, Date.now())) }, user.cookie),
    );
    assert.equal(wrong.status, 401, await wrong.clone().text());
    const wrongBody = (await wrong.json()) as { error: { code: string } };
    assert.equal(wrongBody.error.code, "INVALID_CREDENTIALS");

    // The blocked attempts changed nothing: the factor still gates
    // deletion, so the bypass (setup-reset, then password-only
    // delete) is closed.
    const stillEnrolled = await totpStatus(apiRequest("/api/account/totp/status", "GET", undefined, user.cookie));
    const stillEnrolledBody = (await stillEnrolled.json()) as { data: { enrolled: boolean } };
    assert.equal(stillEnrolledBody.data.enrolled, true);
    const passwordOnlyDelete = await deleteAccount(
      apiRequest("/api/account", "DELETE", { confirmation: "totp-f@nexora.example.test", password: "totp user password f" }, user.cookie),
    );
    assert.equal(passwordOnlyDelete.status, 401);

    // With the current code, re-enrollment opens and verifies.
    const reopened = await totpSetup(
      apiRequest("/api/account/totp/setup", "POST", { code: totpCode(secret, Date.now()) }, user.cookie),
    );
    assert.equal(reopened.status, 200, await reopened.clone().text());
    const reopenedBody = (await reopened.json()) as { data: { setup: { secret: string } } };
    const newSecret = reopenedBody.data.setup.secret;
    assert.ok(newSecret && newSecret !== secret);
    const reverified = await totpVerify(
      apiRequest("/api/account/totp/verify", "POST", { code: totpCode(newSecret, Date.now()) }, user.cookie),
    );
    assert.equal(reverified.status, 200, await reverified.clone().text());
    const enrolledAgain = await totpStatus(apiRequest("/api/account/totp/status", "GET", undefined, user.cookie));
    const enrolledAgainBody = (await enrolledAgain.json()) as { data: { enrolled: boolean } };
    assert.equal(enrolledAgainBody.data.enrolled, true);
  },
);
