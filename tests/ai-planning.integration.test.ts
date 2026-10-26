import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server.js";
import { Client } from "pg";
import { POST as register } from "../src/app/api/auth/register/route.ts";
import { POST as login } from "../src/app/api/auth/login/route.ts";
import { POST as consumeVerification } from "../src/app/api/auth/verification/consume/route.ts";
import { POST as createOrganization } from "../src/app/api/organizations/route.ts";
import { GET as listProjects } from "../src/app/api/organizations/[organizationId]/projects/route.ts";
import { GET as listMilestones } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/milestones/route.ts";
import { POST as generatePlan } from "../src/app/api/organizations/[organizationId]/ai/planning/generate/route.ts";
import { POST as confirmPlan } from "../src/app/api/organizations/[organizationId]/ai/planning/confirm/route.ts";
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

async function migratorCount(userId: string, organizationId: string, sql: string, params: unknown[]): Promise<number> {
  assert.ok(migratorConnectionString);
  const client = new Client({ connectionString: migratorConnectionString });
  await client.connect();
  try {
    await client.query(
      "SELECT pg_catalog.set_config('nexora.user_id', $1, true), pg_catalog.set_config('nexora.organization_id', $2, true)",
      [userId, organizationId],
    );
    const result = await client.query<{ count: string }>(sql, params as never[]);
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await client.end();
  }
}

async function projectCount(cookie: string, organizationId: string): Promise<number> {
  const response = await listProjects(apiRequest(`/api/organizations/${organizationId}/projects`, "GET", undefined, cookie), {
    params: Promise.resolve({ organizationId }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: { projects: unknown[] } };
  return body.data.projects.length;
}

test(
  "AI planning generates without creating, then confirms atomically with idempotency",
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

    const owner = await registerVerifyAndLogin("ai-plan-owner@example.test", "AI Plan Owner", "correct horse battery staple");
    const orgResponse = await createOrganization(
      apiRequest("/api/organizations", "POST", { name: "AI Plan Workspace", slug: "ai-plan-workspace" }, owner.cookie),
    );
    assert.equal(orgResponse.status, 201);
    const orgId = ((await orgResponse.json()) as { data: { organization: { id: string } } }).data.organization.id;
    const params = { params: Promise.resolve({ organizationId: orgId }) };

    // Unconfigured provider: fail closed, nothing created.
    delete process.env.AI_PROVIDER;
    const unconfigured = await generatePlan(
      apiRequest(`/api/organizations/${orgId}/ai/planning/generate`, "POST", { goal: "Launch a website" }, owner.cookie),
      params,
    );
    assert.equal(unconfigured.status, 503);
    assert.equal(await projectCount(owner.cookie, orgId), 0);

    // Mock provider: draft returned, still nothing created.
    process.env.AI_PROVIDER = "mock";
    const generated = await generatePlan(
      apiRequest(`/api/organizations/${orgId}/ai/planning/generate`, "POST", { goal: "Launch a website" }, owner.cookie),
      params,
    );
    assert.equal(generated.status, 200);
    const generatedBody = (await generated.json()) as {
      data: { draft: { milestones: { name: string; tasks: { title: string }[] }[] }; aiGenerated: boolean };
    };
    assert.equal(generatedBody.data.aiGenerated, true);
    assert.equal(generatedBody.data.draft.milestones[0].name, "Mock milestone");
    assert.equal(generatedBody.data.draft.milestones[0].tasks[0].title, "Mock task");
    assert.equal(await projectCount(owner.cookie, orgId), 0);

    // Confirm creates the project with its milestones and tasks.
    const draft = generatedBody.data.draft;
    const key = "ai-plan-confirm-key-1";
    const confirmed = await confirmPlan(
      apiRequest(
        `/api/organizations/${orgId}/ai/planning/confirm`,
        "POST",
        { projectName: "Planned Project", draft },
        owner.cookie,
        key,
      ),
      params,
    );
    assert.equal(confirmed.status, 201);
    const confirmedBody = (await confirmed.json()) as {
      data: { project: { id: string; name: string }; milestoneCount: number; taskCount: number };
    };
    assert.equal(confirmedBody.data.project.name, "Planned Project");
    assert.equal(confirmedBody.data.milestoneCount, 1);
    assert.equal(confirmedBody.data.taskCount, 1);
    assert.equal(await projectCount(owner.cookie, orgId), 1);
    const milestones = await listMilestones(
      apiRequest(
        `/api/organizations/${orgId}/projects/${confirmedBody.data.project.id}/milestones`,
        "GET",
        undefined,
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId: orgId, projectId: confirmedBody.data.project.id }) },
    );
    assert.equal(milestones.status, 200);
    const milestoneBody = (await milestones.json()) as { data: { milestones: { name: string }[] } };
    assert.equal(milestoneBody.data.milestones[0].name, "Mock milestone");

    // Replay with the same key and body returns the same project, no duplicate.
    const replayed = await confirmPlan(
      apiRequest(
        `/api/organizations/${orgId}/ai/planning/confirm`,
        "POST",
        { projectName: "Planned Project", draft },
        owner.cookie,
        key,
      ),
      params,
    );
    assert.equal(replayed.status, 201);
    const replayedBody = (await replayed.json()) as { data: { project: { id: string } } };
    assert.equal(replayedBody.data.project.id, confirmedBody.data.project.id);
    assert.equal(await projectCount(owner.cookie, orgId), 1);

    // Same key with a different body is a conflict, not a replay.
    const conflict = await confirmPlan(
      apiRequest(
        `/api/organizations/${orgId}/ai/planning/confirm`,
        "POST",
        { projectName: "Different Project", draft },
        owner.cookie,
        key,
      ),
      params,
    );
    assert.equal(conflict.status, 409);
    assert.equal(await projectCount(owner.cookie, orgId), 1);

    // Unknown, ambiguous, and cyclic dependencies all fail WITHOUT
    // creating a project.
    const unknownDep = await confirmPlan(
      apiRequest(
        `/api/organizations/${orgId}/ai/planning/confirm`,
        "POST",
        {
          projectName: "Bad Plan",
          draft: {
            milestones: [{ name: "M", tasks: [{ title: "A" }] }],
            dependencies: [{ from: "A", to: "Missing" }],
          },
        },
        owner.cookie,
        "ai-plan-unknown-dep-1",
      ),
      params,
    );
    assert.equal(unknownDep.status, 400);
    const ambiguousDep = await confirmPlan(
      apiRequest(
        `/api/organizations/${orgId}/ai/planning/confirm`,
        "POST",
        {
          projectName: "Bad Plan",
          draft: {
            milestones: [
              { name: "M1", tasks: [{ title: "Same" }] },
              { name: "M2", tasks: [{ title: "Same" }] },
            ],
            dependencies: [{ from: "Same", to: "Same" }],
          },
        },
        owner.cookie,
        "ai-plan-ambiguous-dep-1",
      ),
      params,
    );
    assert.equal(ambiguousDep.status, 400);
    const cyclicDep = await confirmPlan(
      apiRequest(
        `/api/organizations/${orgId}/ai/planning/confirm`,
        "POST",
        {
          projectName: "Bad Plan",
          draft: {
            milestones: [{ name: "M", tasks: [{ title: "A" }, { title: "B" }] }],
            dependencies: [
              { from: "A", to: "B" },
              { from: "B", to: "A" },
            ],
          },
        },
        owner.cookie,
        "ai-plan-cyclic-dep-1",
      ),
      params,
    );
    assert.equal(cyclicDep.status, 409);
    assert.equal(await projectCount(owner.cookie, orgId), 1);

    // A valid multi-task plan with a dependency creates the edge.
    const withDep = await confirmPlan(
      apiRequest(
        `/api/organizations/${orgId}/ai/planning/confirm`,
        "POST",
        {
          projectName: "Dep Project",
          draft: {
            milestones: [{ name: "M", tasks: [{ title: "First" }, { title: "Second" }] }],
            dependencies: [{ from: "First", to: "Second" }],
          },
        },
        owner.cookie,
        "ai-plan-dep-ok-1",
      ),
      params,
    );
    assert.equal(withDep.status, 201);
    const withDepBody = (await withDep.json()) as { data: { project: { id: string } } };
    const depCount = await migratorCount(
      owner.userId,
      orgId,
      "SELECT count(*)::text AS count FROM nexora.task_dependencies WHERE organization_id = $1 AND project_id = $2",
      [orgId, withDepBody.data.project.id],
    );
    assert.equal(depCount, 1);
    assert.equal(await projectCount(owner.cookie, orgId), 2);

    // Missing idempotency key and non-member access are rejected.
    const noKey = await confirmPlan(
      apiRequest(`/api/organizations/${orgId}/ai/planning/confirm`, "POST", {
        projectName: "No Key",
        draft,
      }, owner.cookie),
      params,
    );
    assert.equal(noKey.status, 400);
    const outsider = await registerVerifyAndLogin("ai-plan-outsider@example.test", "AI Outsider", "correct horse battery staple");
    const outsiderConfirm = await confirmPlan(
      apiRequest(
        `/api/organizations/${orgId}/ai/planning/confirm`,
        "POST",
        { projectName: "Outsider Plan", draft },
        outsider.cookie,
        "ai-plan-outsider-1",
      ),
      params,
    );
    assert.equal(outsiderConfirm.status, 403);
    delete process.env.AI_PROVIDER;
  },
);
