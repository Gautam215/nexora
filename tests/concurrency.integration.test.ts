import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server.js";
import { POST as register } from "../src/app/api/auth/register/route.ts";
import { POST as login } from "../src/app/api/auth/login/route.ts";
import { POST as consumeVerification } from "../src/app/api/auth/verification/consume/route.ts";
import { POST as createOrganization } from "../src/app/api/organizations/route.ts";
import { POST as createProject } from "../src/app/api/organizations/[organizationId]/projects/route.ts";
import { POST as createTask } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/route.ts";
import { GET as getTask, PATCH as updateTask } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/[taskId]/route.ts";
import {
  GET as listComments,
  POST as createComment,
} from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/[taskId]/comments/route.ts";
import { publishRealtimeEvent } from "../src/server/realtime/events.ts";
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

after(async () => {
  await smtp?.close();
  await closeDatabasePool();
});

function apiRequest(
  path: string,
  method = "GET",
  body?: unknown,
  cookie?: string,
  extraHeaders?: Record<string, string>,
): NextRequest {
  const headers = new Headers(extraHeaders);
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

async function setupProject(suffix: string) {
  const email = `concurrency-${suffix}@example.test`;
  const registered = await register(
    apiRequest("/api/auth/register", "POST", { name: "Concurrency User", email, password: "concurrency user password" }),
  );
  assert.equal(registered.status, 202);
  const verificationToken = tokenFromMessage(smtp?.messages.at(-1) ?? "", "/verify-email");
  const verified = await consumeVerification(
    apiRequest("/api/auth/verification/consume", "POST", { token: verificationToken }),
  );
  assert.equal(verified.status, 200);
  const loginResponse = await login(apiRequest("/api/auth/login", "POST", { email, password: "concurrency user password" }));
  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get("set-cookie")?.match(/nexora_session=([^;]+)/)?.[1];
  assert.ok(cookie);
  const session = { cookie: `nexora_session=${cookie}` };
  const user = (await loginResponse.json()) as { data: { user: { id: string } } };
  const userId = user.data.user.id;

  const orgResponse = await createOrganization(
    apiRequest("/api/organizations", "POST", { name: `Concurrency Org ${suffix}`, slug: `concurrency-org-${suffix}` }, session.cookie),
  );
  assert.equal(orgResponse.status, 201, await orgResponse.clone().text());
  const org = (await orgResponse.json()) as { data: { organization: { id: string } } };
  const organizationId = org.data.organization.id;

  const projectResponse = await createProject(
    apiRequest(`/api/organizations/${organizationId}/projects`, "POST", { name: `Concurrency Project ${suffix}` }, session.cookie),
    { params: Promise.resolve({ organizationId }) },
  );
  assert.equal(projectResponse.status, 201, await projectResponse.clone().text());
  const project = (await projectResponse.json()) as { data: { project: { id: string } } };
  const projectId = project.data.project.id;
  return { session, userId, organizationId, projectId };
}

test(
  "concurrent mutations: one version-guarded update wins, concurrent comments both land, realtime versions never collide",
  { skip: !connectionString },
  async () => {
    smtp = await startSmtpCaptureServer();
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = String(smtp.port);
    process.env.SMTP_SECURE = "false";
    process.env.SMTP_REQUIRE_TLS = "false";
    process.env.SMTP_FROM = "noreply@nexora.example.test";
    process.env.SMTP_USER = "";
    process.env.SMTP_PASSWORD = "";

    const suffix = randomUUID().slice(0, 8);
    const { session, userId, organizationId, projectId } = await setupProject(suffix);

    const taskResponse = await createTask(
      apiRequest(`/api/organizations/${organizationId}/projects/${projectId}/tasks`, "POST", { title: `Concurrency Task ${suffix}` }, session.cookie, { "idempotency-key": `concurrency-task-${suffix}` }),
      { params: Promise.resolve({ organizationId, projectId }) },
    );
    assert.equal(taskResponse.status, 201, await taskResponse.clone().text());
    const task = (await taskResponse.json()) as { data: { task: { id: string } } };
    const taskId = task.data.task.id;
    const taskBase = `/api/organizations/${organizationId}/projects/${projectId}/tasks/${taskId}`;

    const fetched = await getTask(
      apiRequest(taskBase, "GET", undefined, session.cookie),
      { params: Promise.resolve({ organizationId, projectId, taskId }) },
    );
    assert.equal(fetched.status, 200, await fetched.clone().text());
    const fetchedTask = (await fetched.json()) as { data: { task: { version: number } } };
    const version = fetchedTask.data.task.version;

    // Two updates racing on the same expected version: the
    // project-graph lock serializes them, so exactly one wins
    // and the other sees the bumped version and conflicts.
    const [first, second] = await Promise.all([
      updateTask(
        apiRequest(taskBase, "PATCH", { title: `Race A ${suffix}`, expectedVersion: version }, session.cookie),
        { params: Promise.resolve({ organizationId, projectId, taskId }) },
      ),
      updateTask(
        apiRequest(taskBase, "PATCH", { title: `Race B ${suffix}`, expectedVersion: version }, session.cookie),
        { params: Promise.resolve({ organizationId, projectId, taskId }) },
      ),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409]);

    // Two comments racing with different keys: both land, none
    // is lost or duplicated.
    const commentBase = `${taskBase}/comments`;
    const [commentA, commentB] = await Promise.all([
      createComment(
        apiRequest(commentBase, "POST", { body: `race comment A ${suffix}` }, session.cookie, { "idempotency-key": `race-comment-a-${suffix}` }),
        { params: Promise.resolve({ organizationId, projectId, taskId }) },
      ),
      createComment(
        apiRequest(commentBase, "POST", { body: `race comment B ${suffix}` }, session.cookie, { "idempotency-key": `race-comment-b-${suffix}` }),
        { params: Promise.resolve({ organizationId, projectId, taskId }) },
      ),
    ]);
    assert.equal(commentA.status, 201, await commentA.clone().text());
    assert.equal(commentB.status, 201, await commentB.clone().text());
    const listed = await listComments(
      apiRequest(commentBase, "GET", undefined, session.cookie),
      { params: Promise.resolve({ organizationId, projectId, taskId }) },
    );
    assert.equal(listed.status, 200, await listed.clone().text());
    const listedData = (await listed.json()) as { data: { comments: Array<{ body: string }> } };
    const bodies = listedData.data.comments.map((c) => c.body);
    assert.ok(bodies.includes(`race comment A ${suffix}`));
    assert.ok(bodies.includes(`race comment B ${suffix}`));

    // Five realtime publishes racing on one project: versions
    // are strictly increasing with no duplicates, even though
    // the publishes ran concurrently.
    const published = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        publishRealtimeEvent({
          userId,
          organizationId,
          projectId,
          type: "project.updated",
          data: { projectId, projectName: `race ${index}` },
        }),
      ),
    );
    const versions = published.map((event) => event.version).sort((a, b) => a - b);
    assert.equal(new Set(versions).size, 5);
    for (let index = 1; index < versions.length; index += 1) {
      assert.ok(versions[index]! > versions[index - 1]!);
    }
    assert.equal(versions[4]! - versions[0]!, 4);
  },
);
