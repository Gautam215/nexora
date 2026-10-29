import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server.js";
import { Client } from "pg";
import { POST as register } from "../src/app/api/auth/register/route.ts";
import { POST as login } from "../src/app/api/auth/login/route.ts";
import { POST as consumeVerification } from "../src/app/api/auth/verification/consume/route.ts";
import { POST as createOrganization, GET as listOrganizations } from "../src/app/api/organizations/route.ts";
import {
  DELETE as deleteOrganization,
  GET as getOrganization,
} from "../src/app/api/organizations/[organizationId]/route.ts";
import { POST as createOrganizationInvitation, GET as listMembers } from "../src/app/api/organizations/[organizationId]/members/route.ts";
import { GET as listNotifications } from "../src/app/api/organizations/[organizationId]/notifications/route.ts";
import { GET as searchWorkspace } from "../src/app/api/organizations/[organizationId]/search/route.ts";
import { POST as createProject, GET as listProjects } from "../src/app/api/organizations/[organizationId]/projects/route.ts";
import { POST as addProjectMember } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/members/route.ts";
import { POST as acceptInvitation } from "../src/app/api/invitations/accept/route.ts";
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
let previousPrivateFileDirectory: string | undefined;
let previousFileSigningKey: string | undefined;
let privateFilesRoot = "";

after(async () => {
  await smtp?.close();
  if (previousPrivateFileDirectory === undefined) delete process.env.NEXORA_PRIVATE_FILE_DIR;
  else process.env.NEXORA_PRIVATE_FILE_DIR = previousPrivateFileDirectory;
  if (previousFileSigningKey === undefined) delete process.env.NEXORA_FILE_SIGNING_KEY;
  else process.env.NEXORA_FILE_SIGNING_KEY = previousFileSigningKey;
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
  return { userId: result.data.user.id, cookie: `nexora_session=${cookie}`, email, password };
}

async function createWorkspace(cookie: string, slug: string) {
  const response = await createOrganization(
    apiRequest("/api/organizations", "POST", { name: `Workspace ${slug}`, slug }, cookie),
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
    apiRequest(
      `/api/organizations/${organizationId}/members`,
      "POST",
      { email, role },
      cookie,
    ),
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
  const body = (await response.json()) as { data: { project: { id: string } } };
  return body.data.project;
}

async function deleteOrganizationAs(
  cookie: string,
  organizationId: string,
  body: Record<string, unknown>,
  password: string,
) {
  return deleteOrganization(
    apiRequest(`/api/organizations/${organizationId}`, "DELETE", { ...body, password }, cookie),
    { params: Promise.resolve({ organizationId }) },
  );
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

// Runs SQL as the migrator with a tenant session, so triggers that
// require tenant context (task graph lock) and row-level security
// behave as they do in routes.
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

async function appQuery<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  assert.ok(connectionString, "app connection required for this check");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query(sql, params as never[]);
    return result.rows as T[];
  } finally {
    await client.end();
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test(
  "organization deletion soft-deletes, hides, purges, and keeps audit",
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
    privateFilesRoot = await mkdtemp(path.join(os.tmpdir(), "nexora-org-files-"));
    process.env.NEXORA_PRIVATE_FILE_DIR = privateFilesRoot;
    process.env.NEXORA_FILE_SIGNING_KEY = randomBytes(32).toString("hex");

    const owner = await registerVerifyAndLogin(
      `${randomUUID()}@example.test`,
      "Org Owner",
      "org owner password one",
    );
    const admin = await registerVerifyAndLogin(
      `${randomUUID()}@example.test`,
      "Org Admin",
      "org admin password two",
    );
    const member = await registerVerifyAndLogin(
      `${randomUUID()}@example.test`,
      "Org Member",
      "org member password three",
    );
    const outsider = await registerVerifyAndLogin(
      `${randomUUID()}@example.test`,
      "Org Outsider",
      "org outsider password four",
    );

    await t.test("owner deletes with slug confirmation and the workspace becomes invisible", async () => {
      const slug = `del-${owner.userId.slice(0, 8)}`;
      const organizationId = await createWorkspace(owner.cookie, slug);
      await inviteAndAccept(owner.cookie, organizationId, admin.email, "admin", admin.cookie);
      await inviteAndAccept(owner.cookie, organizationId, member.email, "member", member.cookie);

      const deleted = await deleteOrganizationAs(owner.cookie, organizationId, { slug }, owner.password);
      assert.equal(deleted.status, 200);
      const body = (await deleted.json()) as { data: { organizationId: string; deleted: boolean } };
      assert.equal(body.data.organizationId, organizationId);
      assert.equal(body.data.deleted, true);

      const audit = await migratorQuery<{ action: string }>(
        "SELECT action FROM nexora.audit_events WHERE organization_id = $1 AND action = 'organization.deleted'",
        [organizationId],
      );
      assert.equal(audit.length, 1);

      const fetched = await getOrganization(
        apiRequest(`/api/organizations/${organizationId}`, "GET", undefined, owner.cookie),
        { params: Promise.resolve({ organizationId }) },
      );
      assert.equal(fetched.status, 404);

      const listed = await listOrganizations(
        apiRequest("/api/organizations", "GET", undefined, owner.cookie),
      );
      assert.equal(listed.status, 200);
      const listedBody = (await listed.json()) as { data: { organizations: { id: string }[] } };
      assert.ok(!listedBody.data.organizations.some((org) => org.id === organizationId));

      const projects = await listProjects(
        apiRequest(`/api/organizations/${organizationId}/projects`, "GET", undefined, owner.cookie),
        { params: Promise.resolve({ organizationId }) },
      );
      assert.equal(projects.status, 404);
      const projectsBody = (await projects.json()) as { error: { code: string } };
      assert.equal(projectsBody.error.code, "ORGANIZATION_NOT_FOUND");

      const searched = await searchWorkspace(
        apiRequest(`/api/organizations/${organizationId}/search?q=test`, "GET", undefined, owner.cookie),
        { params: Promise.resolve({ organizationId }) },
      );
      assert.equal(searched.status, 404);

      const notifications = await listNotifications(
        apiRequest(`/api/organizations/${organizationId}/notifications`, "GET", undefined, owner.cookie),
        { params: Promise.resolve({ organizationId }) },
      );
      assert.equal(notifications.status, 404);

      const members = await listMembers(
        apiRequest(`/api/organizations/${organizationId}/members`, "GET", undefined, owner.cookie),
        { params: Promise.resolve({ organizationId }) },
      );
      assert.equal(members.status, 404);
    });

    await t.test("deletion is owner-only, slug-confirmed, and single-use", async () => {
      const slug = `auth-${owner.userId.slice(0, 8)}`;
      const organizationId = await createWorkspace(owner.cookie, slug);
      await inviteAndAccept(owner.cookie, organizationId, admin.email, "admin", admin.cookie);
      await inviteAndAccept(owner.cookie, organizationId, member.email, "member", member.cookie);

      const byAdmin = await deleteOrganizationAs(admin.cookie, organizationId, { slug }, admin.password);
      assert.equal(byAdmin.status, 403);
      const byMember = await deleteOrganizationAs(member.cookie, organizationId, { slug }, member.password);
      assert.equal(byMember.status, 403);
      const byOutsider = await deleteOrganizationAs(outsider.cookie, organizationId, { slug }, outsider.password);
      assert.equal(byOutsider.status, 403);
      const outsiderBody = (await byOutsider.json()) as { error: { code: string } };
      assert.equal(outsiderBody.error.code, "ORGANIZATION_ACCESS_DENIED");

      const wrongSlug = await deleteOrganizationAs(owner.cookie, organizationId, { slug: "not-this-slug" }, owner.password);
      assert.equal(wrongSlug.status, 409);
      const wrongSlugBody = (await wrongSlug.json()) as { error: { code: string } };
      assert.equal(wrongSlugBody.error.code, "ORGANIZATION_SLUG_MISMATCH");

      // Wrong password is rejected even with the right slug, and
      // the workspace survives: a stolen session alone cannot
      // destroy it. The delete below still succeeding proves it.
      const wrongPassword = await deleteOrganizationAs(owner.cookie, organizationId, { slug }, "not-the-password");
      assert.equal(wrongPassword.status, 401);

      const missingSlug = await deleteOrganizationAs(owner.cookie, organizationId, {}, owner.password);
      assert.equal(missingSlug.status, 400);

      const deleted = await deleteOrganizationAs(owner.cookie, organizationId, { slug }, owner.password);
      assert.equal(deleted.status, 200);
      const again = await deleteOrganizationAs(owner.cookie, organizationId, { slug }, owner.password);
      assert.equal(again.status, 404);

      // The tombstone keeps the slug reserved even after deletion.
      const reused = await createOrganization(
        apiRequest("/api/organizations", "POST", { name: "Reuse", slug }, owner.cookie),
      );
      assert.equal(reused.status, 409);
      const reusedBody = (await reused.json()) as { error: { code: string } };
      assert.equal(reusedBody.error.code, "SLUG_TAKEN");
    });

    await t.test("purge removes children, keeps the tombstone and audit, and respects 30 days", async () => {
      const slug = `purge-${owner.userId.slice(0, 8)}`;
      const organizationId = await createWorkspace(owner.cookie, slug);
      const project = await createProjectAs(owner.cookie, organizationId, "Purge Project");
      // The notification fixture needs a recipient who is an active
      // project member and distinct from the actor (the INSERT policy
      // requires both), so the member joins the org and the project.
      await inviteAndAccept(owner.cookie, organizationId, member.email, "member", member.cookie);
      const added = await addProjectMember(
        apiRequest(
          `/api/organizations/${organizationId}/projects/${project.id}/members`,
          "POST",
          { userId: member.userId, role: "member" },
          owner.cookie,
        ),
        { params: Promise.resolve({ organizationId, projectId: project.id }) },
      );
      assert.equal(added.status, 201);
      const storageKey = randomUUID();
      await migratorExecAs(
        owner.userId,
        organizationId,
        `WITH status AS (
           SELECT id FROM nexora.project_task_statuses
           WHERE organization_id = $2 AND project_id = $3 ORDER BY sort_order LIMIT 1
         ), task AS (
           INSERT INTO nexora.tasks (id, organization_id, project_id, title, workflow_status_id, created_by_user_id)
           SELECT $4, $2, $3, 'Purge task', status.id, $1 FROM status
           RETURNING id
         ), file AS (
           INSERT INTO nexora.task_files (id, organization_id, project_id, task_id, original_filename, mime_type, byte_size, sha256, storage_key, uploaded_by_user_id)
           SELECT $5, $2, $3, task.id, 'purge.txt', 'text/plain', 4, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', $6, $1 FROM task
           RETURNING id
         )
         INSERT INTO nexora.task_comments (id, organization_id, project_id, task_id, author_user_id, body)
         SELECT $7, $2, $3, task.id, $1, 'purge comment' FROM task`,
        [owner.userId, organizationId, project.id, randomUUID(), randomUUID(), storageKey, randomUUID()],
      );
      // These tables enforce row-level security (notifications even
      // FORCE it), so the fixture inserts run with the owner's tenant
      // session, exactly as routes do.
      await migratorExecAs(
        owner.userId,
        organizationId,
        `INSERT INTO nexora.notifications (id, organization_id, project_id, recipient_user_id, actor_user_id, event_type, target_type, target_id, dedupe_key, title, body, href)
         VALUES ($1, $2, $3, $4, $5, 'task_assigned', 'task', $6, 'purge-dedupe', 'Purge', 'Purge', $7)`,
        [randomUUID(), organizationId, project.id, member.userId, owner.userId, randomUUID(), `/organizations/${organizationId}/projects/${project.id}/tasks`],
      );
      await migratorExecAs(
        owner.userId,
        organizationId,
        `INSERT INTO nexora.organization_invitations (id, organization_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, 'pending@example.test', 'member', $3, $4, pg_catalog.now() + interval '7 days')`,
        [randomUUID(), organizationId, randomBytes(32).toString("hex"), owner.userId],
      );
      await migratorExecAs(
        owner.userId,
        organizationId,
        `INSERT INTO nexora.notification_preferences (organization_id, user_id, event_type)
         VALUES ($1, $2, 'mention')`,
        [organizationId, owner.userId],
      );
      await writeFile(path.join(privateFilesRoot, `${storageKey}.blob`), "purge");

      // A second organization, deleted 29 days ago, must survive.
      const youngSlug = `young-${owner.userId.slice(0, 8)}`;
      const youngOrganizationId = await createWorkspace(owner.cookie, youngSlug);
      await createProjectAs(owner.cookie, youngOrganizationId, "Young Project");
      const youngDeleted = await deleteOrganizationAs(owner.cookie, youngOrganizationId, { slug: youngSlug }, owner.password);
      assert.equal(youngDeleted.status, 200);
      await migratorQuery(
        "UPDATE nexora.organizations SET deleted_at = pg_catalog.now() - interval '29 days' WHERE id = $1",
        [youngOrganizationId],
      );

      const deleted = await deleteOrganizationAs(owner.cookie, organizationId, { slug }, owner.password);
      assert.equal(deleted.status, 200);
      await migratorQuery(
        "UPDATE nexora.organizations SET deleted_at = pg_catalog.now() - interval '31 days' WHERE id = $1",
        [organizationId],
      );

      const purged = await appQuery<{ organization_id: string; storage_key: string | null }>(
        "SELECT organization_id, storage_key FROM nexora.purge_expired_organizations()",
      );
      assert.ok(purged.some((row) => row.organization_id === organizationId && row.storage_key === storageKey));
      assert.ok(purged.some((row) => row.organization_id === organizationId && row.storage_key === null));
      assert.ok(!purged.some((row) => row.organization_id === youngOrganizationId));

      for (const [table, column] of [
        ["nexora.projects", "organization_id"],
        ["nexora.tasks", "organization_id"],
        ["nexora.task_files", "organization_id"],
        ["nexora.task_comments", "organization_id"],
        ["nexora.notifications", "organization_id"],
        ["nexora.organization_invitations", "organization_id"],
        ["nexora.notification_preferences", "organization_id"],
        ["nexora.organization_memberships", "organization_id"],
      ] as const) {
        const rows = await migratorQuery<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${table} WHERE ${column} = $1`,
          [organizationId],
        );
        assert.equal(rows[0]?.count, "0", `expected ${table} to be purged`);
      }
      const tombstone = await migratorQuery<{ status: string; purged_at: string | null; deleted_by_user_id: string }>(
        "SELECT status, purged_at, deleted_by_user_id FROM nexora.organizations WHERE id = $1",
        [organizationId],
      );
      assert.equal(tombstone.length, 1);
      assert.equal(tombstone[0]?.status, "deletion_pending");
      assert.ok(tombstone[0]?.purged_at !== null);
      assert.equal(tombstone[0]?.deleted_by_user_id, owner.userId);
      const audit = await migratorQuery<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM nexora.audit_events WHERE organization_id = $1",
        [organizationId],
      );
      assert.ok(Number(audit[0]?.count) >= 1, "audit events are retained");
      const young = await migratorQuery<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM nexora.projects WHERE organization_id = $1",
        [youngOrganizationId],
      );
      assert.equal(young[0]?.count, "1");
      // The purge function returns keys only; it never touches disk.
      assert.equal(await fileExists(path.join(privateFilesRoot, `${storageKey}.blob`)), true);
    });

    await t.test("cleanup --dry-run reports without deleting, and the real run purges", async () => {
      // A fresh owner: workspace creation is rate-limited to 5/hour
      // per user, and the earlier subtests already spent the first
      // owner's budget.
      const scriptOwner = await registerVerifyAndLogin(
        `${randomUUID()}@example.test`,
        "Script Owner",
        "script owner password five",
      );
      const slug = `script-${scriptOwner.userId.slice(0, 8)}`;
      const organizationId = await createWorkspace(scriptOwner.cookie, slug);
      const project = await createProjectAs(scriptOwner.cookie, organizationId, "Script Project");
      const storageKey = randomUUID();
      await migratorExecAs(
        scriptOwner.userId,
        organizationId,
        `WITH status AS (
           SELECT id FROM nexora.project_task_statuses
           WHERE organization_id = $2 AND project_id = $3 ORDER BY sort_order LIMIT 1
         ), task AS (
           INSERT INTO nexora.tasks (id, organization_id, project_id, title, workflow_status_id, created_by_user_id)
           SELECT $4, $2, $3, 'Script task', status.id, $1 FROM status
           RETURNING id
         )
         INSERT INTO nexora.task_files (id, organization_id, project_id, task_id, original_filename, mime_type, byte_size, sha256, storage_key, uploaded_by_user_id)
         SELECT $5, $2, $3, task.id, 'script.txt', 'text/plain', 6, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', $6, $1 FROM task`,
        [scriptOwner.userId, organizationId, project.id, randomUUID(), randomUUID(), storageKey],
      );
      await writeFile(path.join(privateFilesRoot, `${storageKey}.blob`), "script");
      const deleted = await deleteOrganizationAs(scriptOwner.cookie, organizationId, { slug }, scriptOwner.password);
      assert.equal(deleted.status, 200);
      await migratorQuery(
        "UPDATE nexora.organizations SET deleted_at = pg_catalog.now() - interval '31 days' WHERE id = $1",
        [organizationId],
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
      assert.match(dryRun.stdout, /expired organization\(s\)/);
      assert.ok(dryRun.stdout.includes(organizationId));
      const afterDryRun = await migratorQuery<{ purged_at: string | null }>(
        "SELECT purged_at FROM nexora.organizations WHERE id = $1",
        [organizationId],
      );
      assert.equal(afterDryRun[0]?.purged_at, null);
      assert.equal(await fileExists(path.join(privateFilesRoot, `${storageKey}.blob`)), true);

      const realRun = await execFileAsync(process.execPath, scriptArgs, {
        cwd: repoRoot,
        env: scriptEnv,
      });
      assert.match(realRun.stdout, /Organization cleanup removed 1 expired organization/);
      const afterRealRun = await migratorQuery<{ purged_at: string | null }>(
        "SELECT purged_at FROM nexora.organizations WHERE id = $1",
        [organizationId],
      );
      assert.ok(afterRealRun[0]?.purged_at !== null);
      assert.equal(await fileExists(path.join(privateFilesRoot, `${storageKey}.blob`)), false);
    });
  },
);
