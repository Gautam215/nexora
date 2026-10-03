import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isMigrationName, migrationChecksum } from "../scripts/migration-utils.mjs";

const migration = await readFile(new URL("../db/migrations/0001_identity_tenancy.sql", import.meta.url), "utf8");
const projectFoundation = await readFile(new URL("../db/migrations/0006_project_foundation.sql", import.meta.url), "utf8");
const milestoneFoundation = await readFile(new URL("../db/migrations/0007_milestones.sql", import.meta.url), "utf8");
const taskFoundation = await readFile(new URL("../db/migrations/0008_tasks.sql", import.meta.url), "utf8");
const kanbanFoundation = await readFile(new URL("../db/migrations/0009_kanban_board.sql", import.meta.url), "utf8");
const commentFoundation = await readFile(new URL("../db/migrations/0010_task_comments.sql", import.meta.url), "utf8");
const collaborationFoundation = await readFile(new URL("../db/migrations/0011_collaboration_notifications.sql", import.meta.url), "utf8");
const notificationRlsFix = await readFile(new URL("../db/migrations/0015_notification_insert_rls.sql", import.meta.url), "utf8");
const notificationDedupeRlsFix = await readFile(new URL("../db/migrations/0016_notification_dedupe_rls.sql", import.meta.url), "utf8");
const privateFilesFoundation = await readFile(new URL("../db/migrations/0012_private_task_files.sql", import.meta.url), "utf8");
const searchFoundation = await readFile(new URL("../db/migrations/0013_authorized_search.sql", import.meta.url), "utf8");
const searchRateLimit = await readFile(new URL("../db/migrations/0014_workspace_search_rate_limit.sql", import.meta.url), "utf8");
const grants = await readFile(new URL("../db/runtime-grants.sql", import.meta.url), "utf8");
const databaseBoundary = await readFile(new URL("../src/server/db.ts", import.meta.url), "utf8");
const searchRoute = await readFile(new URL("../src/app/api/organizations/[organizationId]/search/route.ts", import.meta.url), "utf8");
const searchSchemas = await readFile(new URL("../src/security/search-schemas.ts", import.meta.url), "utf8");
const taskCollectionRoute = await readFile(new URL("../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/route.ts", import.meta.url), "utf8");
const taskItemRoute = await readFile(new URL("../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/[taskId]/route.ts", import.meta.url), "utf8");
const taskCommentsRoute = await readFile(new URL("../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/[taskId]/comments/route.ts", import.meta.url), "utf8");
const notificationRoute = await readFile(new URL("../src/app/api/organizations/[organizationId]/notifications/route.ts", import.meta.url), "utf8");
const notificationReadRoute = await readFile(new URL("../src/app/api/organizations/[organizationId]/notifications/[notificationId]/route.ts", import.meta.url), "utf8");
const notificationPreferencesRoute = await readFile(new URL("../src/app/api/organizations/[organizationId]/notifications/preferences/route.ts", import.meta.url), "utf8");
const taskWorkflowRoute = await readFile(new URL("../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/workflow/route.ts", import.meta.url), "utf8");
const taskBulkRoute = await readFile(new URL("../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/bulk/route.ts", import.meta.url), "utf8");
const taskPage = await readFile(new URL("../src/app/components/project-tasks-page.tsx", import.meta.url), "utf8");
const taskFilesCollectionRoute = await readFile(new URL("../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/[taskId]/files/route.ts", import.meta.url), "utf8");
const taskFileItemRoute = await readFile(new URL("../src/app/api/organizations/[organizationId]/projects/[projectId]/tasks/[taskId]/files/[fileId]/route.ts", import.meta.url), "utf8");
const taskFilesBoundary = await readFile(new URL("../src/server/task-files.ts", import.meta.url), "utf8");
const privateFileStorage = await readFile(new URL("../src/server/private-file-storage.ts", import.meta.url), "utf8");
const privateFileCleanup = await readFile(new URL("../scripts/cleanup-task-files.mjs", import.meta.url), "utf8");
const projectUpdateRoute = await readFile(new URL("../src/app/api/organizations/[organizationId]/projects/[projectId]/route.ts", import.meta.url), "utf8");
const projectWorkBoundary = await readFile(new URL("../src/server/project-work.ts", import.meta.url), "utf8");

test("migration filenames are ordered and constrained", () => {
  assert.equal(isMigrationName("0001_identity_tenancy.sql"), true);
  assert.equal(isMigrationName("0010_add_tasks.sql"), true);
  assert.equal(isMigrationName("1_add_tasks.sql"), false);
  assert.equal(isMigrationName("0011_Add_Tasks.sql"), false);
});

test("migration checksums are stable SHA-256 digests", () => {
  const first = migrationChecksum("SELECT 1;");
  assert.equal(first, migrationChecksum("SELECT 1;"));
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, migrationChecksum("SELECT 2;"));
});

test("tenant tables enable row-level security", () => {
  for (const table of [
    "users",
    "user_sessions",
    "organizations",
    "organization_memberships",
    "organization_invitations",
    "audit_events",
  ]) {
    assert.match(
      migration,
      new RegExp(`ALTER TABLE nexora\\.${table} ENABLE ROW LEVEL SECURITY;`),
      `${table} must have RLS enabled`,
    );
  }
});

test("project and project-membership tables enforce project-level RLS", () => {
  for (const table of ["projects", "project_memberships"]) {
    assert.match(
      projectFoundation,
      new RegExp(`ALTER TABLE nexora\\.${table} ENABLE ROW LEVEL SECURITY;`),
      `${table} must have RLS enabled`,
    );
  }
  assert.match(projectFoundation, /CREATE POLICY projects_select_current_member[\s\S]+?can_access_current_project/);
  assert.match(projectFoundation, /CREATE POLICY projects_update_manager[\s\S]+?can_manage_current_project/);
  assert.match(projectFoundation, /CREATE POLICY project_memberships_insert_project_manager[\s\S]+?is_active_organization_member/);
  assert.match(projectFoundation, /CREATE FUNCTION nexora\.guard_project_update[\s\S]+?NEW\.version := OLD\.version \+ 1/);
  assert.match(projectFoundation, /'project-management-user'/);
});

test("membership creation cannot self-assign into an existing organization", () => {
  assert.match(migration, /CREATE POLICY memberships_insert_initial_owner[\s\S]+?is_current_user_organization_creator\(organization_id\)/);
  assert.match(migration, /CREATE FUNCTION nexora\.is_current_user_organization_creator[\s\S]+?SECURITY DEFINER[\s\S]+?SET search_path = pg_catalog, nexora/);
});

test("organization updates require the transaction's active tenant context", () => {
  assert.match(
    migration,
    /CREATE POLICY organizations_update_admin[\s\S]+?id = nexora\.current_organization_id\(\)[\s\S]+?WITH CHECK \([\s\S]+?id = nexora\.current_organization_id\(\)/,
  );
});

test("tenant membership is checked before organization context and business work", () => {
  const membershipRead = databaseBoundary.indexOf("FROM nexora.organization_memberships");
  const authorizationCheck = databaseBoundary.indexOf("!canAccessOrganization(");
  const organizationContext = databaseBoundary.indexOf(
    "set_config('nexora.organization_id', $1, true)",
  );
  const businessCallback = databaseBoundary.lastIndexOf("return work(client);");

  assert.ok(membershipRead >= 0);
  assert.ok(membershipRead < authorizationCheck);
  assert.ok(authorizationCheck < organizationContext);
  assert.ok(organizationContext < businessCallback);
  assert.match(databaseBoundary, /WHERE user_id = \$1 AND organization_id = \$2/);
});

test("audit events are append-only for the application role", () => {
  assert.match(grants, /GRANT SELECT \([^\n]+\),\s+INSERT \([^\n]+\),\s+UPDATE \(role, status\)\s+ON TABLE nexora\.organization_memberships TO nexora_app;/);
  assert.match(grants, /GRANT SELECT \([^\n]+\),\s+INSERT \([^\n]+\)\s+ON TABLE nexora\.audit_events TO nexora_app;/);
  assert.match(grants, /REVOKE UPDATE, DELETE, TRUNCATE ON nexora\.audit_events FROM nexora_app;/);
  assert.doesNotMatch(migration, /CREATE POLICY\s+\w+\s+ON nexora\.audit_events\s+FOR\s+(?:UPDATE|DELETE|ALL)/i);
});

test("project grants do not permit owner transfer or hard delete", () => {
  assert.match(grants, /UPDATE \(name, description, status, start_date, target_date, task_workflow_version\)\s+ON TABLE nexora\.projects TO nexora_app;/);
  assert.match(grants, /UPDATE \(role, status\)\s+ON TABLE nexora\.project_memberships TO nexora_app;/);
  assert.doesNotMatch(grants, /(?:DELETE|TRUNCATE) ON nexora\.(?:projects|project_memberships)/i);
});

test("milestones and mutation idempotency are project-scoped and versioned", () => {
  for (const table of ["milestones", "milestone_dependencies", "project_mutation_idempotency"]) {
    assert.match(
      milestoneFoundation,
      new RegExp(`ALTER TABLE nexora\\.${table} ENABLE ROW LEVEL SECURITY;`),
      `${table} must have RLS enabled`,
    );
  }
  assert.match(milestoneFoundation, /CREATE POLICY milestones_select_project_member[\s\S]+?can_access_current_project/);
  assert.match(milestoneFoundation, /CREATE POLICY milestones_update_project_manager[\s\S]+?can_manage_current_project/);
  assert.match(milestoneFoundation, /CREATE FUNCTION nexora\.guard_milestone_update[\s\S]+?NEW\.version := OLD\.version \+ 1/);
  assert.match(milestoneFoundation, /CREATE FUNCTION nexora\.guard_milestone_dependency[\s\S]+?dependency cycle detected/);
  assert.match(grants, /ON TABLE nexora\.milestones TO nexora_app;/);
  assert.match(grants, /ON TABLE nexora\.project_mutation_idempotency TO nexora_app;/);
  assert.doesNotMatch(grants, /(?:DELETE|TRUNCATE) ON nexora\.milestones/i);
});

test("tasks use project-scoped RLS, configurable status columns, and safe archival", () => {
  for (const table of ["project_task_statuses", "tasks", "task_dependencies"]) {
    assert.match(
      taskFoundation,
      new RegExp(`ALTER TABLE nexora\\.${table} ENABLE ROW LEVEL SECURITY;`),
      `${table} must have RLS enabled`,
    );
  }
  assert.match(taskFoundation, /CREATE FUNCTION nexora\.can_work_current_project[\s\S]+?SECURITY DEFINER/);
  assert.match(taskFoundation, /project_task_statuses_order_unique[\s\S]+?DEFERRABLE INITIALLY DEFERRED/);
  assert.match(taskFoundation, /CREATE POLICY tasks_select_project_member[\s\S]+?can_access_current_project/);
  assert.match(taskFoundation, /CREATE POLICY tasks_insert_project_member[\s\S]+?can_work_current_project/);
  assert.match(taskFoundation, /CREATE FUNCTION nexora\.guard_task_write[\s\S]+?NEW\.version := OLD\.version \+ 1/);
  assert.match(taskFoundation, /CREATE FUNCTION nexora\.guard_task_dependency[\s\S]+?task dependency cycle detected/);
  assert.match(taskFoundation, /CREATE FUNCTION nexora\.guard_task_dependency[\s\S]+?project-task-graph:/);
  assert.match(taskFoundation, /tasks_parent_not_self CHECK \(parent_task_id IS NULL OR parent_task_id <> id\)/);
  assert.match(taskFoundation, /task labels must be trimmed, unique, and at most 24 characters/);
  assert.match(taskFoundation, /CREATE FUNCTION nexora\.guard_project_completion[\s\S]+?complete all active project work/);
  assert.match(kanbanFoundation, /ADD COLUMN position integer NOT NULL DEFAULT 0/);
  assert.match(kanbanFoundation, /tasks_by_project_status_position/);
  assert.doesNotMatch(grants, /(?:DELETE|TRUNCATE) ON nexora\.tasks/i);
});

test("task mutations validate origin, authorization, idempotency, and versions", () => {
  assert.match(taskCollectionRoute, /Object\.hasOwn\(SORTS, sort\)/);
  assert.match(taskCollectionRoute, /export async function POST[\s\S]+?hasSameOrigin\(request\)/);
  assert.match(taskCollectionRoute, /idempotency-key/);
  assert.match(taskCollectionRoute, /lockProjectTaskGraph/);
  assert.match(taskItemRoute, /export async function PATCH[\s\S]+?hasSameOrigin\(request\)/);
  assert.match(taskItemRoute, /export async function DELETE[\s\S]+?hasSameOrigin\(request\)/);
  assert.match(taskItemRoute, /parsed\.value\.expectedVersion/);
  assert.match(taskWorkflowRoute, /can_manage_current_project/);
  assert.match(taskWorkflowRoute, /task_workflow_version !== parsed\.value\.expectedVersion/);
  assert.match(taskWorkflowRoute, /removed\.some\(\(status\) => status\.total_task_count > 0\)/);
  assert.match(taskWorkflowRoute, /next\.isDone !== status\.is_done && status\.total_task_count > 0/);
  assert.match(taskWorkflowRoute, /__r_\$\{randomUUID\(\)\}/);
  assert.match(taskBulkRoute, /task\.version !== requested\.get\(task\.id\)/);
  assert.match(taskBulkRoute, /hasSameOrigin\(request\)/);
});

test("task writes share a project lifecycle lock without manager-only row locks", () => {
  assert.match(projectWorkBoundary, /pg_advisory_xact_lock_shared[\s\S]+?project-lifecycle:/);
  assert.match(projectWorkBoundary, /pg_advisory_xact_lock\([\s\S]+?project-lifecycle:/);
  assert.match(taskCollectionRoute, /lockProjectForWork\(transaction, organizationId, projectId\)/);
  assert.match(taskItemRoute, /lockProjectForWork\(transaction, organizationId, projectId\)/);
  assert.match(taskBulkRoute, /lockProjectForWork\(transaction, organizationId, projectId\)/);
  assert.doesNotMatch(taskCollectionRoute, /FOR SHARE OF project/);
  assert.doesNotMatch(taskItemRoute, /FOR SHARE OF project/);
  assert.doesNotMatch(taskBulkRoute, /FOR SHARE OF project/);
  assert.match(projectUpdateRoute, /lockProjectLifecycle\(transaction, organizationId, projectId\)[\s\S]+?readProject\(transaction, organizationId, projectId, principal\.userId, true\)/);
});

test("task editor preserves locked milestone and parent relationships", () => {
  assert.match(taskPage, /type="hidden" name="milestoneId" value=\{task\?\.milestone_id \?\? ""\}/);
  assert.match(taskPage, /type="hidden" name="parentTaskId" value=\{task\?\.parent_task_id \?\? ""\}/);
});

test("task comments are project-scoped, audited, idempotent, and append-only", () => {
  assert.match(commentFoundation, /CREATE TABLE nexora\.task_comments/);
  assert.match(commentFoundation, /ALTER TABLE nexora\.task_comments ENABLE ROW LEVEL SECURITY/);
  assert.match(commentFoundation, /task_comments_select_project_member[\s\S]+?can_access_current_project/);
  assert.match(commentFoundation, /task_comments_insert_project_member[\s\S]+?can_work_current_project/);
  assert.match(commentFoundation, /operation IN \('milestone\.create', 'task\.create', 'comment\.create'\)/);
  assert.match(grants, /GRANT SELECT \([\s\S]+?INSERT \(id, organization_id, project_id, task_id, author_user_id, body\)\s+ON TABLE nexora\.task_comments TO nexora_app;/);
  assert.match(taskCommentsRoute, /export async function GET/);
  assert.match(taskCommentsRoute, /export async function POST[\s\S]+?hasSameOrigin\(request\)/);
  assert.match(taskCommentsRoute, /lockProjectForWork[\s\S]+?lockProjectTaskGraph/);
  assert.match(taskCommentsRoute, /idempotency-key/);
  assert.match(taskCommentsRoute, /task\.comment_created/);
  assert.match(taskCommentsRoute, /archived_at/);
});

test("mentions and notifications enforce project scope, recipient privacy, and restricted writes", () => {
  for (const table of ["task_comment_mentions", "notification_preferences", "notifications"]) {
    assert.match(
      collaborationFoundation,
      new RegExp(`ALTER TABLE nexora\\.${table} ENABLE ROW LEVEL SECURITY;`),
      `${table} must have RLS enabled`,
    );
  }
  assert.match(collaborationFoundation, /ALTER TABLE nexora\.notifications FORCE ROW LEVEL SECURITY/);
  assert.match(collaborationFoundation, /task_comment_mentions_insert_comment_author[\s\S]+?comment\.author_user_id = nexora\.current_user_id\(\)/);
  assert.match(collaborationFoundation, /notifications_select_recipient[\s\S]+?recipient_user_id = nexora\.current_user_id\(\)/);
  assert.match(collaborationFoundation, /CREATE FUNCTION nexora\.enqueue_project_notification[\s\S]+?SECURITY DEFINER[\s\S]+?SET search_path = pg_catalog, nexora/);
  assert.match(collaborationFoundation, /target_actor_user_id IS DISTINCT FROM nexora\.current_user_id\(\)/);
  assert.match(collaborationFoundation, /REVOKE ALL ON FUNCTION nexora\.enqueue_project_notification[\s\S]+?FROM PUBLIC/);
  assert.match(notificationRlsFix, /CREATE OR REPLACE FUNCTION nexora\.enqueue_project_notification/);
  assert.match(notificationRlsFix, /IF NOT FOUND THEN\s+RETURN NULL/);
  assert.doesNotMatch(notificationRlsFix, /RETURNING id INTO created_notification_id/);
  assert.match(notificationDedupeRlsFix, /WHEN unique_violation/);
  assert.match(notificationDedupeRlsFix, /violated_constraint = 'notifications_dedupe_unique'/);
  assert.doesNotMatch(notificationDedupeRlsFix, /ON CONFLICT/);
  assert.match(grants, /GRANT SELECT \([\s\S]+?UPDATE \(read_at\)\s+ON TABLE nexora\.notifications TO nexora_app;/);
  assert.doesNotMatch(grants, /INSERT \([^\n]+\)\s+ON TABLE nexora\.notifications TO nexora_app;/);
  assert.match(notificationRoute, /recipient_user_id = \$2/);
  assert.match(notificationReadRoute, /recipient_user_id = \$3/);
  assert.match(notificationReadRoute, /hasSameOrigin\(request\)/);
  assert.match(notificationPreferencesRoute, /hasSameOrigin\(request\)/);
  assert.match(taskCommentsRoute, /MENTION_TOKEN_PATTERN/);
  assert.match(taskCommentsRoute, /status = 'active' AND user_id = ANY/);
});

test("private task files enforce project RLS, bounded metadata, and retention-only deletion", () => {
  assert.match(privateFilesFoundation, /CREATE TABLE nexora\.task_files/);
  assert.match(privateFilesFoundation, /ALTER TABLE nexora\.task_files ENABLE ROW LEVEL SECURITY/);
  assert.match(privateFilesFoundation, /task_files_select_project_member[\s\S]+?can_access_current_project/);
  assert.match(privateFilesFoundation, /task_files_insert_project_member[\s\S]+?can_work_current_project/);
  assert.match(privateFilesFoundation, /task_files_update_project_member[\s\S]+?can_work_current_project/);
  assert.match(privateFilesFoundation, /byte_size BETWEEN 1 AND 10485760/);
  assert.match(privateFilesFoundation, /mime_type IN \([\s\S]+?'application\/pdf'/);
  assert.match(privateFilesFoundation, /deleted_at <= pg_catalog\.now\(\) - interval '30 days'/);
  assert.match(privateFilesFoundation, /CREATE FUNCTION nexora\.purge_expired_task_files\(\)[\s\S]+?SECURITY DEFINER[\s\S]+?SET search_path = pg_catalog, nexora/);
  assert.match(grants, /GRANT EXECUTE ON FUNCTION nexora\.purge_expired_task_files\(\) TO nexora_app/);
  assert.match(grants, /GRANT SELECT \([\s\S]+?UPDATE \([\s\S]+?ON TABLE nexora\.task_files TO nexora_app;/);
  assert.doesNotMatch(grants, /(?:DELETE|TRUNCATE) ON nexora\.task_files/i);
  assert.match(privateFileCleanup, /purge_expired_task_files/);
  assert.match(privateFileCleanup, /list_unreferenced_task_file_keys/);
  assert.match(privateFileCleanup, /24 \* 60 \* 60 \* 1000/);
});

test("private file APIs validate uploads, authorize access, and invalidate stale signed links", () => {
  assert.match(taskFilesCollectionRoute, /export async function GET/);
  assert.match(taskFilesCollectionRoute, /export async function POST[\s\S]+?hasSameOrigin\(request\)/);
  assert.match(taskFilesCollectionRoute, /readBoundedFileBody/);
  assert.match(taskFilesCollectionRoute, /validatePrivateFile/);
  assert.match(taskFilesCollectionRoute, /idempotency-key/);
  assert.match(taskFilesCollectionRoute, /privateFileSigningKey/);
  assert.match(taskFilesCollectionRoute, /MAX_TASK_FILE_COUNT/);
  assert.match(taskFilesCollectionRoute, /MAX_TASK_FILE_BYTES/);
  assert.match(taskFileItemRoute, /verifyPrivateFileToken/);
  assert.match(taskFileItemRoute, /isTokenRateLimited/);
  assert.match(taskFileItemRoute, /claims\.version/);
  assert.match(taskFileItemRoute, /privateFileContentDisposition/);
  assert.match(taskFileItemRoute, /export async function PUT[\s\S]+?hasSameOrigin\(request\)/);
  assert.match(taskFileItemRoute, /if-match/);
  assert.match(taskFileItemRoute, /version = version \+ 1/);
  assert.match(taskFileItemRoute, /export async function DELETE[\s\S]+?hasSameOrigin\(request\)/);
  assert.match(taskFileItemRoute, /deleted_at = pg_catalog\.now\(\)/);
  assert.match(taskFilesBoundary, /NEXORA_FILE_SIGNING_KEY/);
  const publicFileDto = /export interface PublicTaskFile \{([\s\S]*?)\}/.exec(taskFilesBoundary)?.[1] ?? "";
  assert.ok(publicFileDto);
  assert.doesNotMatch(publicFileDto, /storage_key/);
  assert.match(privateFileStorage, /0o700/);
  assert.match(privateFileStorage, /0o600/);
  assert.match(privateFileStorage, /O_NOFOLLOW/);
});

test("workspace search is tenant-scoped, permission-aware, bounded, and indexed", () => {
  assert.match(searchRoute, /getAuthPrincipal/);
  assert.match(searchRoute, /withOrganizationContext/);
  assert.match(searchRoute, /isRateLimited\(request, "workspace-search"/);
  assert.match(searchRoute, /plainto_tsquery/);
  assert.match(searchRoute, /nexora\.searchable_task_labels\(task\.labels\)/);
  assert.match(searchRoute, /LIMIT \$4 OFFSET \$5/);
  assert.doesNotMatch(searchRoute, /ILIKE|queryRaw|\$\{q\}/i);
  assert.match(searchSchemas, /\.min\(2\)/);
  assert.match(searchSchemas, /\.max\(120\)/);
  assert.match(searchSchemas, /max\(50\)/);
  assert.match(searchSchemas, /max\(10_000\)/);
  for (const indexName of [
    "projects_search_document",
    "tasks_search_document",
    "task_comments_search_document",
    "task_files_search_document",
  ]) {
    assert.match(searchFoundation, new RegExp(`CREATE INDEX ${indexName}[\\s\\S]+?USING gin`));
  }
  assert.match(searchFoundation, /CREATE FUNCTION nexora\.searchable_task_labels\(labels text\[\]\)[\s\S]+?IMMUTABLE/);
  assert.match(grants, /GRANT EXECUTE ON FUNCTION nexora\.searchable_task_labels\(text\[\]\) TO nexora_app/);
  assert.match(searchRateLimit, /ADD CONSTRAINT auth_rate_scope[\s\S]+?'workspace-search'/);
  assert.match(searchRateLimit, /target_scope NOT IN \([\s\S]+?'workspace-search'/);
  assert.match(searchRoute, /list_current_organization_members/);
  assert.doesNotMatch(searchRoute, /member\.email/);
});
