import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server.js";
import { POST as acceptInvitation } from "../src/app/api/invitations/accept/route.ts";
import { POST as login } from "../src/app/api/auth/login/route.ts";
import { POST as register } from "../src/app/api/auth/register/route.ts";
import { POST as consumeVerification } from "../src/app/api/auth/verification/consume/route.ts";
import {
  POST as createInvitation,
} from "../src/app/api/organizations/[organizationId]/members/route.ts";
import {
  GET as openNotificationStream,
} from "../src/app/api/organizations/[organizationId]/notifications/stream/route.ts";
import {
  POST as addProjectMember,
} from "../src/app/api/organizations/[organizationId]/projects/[projectId]/members/route.ts";
import { closeDatabasePool } from "../src/server/db.ts";
import { startSmtpCaptureServer, type SmtpCapture } from "./smtp-server.ts";

const connectionString = process.env.NEXORA_TEST_DATABASE_URL;
const origin = "http://localhost:3000";
const runtimeEnvironment = process.env as unknown as Record<string, string | undefined>;
let smtp: SmtpCapture | undefined;
if (connectionString) process.env.DATABASE_URL = connectionString;
runtimeEnvironment.NODE_ENV = "test";
process.env.APP_ORIGIN = origin;
process.env.AUTH_RATE_LIMIT_HMAC_KEY = randomBytes(32).toString("hex");
delete process.env.NEXORA_TRUSTED_CLIENT_IP_HEADER;

after(async () => {
  await smtp?.close();
  await closeDatabasePool();
});

function apiRequest(
  path: string,
  method = "GET",
  body?: unknown,
  cookie?: string,
  signal?: AbortSignal,
): NextRequest {
  const headers = new Headers();
  if (method !== "GET") headers.set("origin", origin);
  if (body !== undefined) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  return new NextRequest(`${origin}${path}`, {
    method,
    headers,
    signal,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function tokenFromMessage(message: string, pathname: string): string {
  const decoded = message.replace(/=\r\n/g, "").replace(/=3D/gi, "=");
  const token = decoded.match(new RegExp(`${pathname}\\?token=([A-Za-z0-9_-]{43})`))?.[1];
  assert.ok(token, `expected ${pathname} token in captured email`);
  return token;
}

async function registerVerifyAndLogin(email: string, name: string, password: string) {
  const registered = await register(
    apiRequest("/api/auth/register", "POST", { name, email, password }),
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
  const result = (await loginResponse.json()) as {
    data: { user: { id: string; email: string } };
  };
  return { user: result.data.user, cookie: `nexora_session=${cookie}` };
}

async function inviteAndAccept(
  organizationId: string,
  ownerCookie: string,
  email: string,
  name: string,
  password: string,
) {
  const inviteResponse = await createInvitation(
    apiRequest(
      `/api/organizations/${organizationId}/members`,
      "POST",
      { email, role: "member" },
      ownerCookie,
    ),
    { params: Promise.resolve({ organizationId }) },
  );
  assert.equal(inviteResponse.status, 201);
  const invitationToken = tokenFromMessage(smtp?.messages.at(-1) ?? "", "/accept-invitation");
  const member = await registerVerifyAndLogin(email, name, password);
  const accepted = await acceptInvitation(
    apiRequest("/api/invitations/accept", "POST", { token: invitationToken }, member.cookie),
  );
  assert.equal(accepted.status, 200);
  return member;
}

async function readStreamUntil(
  response: Response,
  predicate: (text: string) => boolean,
  abort: () => void,
  timeoutMs = 15000,
): Promise<string> {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (value) text += decoder.decode(value, { stream: true });
      if (predicate(text)) return text;
      if (done) break;
    }
  } finally {
    abort();
    try {
      await reader.cancel();
    } catch {
      // Already closed.
    }
  }
  return text;
}

test(
  "per-user notification stream delivers only the recipient's notifications, and rejects anonymous and non-member connections",
  { skip: !connectionString },
  async () => {
    smtp = await startSmtpCaptureServer();
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = String(smtp.port);
    process.env.SMTP_SECURE = "false";
    process.env.SMTP_REQUIRE_TLS = "false";
    process.env.SMTP_USER = "";
    process.env.SMTP_PASSWORD = "";
    process.env.SMTP_FROM = "noreply@nexora.example.test";

    const owner = await registerVerifyAndLogin(
      `${randomUUID()}@example.test`,
      "Workspace Owner",
      "owner password long enough",
    );
    const organizationResponse = await (await import("../src/app/api/organizations/route.ts")).POST(
      apiRequest(
        "/api/organizations",
        "POST",
        { name: "Stream Studio", slug: `stream-${owner.user.id.slice(0, 8)}` },
        owner.cookie,
      ),
    );
    assert.equal(organizationResponse.status, 201);
    const organizationBody = (await organizationResponse.json()) as {
      data: { organization: { id: string } };
    };
    const organizationId = organizationBody.data.organization.id;
    const streamPath = `/api/organizations/${organizationId}/notifications/stream`;
    const streamParams = { params: Promise.resolve({ organizationId }) };

    const anonymous = await openNotificationStream(apiRequest(streamPath, "GET"), streamParams);
    assert.equal(anonymous.status, 401);
    const outsider = await registerVerifyAndLogin(
      `${randomUUID()}@example.test`,
      "Outsider",
      "outsider password long enough",
    );
    const outsiderStream = await openNotificationStream(
      apiRequest(streamPath, "GET", undefined, outsider.cookie),
      streamParams,
    );
    assert.equal(outsiderStream.status, 403);

    const recipient = await inviteAndAccept(
      organizationId,
      owner.cookie,
      `${randomUUID()}@example.test`,
      "Stream Recipient",
      "recipient password long enough",
    );
    const otherMember = await inviteAndAccept(
      organizationId,
      owner.cookie,
      `${randomUUID()}@example.test`,
      "Other Member",
      "other member password long enough",
    );
    const projectResponse = await (await import("../src/app/api/organizations/[organizationId]/projects/route.ts")).POST(
      apiRequest(
        `/api/organizations/${organizationId}/projects`,
        "POST",
        { name: "Stream Project" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId }) },
    );
    assert.equal(projectResponse.status, 201);
    const projectBody = (await projectResponse.json()) as {
      data: { project: { id: string } };
    };
    const projectId = projectBody.data.project.id;

    // The recipient opens a live stream before the notification
    // is created. Only the recipient's stream may receive it.
    const recipientController = new AbortController();
    const recipientResponse = await openNotificationStream(
      apiRequest(streamPath, "GET", undefined, recipient.cookie, recipientController.signal),
      streamParams,
    );
    assert.equal(recipientResponse.status, 200);

    const recipientTextPromise = readStreamUntil(
      recipientResponse,
      (text) => text.includes("event: notification.created") && text.includes("You were added to a project"),
      () => recipientController.abort(),
    );

    const added = await addProjectMember(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${projectId}/members`,
        "POST",
        { userId: recipient.user.id, role: "member" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(added.status, 201);

    const recipientText = await recipientTextPromise;
    assert.ok(recipientText.includes("event: notification.created"));
    assert.ok(recipientText.includes("You were added to a project"));

    // Isolation, via replay: the other member opens a stream with
    // a since timestamp before the notification was created. The
    // replay query filters by recipient, so it must return hello
    // only — never the recipient's notification, even though the
    // other member is in the same organization and project.
    // The same recipient filter drives the live poll loop.
    const otherController = new AbortController();
    const otherResponse = await openNotificationStream(
      apiRequest(
        `${streamPath}?since=1970-01-01T00%3A00%3A00.000Z`,
        "GET",
        undefined,
        otherMember.cookie,
        otherController.signal,
      ),
      streamParams,
    );
    assert.equal(otherResponse.status, 200);
    assert.ok(otherResponse.body);
    const otherReader = otherResponse.body.getReader();
    const otherDecoder = new TextDecoder();
    let otherText = "";
    const otherTimeout = setTimeout(() => otherController.abort(), 3000);
    try {
      while (true) {
        const { done, value } = await otherReader.read();
        if (value) otherText += otherDecoder.decode(value, { stream: true });
        if (done) break;
        if (otherText.includes("event: hello") && otherText.includes("event: notification.created")) break;
      }
    } catch {
      // Aborted by the timeout: the stream is closed, which is the
      // expected end of this isolation read.
    } finally {
      clearTimeout(otherTimeout);
      try {
        await otherReader.cancel();
      } catch {
        // Already closed.
      }
    }
    assert.ok(otherText.includes("event: hello"));
    assert.ok(!otherText.includes("You were added to a project"));
    assert.ok(!otherText.includes("event: notification.created"));
  },
);
