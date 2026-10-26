import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { NextRequest } from "next/server.js";
import { Client } from "pg";
import { POST as register } from "../src/app/api/auth/register/route.ts";
import { POST as login } from "../src/app/api/auth/login/route.ts";
import { POST as consumeVerification } from "../src/app/api/auth/verification/consume/route.ts";
import { POST as createOrganization } from "../src/app/api/organizations/route.ts";
import { POST as createOrganizationInvitation } from "../src/app/api/organizations/[organizationId]/members/route.ts";
import { POST as acceptInvitation } from "../src/app/api/invitations/accept/route.ts";
import { POST as createProject } from "../src/app/api/organizations/[organizationId]/projects/route.ts";
import { PATCH as updateProject } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/route.ts";
import { POST as addProjectMember } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/members/route.ts";
import {
  GET as listMilestones,
  POST as createMilestone,
} from "../src/app/api/organizations/[organizationId]/projects/[projectId]/milestones/route.ts";
import {
  DELETE as deleteMilestone,
  GET as getMilestone,
  PATCH as updateMilestone,
} from "../src/app/api/organizations/[organizationId]/projects/[projectId]/milestones/[milestoneId]/route.ts";
import { POST as createTask } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/route.ts";
import { GET as getTask } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/[taskId]/route.ts";
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
let privateFilesRoot: string | undefined;
let previousPrivateFileDirectory: string | undefined;
let previousFileSigningKey: string | undefined;

after(async () => {
  await smtp?.close();
  await closeDatabasePool();
  if (privateFilesRoot) await rm(privateFilesRoot, { recursive: true, force: true });
  if (previousPrivateFileDirectory === undefined) delete process.env.NEXORA_PRIVATE_FILE_DIR;
  else process.env.NEXORA_PRIVATE_FILE_DIR = previousPrivateFileDirectory;
  if (previousFileSigningKey === undefined) delete process.env.NEXORA_FILE_SIGNING_KEY;
  else process.env.NEXORA_FILE_SIGNING_KEY = previousFileSigningKey;
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
  const decoded = message.replace(/=\r\n/g, "").replace(/=3D/gi, "=");
  const token = decoded.match(new RegExp(`${pathname}\\?token=([A-Za-z0-9_-]+)`))?.[1];
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
  const result = (await loginResponse.json()) as { data: { user: { id: string } } };
  return { userId: result.data.user.id, cookie: `nexora_session=${cookie}`, email };
}

async function createWorkspace(cookie: string, slug: string) {
  const response = await createOrganization(
    apiRequest("/api/organizations", "POST", { name: "Milestone Workspace", slug }, cookie),
  );
  assert.equal(response.status, 201);
  const result = (await response.json()) as { data: { organization: { id: string } } };
  return result.data.organization.id;
}

async function inviteAndAccept(
  cookie: string,
  organizationId: string,
  email: string,
  role: string,
  userCookie: string,
) {
  const response = await createOrganizationInvitation(
    apiRequest(`/api/organizations/${organizationId}/members`, "POST", { email, role }, cookie),
    { params: Promise.resolve({ organizationId }) },
  );
  assert.equal(response.status, 201);
  const token = tokenFromMessage(smtp?.messages.at(-1) ?? "", "/accept-invitation");
  const accepted = await acceptInvitation(
    apiRequest("/api/invitations/accept", "POST", { token }, userCookie),
  );
  assert.equal(accepted.status, 200);
}

async function createProjectAs(cookie: string, organizationId: string, name: string) {
  const response = await createProject(
    apiRequest(`/api/organizations/${organizationId}/projects`, "POST", { name }, cookie),
    { params: Promise.resolve({ organizationId }) },
  );
  assert.equal(response.status, 201);
  const body = (await response.json()) as { data: { project: { id: string; version: number } } };
  return body.data.project;
}

async function createMilestoneAs(
  cookie: string,
  organizationId: string,
  projectId: string,
  name: string,
  dependencies: string[] = [],
) {
  const response = await createMilestone(
    apiRequest(
      `/api/organizations/${organizationId}/projects/${projectId}/milestones`,
      "POST",
      { name, dependencies },
      cookie,
      { "idempotency-key": `milestone-${projectId}-${name.replace(/\s+/g, "-").toLowerCase()}` },
    ),
    { params: Promise.resolve({ organizationId, projectId }) },
  );
  assert.equal(response.status, 201);
  const body = (await response.json()) as {
    data: { milestone: { id: string; version: number } };
  };
  return body.data.milestone;
}

async function deleteMilestoneAs(
  cookie: string,
  organizationId: string,
  projectId: string,
  milestoneId: string,
  expectedVersion: number,
) {
  return deleteMilestone(
    apiRequest(
      `/api/organizations/${organizationId}/projects/${projectId}/milestones/${milestoneId}`,
      "DELETE",
      { expectedVersion },
      cookie,
    ),
    { params: Promise.resolve({ organizationId, projectId, milestoneId }) },
  );
}

async function appQuery<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query(sql, params as never[]);
    return result.rows as T[];
  } finally {
    await client.end();
  }
}

async function migratorQuery<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  assert.ok(migratorConnectionString, "migrator connection required for this check");
  const client = new Client({ connectionString: migratorConnectionString });
  await client.connect();
  try {
    const result = await client.query(sql, params as never[]);
    return result.rows as T[];
  } finally {
    await client.end();
  }
}

async function migratorQueryAs<T>(
  userId: string,
  organizationId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  assert.ok(migratorConnectionString, "migrator connection required for this check");
  const client = new Client({ connectionString: migratorConnectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_catalog.set_config('nexora.user_id', $1, true), pg_catalog.set_config('nexora.organization_id', $2, true)",
      [userId, organizationId],
    );
    const result = await client.query(sql, params as never[]);
    await client.query("ROLLBACK");
    return result.rows as T[];
  } finally {
    await client.end();
  }
}

test(
  "milestone deletion soft-deletes, hides, detaches on purge, and keeps audit",
  { skip: !connectionString },
  async (t) => {
    smtp = await startSmtpCaptureServer();
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = String(smtp.port);
    process.env.SMTP_SECURE = "false";
    process.env.SMTP_REQUIRE_TLS = "false";
    process.env.SMTP_USER = "";
    process.env.SMTP_PASSWORD = "";
    process.env.SMTP_FROM = "noreply@nexora.example.test";
    previousPrivateFileDirectory = process.env.NEXORA_PRIVATE_FILE_DIR;
    previousFileSigningKey = process.env.NEXORA_FILE_SIGNING_KEY;
    privateFilesRoot = await mkdtemp(path.join(os.tmpdir(), "nexora-milestone-files-"));
    process.env.NEXORA_PRIVATE_FILE_DIR = privateFilesRoot;
    process.env.NEXORA_FILE_SIGNING_KEY = randomBytes(32).toString("hex");

    const owner = await registerVerifyAndLogin(
      `${randomUUID()}@example.test`,
      "Milestone Owner",
      "milestone owner password",
    );
    const organizationId = await createWorkspace(owner.cookie, `milestones-${owner.userId.slice(0, 8)}`);
    const project = await createProjectAs(owner.cookie, organizationId, "Milestone Project");

    const manager = await registerVerifyAndLogin(
      `${randomUUID()}@example.test`,
      "Milestone Manager",
      "milestone manager password",
    );
    await inviteAndAccept(owner.cookie, organizationId, manager.email, "member", manager.cookie);
    const managerAdded = await addProjectMember(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${project.id}/members`,
        "POST",
        { userId: manager.userId, role: "manager" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId: project.id }) },
    );
    assert.equal(managerAdded.status, 201);

    const member = await registerVerifyAndLogin(
      `${randomUUID()}@example.test`,
      "Milestone Member",
      "milestone member password",
    );
    await inviteAndAccept(owner.cookie, organizationId, member.email, "member", member.cookie);
    const memberAdded = await addProjectMember(
      apiRequest(
        `/api/organizations/${organizationId}/projects/${project.id}/members`,
        "POST",
        { userId: member.userId, role: "member" },
        owner.cookie,
      ),
      { params: Promise.resolve({ organizationId, projectId: project.id }) },
    );
    assert.equal(memberAdded.status, 201);

    const outsider = await registerVerifyAndLogin(
      `${randomUUID()}@example.test`,
      "Milestone Outsider",
      "milestone outsider password",
    );
    const otherOwner = await registerVerifyAndLogin(
      `${randomUUID()}@example.test`,
      "Other Owner",
      "other owner password",
    );
    const otherOrganizationId = await createWorkspace(otherOwner.cookie, `other-${otherOwner.userId.slice(0, 8)}`);

    const target = await createMilestoneAs(owner.cookie, organizationId, project.id, "Target Milestone");
    const doomed = await createMilestoneAs(owner.cookie, organizationId, project.id, "Doomed Milestone", [target.id]);
    const keeper = await createMilestoneAs(owner.cookie, organizationId, project.id, "Keeper Milestone");
    const purgee = await createMilestoneAs(owner.cookie, organizationId, project.id, "Purgee Milestone", [target.id]);

    const taskOnPurgee = await (async () => {
      const response = await createTask(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${project.id}/tasks`,
          "POST",
          { title: "Task on purgee", milestoneId: purgee.id },
          owner.cookie,
          { "idempotency-key": `task-purgee-${project.id}` },
        ),
        { params: Promise.resolve({ organizationId, projectId: project.id }) },
      );
      assert.equal(response.status, 201);
      const body = (await response.json()) as { data: { task: { id: string } } };
      return body.data.task.id;
    })();

    await t.test("managers can delete; members, viewers, and outsiders cannot", async () => {
      const stale = await deleteMilestoneAs(manager.cookie, organizationId, project.id, doomed.id, 999);
      assert.equal(stale.status, 409);
      const staleBody = (await stale.json()) as { error: { code: string } };
      assert.equal(staleBody.error.code, "VERSION_CONFLICT");

      const memberResponse = await deleteMilestoneAs(member.cookie, organizationId, project.id, doomed.id, doomed.version);
      assert.equal(memberResponse.status, 403);
      const memberBody = (await memberResponse.json()) as { error: { code: string } };
      assert.equal(memberBody.error.code, "PROJECT_MANAGEMENT_REQUIRED");

      // A caller outside the organization is rejected by the organization
      // context itself (403 ORGANIZATION_ACCESS_DENIED), while an org
      // member without project management rights gets
      // PROJECT_MANAGEMENT_REQUIRED. Neither reaches the milestone.
      const outsiderResponse = await deleteMilestoneAs(outsider.cookie, organizationId, project.id, doomed.id, doomed.version);
      assert.equal(outsiderResponse.status, 403);
      const outsiderBody = (await outsiderResponse.json()) as { error: { code: string } };
      assert.equal(outsiderBody.error.code, "ORGANIZATION_ACCESS_DENIED");

      const crossResponse = await deleteMilestoneAs(otherOwner.cookie, otherOrganizationId, project.id, doomed.id, doomed.version);
      assert.equal(crossResponse.status, 404);

      const deleted = await deleteMilestoneAs(manager.cookie, organizationId, project.id, doomed.id, doomed.version);
      assert.equal(deleted.status, 200);
      const deletedBody = (await deleted.json()) as { data: { milestoneId: string; deleted: boolean } };
      assert.equal(deletedBody.data.deleted, true);
      assert.equal(deletedBody.data.milestoneId, doomed.id);

      const again = await deleteMilestoneAs(manager.cookie, organizationId, project.id, doomed.id, doomed.version + 1);
      assert.equal(again.status, 404);
    });

    await t.test("deleted milestones disappear from reads and block new references", async () => {
      const detail = await getMilestone(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${project.id}/milestones/${doomed.id}`,
          "GET",
          undefined,
          owner.cookie,
        ),
        { params: Promise.resolve({ organizationId, projectId: project.id, milestoneId: doomed.id }) },
      );
      assert.equal(detail.status, 404);

      const listed = await listMilestones(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${project.id}/milestones`,
          "GET",
          undefined,
          owner.cookie,
        ),
        { params: Promise.resolve({ organizationId, projectId: project.id }) },
      );
      assert.equal(listed.status, 200);
      const listedBody = (await listed.json()) as {
        data: { milestones: { id: string; dependencies: { id: string }[] }[] };
      };
      assert.equal(listedBody.data.milestones.some((item) => item.id === doomed.id), false);
      assert.equal(
        listedBody.data.milestones.some((item) =>
          item.dependencies.some((dependency) => dependency.id === doomed.id),
        ),
        false,
      );

      const patched = await updateMilestone(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${project.id}/milestones/${doomed.id}`,
          "PATCH",
          { expectedVersion: doomed.version + 1, name: "Resurrected" },
          owner.cookie,
        ),
        { params: Promise.resolve({ organizationId, projectId: project.id, milestoneId: doomed.id }) },
      );
      assert.equal(patched.status, 404);

      const taskOnDeleted = await createTask(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${project.id}/tasks`,
          "POST",
          { title: "Task on deleted", milestoneId: doomed.id },
          owner.cookie,
          { "idempotency-key": `task-deleted-${project.id}` },
        ),
        { params: Promise.resolve({ organizationId, projectId: project.id }) },
      );
      assert.equal(taskOnDeleted.status, 404);

      const dependentPatch = await updateMilestone(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${project.id}/milestones/${target.id}`,
          "PATCH",
          { expectedVersion: target.version, dependencies: [doomed.id] },
          owner.cookie,
        ),
        { params: Promise.resolve({ organizationId, projectId: project.id, milestoneId: target.id }) },
      );
      assert.equal(dependentPatch.status, 404);
      const dependentBody = (await dependentPatch.json()) as { error: { code: string } };
      assert.equal(dependentBody.error.code, "MILESTONE_DEPENDENCY_NOT_FOUND");

      // A task already on a soft-deleted milestone stays readable, but the
      // deleted milestone's name and status must not leak through it.
      const windowMilestone = await createMilestoneAs(owner.cookie, organizationId, project.id, "Window Milestone");
      const windowTaskResponse = await createTask(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${project.id}/tasks`,
          "POST",
          { title: "Task on window milestone", milestoneId: windowMilestone.id },
          owner.cookie,
          { "idempotency-key": `task-window-${project.id}` },
        ),
        { params: Promise.resolve({ organizationId, projectId: project.id }) },
      );
      assert.equal(windowTaskResponse.status, 201);
      const windowTaskBody = (await windowTaskResponse.json()) as { data: { task: { id: string } } };
      const windowDeleted = await deleteMilestoneAs(
        manager.cookie,
        organizationId,
        project.id,
        windowMilestone.id,
        windowMilestone.version,
      );
      assert.equal(windowDeleted.status, 200);
      const windowFetched = await getTask(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${project.id}/tasks/${windowTaskBody.data.task.id}`,
          "GET",
          undefined,
          owner.cookie,
        ),
        {
          params: Promise.resolve({
            organizationId,
            projectId: project.id,
            taskId: windowTaskBody.data.task.id,
          }),
        },
      );
      assert.equal(windowFetched.status, 200);
      const windowBody = (await windowFetched.json()) as {
        data: { task: { milestone_name: string | null; milestone_status: string | null } };
      };
      assert.equal(windowBody.data.task.milestone_name, null);
      assert.equal(windowBody.data.task.milestone_status, null);
    });

    await t.test("deleting in a completed project is rejected", async () => {
      // A separate clean project: the main project can no longer complete
      // because the completion guard counts soft-deleted milestones (their
      // status stays 'planned'), and deleted milestones cannot be PATCHed
      // to completed. The clean project has one milestone, completed first.
      const closedProject = await createProjectAs(owner.cookie, organizationId, "Closed Project");
      const closedMilestone = await createMilestoneAs(owner.cookie, organizationId, closedProject.id, "Closed Milestone");
      const milestoneCompleted = await updateMilestone(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${closedProject.id}/milestones/${closedMilestone.id}`,
          "PATCH",
          { expectedVersion: closedMilestone.version, status: "completed" },
          owner.cookie,
        ),
        {
          params: Promise.resolve({
            organizationId,
            projectId: closedProject.id,
            milestoneId: closedMilestone.id,
          }),
        },
      );
      assert.equal(milestoneCompleted.status, 200);
      const active = await updateProject(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${closedProject.id}`,
          "PATCH",
          { expectedVersion: closedProject.version, status: "active" },
          owner.cookie,
        ),
        { params: Promise.resolve({ organizationId, projectId: closedProject.id }) },
      );
      assert.equal(active.status, 200);
      const activeBody = (await active.json()) as { data: { project: { version: number } } };
      const completed = await updateProject(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${closedProject.id}`,
          "PATCH",
          { expectedVersion: activeBody.data.project.version, status: "completed" },
          owner.cookie,
        ),
        { params: Promise.resolve({ organizationId, projectId: closedProject.id }) },
      );
      assert.equal(completed.status, 200);
      const completedBody = (await completed.json()) as { data: { project: { version: number } } };

      // The owner manages every project; the main project's manager holds
      // no role on this project and would get 403 before the closed check.
      const closed = await deleteMilestoneAs(
        owner.cookie,
        organizationId,
        closedProject.id,
        closedMilestone.id,
        closedMilestone.version + 1,
      );
      assert.equal(closed.status, 409);
      const closedBody = (await closed.json()) as { error: { code: string } };
      assert.equal(closedBody.error.code, "PROJECT_CLOSED");

      const reopened = await updateProject(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${closedProject.id}`,
          "PATCH",
          { expectedVersion: completedBody.data.project.version, status: "active" },
          owner.cookie,
        ),
        { params: Promise.resolve({ organizationId, projectId: closedProject.id }) },
      );
      assert.equal(reopened.status, 200);
    });

    await t.test(
      "purge detaches tasks, removes dependencies, and keeps audit",
      { skip: !migratorConnectionString },
      async () => {
        // Purgee must be API-deleted first: aging a live milestone would
        // set deleted_at while deleted_by_user_id is still NULL and trip
        // the paired-NULL CHECK (the keeper below is aged with both set).
        const purgeeDeleted = await deleteMilestoneAs(
          manager.cookie,
          organizationId,
          project.id,
          purgee.id,
          purgee.version,
        );
        assert.equal(purgeeDeleted.status, 200);
        await migratorQuery(
          "UPDATE nexora.milestones SET deleted_at = pg_catalog.now() - interval '31 days' WHERE id = $1",
          [purgee.id],
        );
        await migratorQuery(
          "UPDATE nexora.milestones SET deleted_at = pg_catalog.now() - interval '31 days' WHERE id = $1",
          [doomed.id],
        );
        // The keeper was never API-deleted, so its deleter must be set
        // alongside deleted_at or the paired-NULL CHECK rejects the row.
        await migratorQuery(
          "UPDATE nexora.milestones SET deleted_at = pg_catalog.now() - interval '29 days', deleted_by_user_id = $2 WHERE id = $1",
          [keeper.id, owner.userId],
        );

        const listed = await appQuery<{ milestone_id: string; task_count: number }>(
          "SELECT * FROM nexora.list_expired_milestones()",
        );
        // The app role has no tenant session, so the listing function is
        // the only way it can see expired milestones; it must include
        // both 31-day milestones and exclude the 29-day keeper.
        assert.ok(listed.some((row) => row.milestone_id === purgee.id));
        assert.ok(listed.some((row) => row.milestone_id === doomed.id));
        assert.equal(listed.some((row) => row.milestone_id === keeper.id), false);

        const purged = await appQuery<{ milestone_id: string; detached_task_count: number }>(
          "SELECT * FROM nexora.purge_expired_milestones()",
        );
        assert.ok(purged.some((row) => row.milestone_id === purgee.id && row.detached_task_count === 1));
        assert.ok(purged.some((row) => row.milestone_id === doomed.id && row.detached_task_count === 0));
        assert.equal(purged.some((row) => row.milestone_id === keeper.id), false);

        const gone = await migratorQuery<{ id: string }>(
          "SELECT id FROM nexora.milestones WHERE id = ANY($1::uuid[])",
          [[purgee.id, doomed.id]],
        );
        assert.equal(gone.length, 0);
        const kept = await migratorQuery<{ id: string }>(
          "SELECT id FROM nexora.milestones WHERE id = $1",
          [keeper.id],
        );
        assert.equal(kept.length, 1);

        const task = await migratorQuery<{ id: string; milestone_id: string | null }>(
          "SELECT id, milestone_id FROM nexora.tasks WHERE id = $1",
          [taskOnPurgee],
        );
        assert.equal(task.length, 1);
        assert.equal(task[0]?.milestone_id, null);

        const deps = await migratorQuery<{ count: string }>(
          `SELECT count(*)::text AS count FROM nexora.milestone_dependencies
           WHERE milestone_id = ANY($1::uuid[]) OR depends_on_milestone_id = ANY($1::uuid[])`,
          [[purgee.id, doomed.id]],
        );
        assert.equal(deps[0]?.count, "0");

        const audits = await migratorQueryAs<{ action: string }>(
          owner.userId,
          organizationId,
          `SELECT action FROM nexora.audit_events
           WHERE target_type = 'milestone' AND target_id = $1 ORDER BY created_at`,
          [purgee.id],
        );
        assert.deepEqual(
          audits.map((row) => row.action),
          ["milestone.created", "milestone.deleted"],
        );
      },
    );

    await t.test(
      "purge skips milestones in archived projects without blocking others",
      { skip: !migratorConnectionString },
      async () => {
        // Archiving after deletion is reachable (unlike completion, which
        // the guard blocks while any milestone is uncompleted), and the
        // task guard then refuses the detach. That milestone must stay
        // expired for a later retry, not abort the whole purge.
        const archProject = await createProjectAs(owner.cookie, organizationId, "Archived Project");
        const archMilestone = await createMilestoneAs(owner.cookie, organizationId, archProject.id, "Archived Milestone");
        const archTaskResponse = await createTask(
          apiRequest(
            `/api/organizations/${organizationId}/projects/${archProject.id}/tasks`,
            "POST",
            { title: "Task on archived milestone", milestoneId: archMilestone.id },
            owner.cookie,
            { "idempotency-key": `task-arch-${archProject.id}` },
          ),
          { params: Promise.resolve({ organizationId, projectId: archProject.id }) },
        );
        assert.equal(archTaskResponse.status, 201);
        const archTaskBody = (await archTaskResponse.json()) as { data: { task: { id: string } } };
        const archDeleted = await deleteMilestoneAs(
          owner.cookie,
          organizationId,
          archProject.id,
          archMilestone.id,
          archMilestone.version,
        );
        assert.equal(archDeleted.status, 200);
        const archived = await updateProject(
          apiRequest(
            `/api/organizations/${organizationId}/projects/${archProject.id}`,
            "PATCH",
            { expectedVersion: archProject.version, status: "archived" },
            owner.cookie,
          ),
          { params: Promise.resolve({ organizationId, projectId: archProject.id }) },
        );
        assert.equal(archived.status, 200);
        await migratorQuery(
          "UPDATE nexora.milestones SET deleted_at = pg_catalog.now() - interval '31 days' WHERE id = $1",
          [archMilestone.id],
        );

        const purged = await appQuery<{ milestone_id: string }>(
          "SELECT * FROM nexora.purge_expired_milestones()",
        );
        assert.equal(purged.some((row) => row.milestone_id === archMilestone.id), false);
        const stillThere = await migratorQuery<{ id: string }>(
          "SELECT id FROM nexora.milestones WHERE id = $1",
          [archMilestone.id],
        );
        assert.equal(stillThere.length, 1);
        const stillLinked = await migratorQuery<{ milestone_id: string | null }>(
          "SELECT milestone_id FROM nexora.tasks WHERE id = $1",
          [archTaskBody.data.task.id],
        );
        assert.equal(stillLinked[0]?.milestone_id, archMilestone.id);
      },
    );

    await t.test(
      "cleanup --dry-run reports without deleting, and the real run purges",
      { skip: !migratorConnectionString },
      async () => {
        // A second expired milestone, aged 31 days, for the script run.
        const scriptMilestone = await createMilestoneAs(owner.cookie, organizationId, project.id, "Script Milestone");
        const deleted = await deleteMilestoneAs(
          manager.cookie,
          organizationId,
          project.id,
          scriptMilestone.id,
          scriptMilestone.version,
        );
        assert.equal(deleted.status, 200);
        await migratorQuery(
          "UPDATE nexora.milestones SET deleted_at = pg_catalog.now() - interval '31 days' WHERE id = $1",
          [scriptMilestone.id],
        );

        const repoRoot = fileURLToPath(new URL("../", import.meta.url));
        const scriptArgs = [
          "--import=./scripts/load-env.mjs",
          "--conditions=react-server",
          "--experimental-strip-types",
          "scripts/cleanup-task-files.mjs",
        ];
        const scriptEnv = {
          ...process.env,
          DATABASE_URL: connectionString,
          NEXORA_PRIVATE_FILE_DIR: privateFilesRoot,
        };
        const execFileAsync = promisify(execFile);

        const dryRun = await execFileAsync(process.execPath, [...scriptArgs, "--dry-run"], {
          cwd: repoRoot,
          env: scriptEnv,
        });
        assert.match(dryRun.stdout, /expired milestone\(s\)/);
        assert.ok(dryRun.stdout.includes(scriptMilestone.id));
        const afterDryRun = await migratorQuery<{ id: string }>(
          "SELECT id FROM nexora.milestones WHERE id = $1",
          [scriptMilestone.id],
        );
        assert.equal(afterDryRun.length, 1);

        const realRun = await execFileAsync(process.execPath, scriptArgs, {
          cwd: repoRoot,
          env: scriptEnv,
        });
        assert.match(realRun.stdout, /Milestone cleanup removed \d+ expired milestone/);
        const afterRealRun = await migratorQuery<{ id: string }>(
          "SELECT id FROM nexora.milestones WHERE id = $1",
          [scriptMilestone.id],
        );
        assert.equal(afterRealRun.length, 0);
      },
    );

    await t.test("tasks on a deleted milestone stay readable without its name", async () => {
      const fetched = await getTask(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${project.id}/tasks/${taskOnPurgee}`,
          "GET",
          undefined,
          owner.cookie,
        ),
        { params: Promise.resolve({ organizationId, projectId: project.id, taskId: taskOnPurgee }) },
      );
      assert.equal(fetched.status, 200);
      const body = (await fetched.json()) as { data: { task: { milestone_status: string | null } } };
      assert.equal(body.data.task.milestone_status, null);
    });
  },
);
