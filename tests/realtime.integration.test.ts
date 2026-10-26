import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server.js";
import { Client } from "pg";
import { POST as register } from "../src/app/api/auth/register/route.ts";
import { POST as login } from "../src/app/api/auth/login/route.ts";
import { POST as consumeVerification } from "../src/app/api/auth/verification/consume/route.ts";
import { POST as createOrganization } from "../src/app/api/organizations/route.ts";
import { POST as createProject } from "../src/app/api/organizations/[organizationId]/projects/route.ts";
import { POST as createTask } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/route.ts";
import { POST as createComment } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/[taskId]/comments/route.ts";
import { GET as openStream } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/realtime/stream/route.ts";
import { publishRealtimeEvent } from "../src/server/realtime/events.ts";
import { closeDatabasePool } from "../src/server/db.ts";
import { startSmtpCaptureServer, type SmtpCapture } from "./smtp-server.ts";

const connectionString = process.env.NEXORA_TEST_DATABASE_URL;
const migratorConnectionString = process.env.NEXORA_TEST_MIGRATOR_DATABASE_URL;
const origin = "http://localhost:3000";
const runtimeEnvironment = process.env as unknown as Record<string, string | undefined>;
if (connectionString) process.env.DATABASE_URL = connectionString;
runtimeEnvironment.NODE_ENV = "test";
process.env.APP_ORIGIN = origin;
process.env.AUTH_RATE_LIMIT_HMAC_KEY = randomBytes(32).toString("hex");
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
  idempotencyKey?: string,
): NextRequest {
  const headers = new Headers();
  if (method !== "GET") headers.set("origin", origin);
  if (body !== undefined) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
  return new NextRequest(`${origin}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// Fixture-only membership inserts (the same legitimacy as the
// browser fixtures inserting verified users directly): the invite
// flow itself is covered by its own tests, and this case is about
// stream delivery between two distinct members.
async function migratorExecAs(
  userId: string,
  organizationId: string,
  sql: string,
  params: unknown[] = [],
): Promise<void> {
  assert.ok(migratorConnectionString, "migrator connection required for this check");
  const client = new Client({ connectionString: migratorConnectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_catalog.set_config('nexora.user_id', $1, true), pg_catalog.set_config('nexora.organization_id', $2, true)",
      [userId, organizationId],
    );
    await client.query(sql, params as never[]);
    await client.query("COMMIT");
  } finally {
    await client.end();
  }
}

function tokenFromMessage(message: string): string {
  const decoded = message.replace(/=\r\n/g, "").replace(/=3D/gi, "=");
  const token = decoded.match(/\/verify-email\?token=([A-Za-z0-9._~-]+)/)?.[1];
  assert.ok(token);
  return token;
}

async function registerVerifyAndLogin(email: string, name: string, password: string) {
  const registered = await register(apiRequest("/api/auth/register", "POST", { name, email, password }));
  assert.equal(registered.status, 202);
  const verificationToken = tokenFromMessage(smtp?.messages.at(-1) ?? "");
  const verified = await consumeVerification(
    apiRequest("/api/auth/verification/consume", "POST", { token: verificationToken }),
  );
  assert.equal(verified.status, 200);
  const loginResponse = await login(apiRequest("/api/auth/login", "POST", { email, password }));
  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get("set-cookie")?.match(/nexora_session=([^;]+)/)?.[1];
  assert.ok(cookie);
  const result = (await loginResponse.json()) as { data: { user: { id: string } } };
  return { userId: result.data.user.id, cookie: `nexora_session=${cookie}` };
}

// Reads a stream response until the predicate matches, then aborts
// it (which must clear the route's poll and heartbeat timers).
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
    throw new Error(`Stream did not produce expected content in time. Got: ${text}`);
  } finally {
    abort();
    await reader.cancel().catch(() => undefined);
  }
}

test(
  "realtime stream delivers versioned events, replays missed ones, and enforces access",
  { skip: !connectionString },
  async () => {
    smtp = await startSmtpCaptureServer();
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_FROM = "noreply@nexora.example.test";
    process.env.SMTP_PORT = String(smtp.port);
    process.env.SMTP_SECURE = "false";
    process.env.SMTP_REQUIRE_TLS = "false";
    process.env.SMTP_USER = "";
    process.env.SMTP_PASSWORD = "";

    const owner = await registerVerifyAndLogin("rt-owner@example.test", "RT Owner", "correct horse battery staple");
    const orgResponse = await createOrganization(
      apiRequest("/api/organizations", "POST", { name: "RT Workspace", slug: "rt-workspace" }, owner.cookie),
    );
    assert.equal(orgResponse.status, 201);
    const orgId = ((await orgResponse.json()) as { data: { organization: { id: string } } }).data.organization.id;
    const projectResponse = await createProject(
      apiRequest(`/api/organizations/${orgId}/projects`, "POST", { name: "RT Project" }, owner.cookie),
      { params: Promise.resolve({ organizationId: orgId }) },
    );
    assert.equal(projectResponse.status, 201);
    const projectId = ((await projectResponse.json()) as { data: { project: { id: string } } }).data.project.id;
    const streamParams = { params: Promise.resolve({ organizationId: orgId, projectId }) };
    const streamPath = `/api/organizations/${orgId}/projects/${projectId}/realtime/stream`;

    // Anonymous and non-member connections are rejected before any
    // event byte is sent.
    const anonymous = await openStream(apiRequest(streamPath, "GET"), streamParams);
    assert.equal(anonymous.status, 401);
    const outsider = await registerVerifyAndLogin("rt-outsider@example.test", "RT Outsider", "correct horse battery staple");
    const outsiderStream = await openStream(apiRequest(streamPath, "GET", undefined, outsider.cookie), streamParams);
    assert.equal(outsiderStream.status, 403);

    // A project from another organization is a 404, not a leak.
    const otherOrgResponse = await createOrganization(
      apiRequest("/api/organizations", "POST", { name: "RT Other", slug: "rt-other" }, owner.cookie),
    );
    assert.equal(otherOrgResponse.status, 201);
    const otherOrgId = ((await otherOrgResponse.json()) as { data: { organization: { id: string } } }).data.organization.id;
    const crossOrg = await openStream(apiRequest(
      `/api/organizations/${otherOrgId}/projects/${projectId}/realtime/stream`,
      "GET",
      undefined,
      owner.cookie,
    ), { params: Promise.resolve({ organizationId: otherOrgId, projectId }) });
    assert.equal(crossOrg.status, 404);

    // Direct publish assigns sequential per-project versions.
    const first = await publishRealtimeEvent({
      userId: owner.userId,
      organizationId: orgId,
      projectId,
      type: "task.created",
      data: { taskId: "seed-task-1", taskTitle: "Seed task one" },
    });
    const second = await publishRealtimeEvent({
      userId: owner.userId,
      organizationId: orgId,
      projectId,
      type: "task.updated",
      data: { taskId: "seed-task-1", taskTitle: "Seed task one" },
    });
    assert.equal(first.version + 1, second.version);

    // A returning client replays only what it missed.
    {
      const controller = new AbortController();
      const response = await openStream(
        new NextRequest(`${origin}${streamPath}?since=${first.version}`, {
          headers: { cookie: owner.cookie },
          signal: controller.signal,
        }),
        streamParams,
      );
      assert.equal(response.status, 200);
      const text = await readStreamUntil(
        response,
        (chunk) => chunk.includes("event: hello") && chunk.includes("Seed task one") && chunk.includes("task.updated"),
        () => controller.abort(),
      );
      assert.ok(text.includes("event: hello"));
      assert.equal((text.match(/event: task\.created/g) ?? []).length, 0, "version 1 must not replay");
      assert.equal((text.match(/event: task\.updated/g) ?? []).length, 1);
    }

    // End-to-end wiring: creating a task through the API publishes
    // an event the stream delivers to a client that was up to date.
    const baselineController = new AbortController();
    const baselineResponse = await openStream(
      new NextRequest(`${origin}${streamPath}`, {
        headers: { cookie: owner.cookie },
        signal: baselineController.signal,
      }),
      streamParams,
    );
    const baselineText = await readStreamUntil(
      baselineResponse,
      (chunk) => chunk.includes("event: hello"),
      () => baselineController.abort(),
    );
    const latestVersion = Number(baselineText.match(/"latestVersion":(\d+)/)?.[1]);
    assert.ok(Number.isInteger(latestVersion));

    const taskResponse = await createTask(
      apiRequest(`/api/organizations/${orgId}/projects/${projectId}/tasks`, "POST", { title: "Wired realtime task" }, owner.cookie, "rt-task-1"),
      { params: Promise.resolve({ organizationId: orgId, projectId }) },
    );
    assert.equal(taskResponse.status, 201);
    const taskId = ((await taskResponse.json()) as { data: { task: { id: string } } }).data.task.id;
    {
      const controller = new AbortController();
      const response = await openStream(
        new NextRequest(`${origin}${streamPath}?since=${latestVersion}`, {
          headers: { cookie: owner.cookie },
          signal: controller.signal,
        }),
        streamParams,
      );
      const text = await readStreamUntil(
        response,
        (chunk) => chunk.includes("event: task.created") && chunk.includes("Wired realtime task"),
        () => controller.abort(),
      );
      assert.ok(text.includes("event: task.created"));
    }

    // Comment wiring: a comment through the API publishes too.
    const commentResponse = await createComment(
      apiRequest(
        `/api/organizations/${orgId}/projects/${projectId}/tasks/${taskId}/comments`,
        "POST",
        { body: "A realtime comment" },
        owner.cookie,
        "rt-comment-1",
      ),
      { params: Promise.resolve({ organizationId: orgId, projectId, taskId }) },
    );
    assert.equal(commentResponse.status, 201);
    {
      const controller = new AbortController();
      const response = await openStream(
        new NextRequest(`${origin}${streamPath}?since=${latestVersion + 1}`, {
          headers: { cookie: owner.cookie },
          signal: controller.signal,
        }),
        streamParams,
      );
      const text = await readStreamUntil(
        response,
        (chunk) => chunk.includes("event: comment.created"),
        () => controller.abort(),
      );
      assert.ok(text.includes("event: comment.created"));
    }

    // Two-client live delivery: a second member's already-open
    // stream receives a task the owner creates afterwards. This is
    // the Phase 5 completion criterion — not a replay of an event
    // that predates the connection, but a live poll-tick delivery
    // across two distinct users.
    const member = await registerVerifyAndLogin("rt-member@example.test", "RT Member", "correct horse battery staple");
    await migratorExecAs(
      owner.userId,
      orgId,
      `INSERT INTO nexora.organization_memberships
         (organization_id, user_id, role, status, invited_by, joined_at)
       VALUES ($1, $2, 'member', 'active', $3, pg_catalog.now())`,
      [orgId, member.userId, owner.userId],
    );
    await migratorExecAs(
      owner.userId,
      orgId,
      `INSERT INTO nexora.project_memberships
         (organization_id, project_id, user_id, role, status, added_by_user_id)
       VALUES ($1, $2, $3, 'member', 'active', $4)`,
      [orgId, projectId, member.userId, owner.userId],
    );
    {
      const controller = new AbortController();
      const response = await openStream(
        new NextRequest(`${origin}${streamPath}`, {
          headers: { cookie: member.cookie },
          signal: controller.signal,
        }),
        streamParams,
      );
      assert.equal(response.status, 200);
      const reader = response.body?.getReader();
      assert.ok(reader);
      const decoder = new TextDecoder();
      let text = "";
      try {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline && !text.includes("event: hello")) {
          const { done, value } = await reader.read();
          if (value) text += decoder.decode(value, { stream: true });
          if (done) break;
        }
        assert.ok(text.includes("event: hello"), "member stream must send hello before the mutation");
        const liveTask = await createTask(
          apiRequest(`/api/organizations/${orgId}/projects/${projectId}/tasks`, "POST", { title: "Live cross-user task" }, owner.cookie, "rt-task-live-1"),
          { params: Promise.resolve({ organizationId: orgId, projectId }) },
        );
        assert.equal(liveTask.status, 201);
        while (Date.now() < deadline && !text.includes("Live cross-user task")) {
          const { done, value } = await reader.read();
          if (value) text += decoder.decode(value, { stream: true });
          if (done) break;
        }
        assert.ok(text.includes("event: task.created"), "member stream must deliver the owner's new task");
        assert.ok(text.includes("Live cross-user task"));
      } finally {
        controller.abort();
        await reader.cancel().catch(() => undefined);
      }
    }

    // Presence: the member's join and leave reach the owner's
    // already-open stream as roster snapshots on the poll ticks.
    // The accumulated-text helper cannot express "latest roster",
    // so this case reads events and keeps only the newest presence
    // payload.
    {
      const ownerController = new AbortController();
      const ownerResponse = await openStream(
        new NextRequest(`${origin}${streamPath}`, {
          headers: { cookie: owner.cookie },
          signal: ownerController.signal,
        }),
        streamParams,
      );
      assert.equal(ownerResponse.status, 200);
      const ownerReader = ownerResponse.body?.getReader();
      assert.ok(ownerReader);
      const decoder = new TextDecoder();
      let buffer = "";
      let latestPresence: string | null = null;
      const readUntilPresence = async (
        predicate: (presence: string) => boolean,
        timeoutMs = 15000,
      ): Promise<string> => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const { done, value } = await ownerReader.read();
          if (value) {
            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split("\n\n");
            buffer = events.pop() ?? "";
            for (const event of events) {
              if (event.startsWith("event: presence.changed")) latestPresence = event;
            }
          }
          if (latestPresence && predicate(latestPresence)) return latestPresence;
          if (done) break;
        }
        throw new Error(`Presence did not reach the expected roster in time. Last: ${latestPresence}`);
      };
      try {
        // Wait for the owner's own initial roster first, so the
        // join below is observed as a change, not the first event.
        await readUntilPresence((presence) => presence.includes("RT Owner"));
        const memberController = new AbortController();
        const memberResponse = await openStream(
          new NextRequest(`${origin}${streamPath}`, {
            headers: { cookie: member.cookie },
            signal: memberController.signal,
          }),
          streamParams,
        );
        assert.equal(memberResponse.status, 200);
        const memberReader = memberResponse.body?.getReader();
        assert.ok(memberReader);
        try {
          const joined = await readUntilPresence((presence) => presence.includes("RT Member"));
          assert.ok(joined.includes("RT Owner"), "roster lists both members after join");
          memberController.abort();
          await memberReader.cancel().catch(() => undefined);
          const left = await readUntilPresence((presence) => !presence.includes("RT Member"));
          assert.ok(left.includes("RT Owner"), "roster still lists the owner after leave");
        } finally {
          memberController.abort();
          await memberReader.cancel().catch(() => undefined);
        }
      } finally {
        ownerController.abort();
        await ownerReader.cancel().catch(() => undefined);
      }
    }
  },
);
