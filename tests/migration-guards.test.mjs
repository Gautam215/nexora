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
const graphAndRateLimitHardening = await readFile(new URL("../db/migrations/0021_rate_and_graph_lock_hardening.sql", import.meta.url), "utf8");
const privateFileDownloadLock = await readFile(new URL("../db/migrations/0022_lock_private_file_download_reads.sql", import.meta.url), "utf8");
const projectSoftDelete = await readFile(new URL("../db/migrations/0024_project_soft_delete.sql", import.meta.url), "utf8");
const cleanupListing = await readFile(new URL("../db/migrations/0025_expired_project_listing.sql", import.meta.url), "utf8");
const purgeNotificationCascade = await readFile(new URL("../db/migrations/0027_purge_notification_cascade.sql", import.meta.url), "utf8");
const organizationSettingsRateLimit = await readFile(new URL("../db/migrations/0028_organization_settings_rate_limit.sql", import.meta.url), "utf8");
const milestoneSoftDelete = await readFile(new URL("../db/migrations/0029_milestone_soft_delete.sql", import.meta.url), "utf8");
const milestonePurgeQualification = await readFile(new URL("../db/migrations/0030_milestone_purge_column_qualification.sql", import.meta.url), "utf8");
const milestonePurgeTenantContext = await readFile(new URL("../db/migrations/0031_milestone_purge_tenant_context.sql", import.meta.url), "utf8");
const oauthGoogle = await readFile(new URL("../db/migrations/0032_oauth_google.sql", import.meta.url), "utf8");
const organizationSoftDelete = await readFile(new URL("../db/migrations/0033_organization_soft_delete.sql", import.meta.url), "utf8");
const aiExecutions = await readFile(new URL("../db/migrations/0034_ai_executions.sql", import.meta.url), "utf8");
const aiCreationIdempotency = await readFile(new URL("../db/migrations/0035_ai_creation_idempotency.sql", import.meta.url), "utf8");
const realtimeEvents = await readFile(new URL("../db/migrations/0036_realtime_events.sql", import.meta.url), "utf8");
const projectUpdateIdempotency = await readFile(
  new URL("../db/migrations/0037_project_update_idempotency.sql", import.meta.url),
  "utf8",
);
const projectUpdateIdempotencyFix = await readFile(
  new URL("../db/migrations/0038_project_update_idempotency_fix.sql", import.meta.url),
  "utf8",
);
const oauthStartRoute = await readFile(new URL("../src/app/api/auth/oauth/google/start/route.ts", import.meta.url), "utf8");
const oauthStartShared = await readFile(new URL("../src/server/oauth/start.ts", import.meta.url), "utf8");
const oauthCallbackRoute = await readFile(new URL("../src/app/api/auth/oauth/google/callback/route.ts", import.meta.url), "utf8");
const oauthGoogleModule = await readFile(new URL("../src/server/oauth/google.ts", import.meta.url), "utf8");
const milestoneItemRoute = await readFile(new URL("../src/app/api/organizations/[organizationId]/projects/[projectId]/milestones/[milestoneId]/route.ts", import.meta.url), "utf8");
const milestoneSchemas = await readFile(new URL("../src/security/milestone-schemas.ts", import.meta.url), "utf8");
const organizationRoute = await readFile(new URL("../src/app/api/organizations/[organizationId]/route.ts", import.meta.url), "utf8");
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
  assert.match(grants, /UPDATE \(name, description, status, start_date, target_date, task_workflow_version, deleted_at, deleted_by_user_id\)\s+ON TABLE nexora\.projects TO nexora_app;/);
  assert.match(grants, /GRANT SELECT \([^)]*deleted_at, deleted_by_user_id[^)]*\)[\s\S]+?ON TABLE nexora\.projects TO nexora_app;/);
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

test("rate-limit counters saturate and graph writes serialize across transaction snapshots", () => {
  assert.match(graphAndRateLimitHardening, /LEAST\(current_bucket\.attempts \+ 1, 1000\)/);
  assert.match(graphAndRateLimitHardening, /CREATE TABLE nexora\.project_dependency_graph_locks/);
  assert.match(graphAndRateLimitHardening, /ON CONFLICT \(organization_id, project_id, graph_type\) DO UPDATE/);
  assert.match(graphAndRateLimitHardening, /SECURITY DEFINER[\s\S]+?nexora\.can_manage_current_project/);
  assert.match(graphAndRateLimitHardening, /CREATE TRIGGER milestone_dependencies_graph_lock/);
  assert.match(graphAndRateLimitHardening, /CREATE TRIGGER task_dependencies_graph_lock/);
  assert.match(graphAndRateLimitHardening, /CREATE TRIGGER tasks_graph_lock_before_write/);
  assert.match(graphAndRateLimitHardening, /REVOKE ALL ON TABLE nexora\.project_dependency_graph_locks FROM nexora_app/);
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
  assert.match(taskFileItemRoute, /lock_active_task_file_for_download/);
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

test("private download row locks preserve viewer authorization without broadening table grants", () => {
  assert.match(privateFileDownloadLock, /SECURITY DEFINER[\s\S]+?SET search_path = pg_catalog, nexora/);
  assert.match(privateFileDownloadLock, /target_organization_id IS DISTINCT FROM nexora\.current_organization_id\(\)/);
  assert.match(privateFileDownloadLock, /nexora\.can_access_current_project\(target_organization_id, target_project_id\)/);
  assert.match(privateFileDownloadLock, /file\.deleted_at IS NULL[\s\S]+?FOR SHARE/);
  assert.match(privateFileDownloadLock, /REVOKE ALL ON FUNCTION nexora\.lock_active_task_file_for_download/);
  assert.match(privateFileDownloadLock, /GRANT EXECUTE ON FUNCTION nexora\.lock_active_task_file_for_download/);
  assert.doesNotMatch(grants, /GRANT UPDATE ON TABLE nexora\.task_files TO nexora_app/i);
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
  assert.match(searchSchemas, /export const MAX_SEARCH_OFFSET = 10_000;/);
  assert.match(searchSchemas, /\.max\(MAX_SEARCH_OFFSET\)/);
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

test("project soft delete keeps audit events and purges only after retention", () => {
  assert.match(projectSoftDelete, /ADD COLUMN deleted_at timestamptz/);
  assert.match(projectSoftDelete, /ADD COLUMN deleted_by_user_id uuid/);
  assert.match(projectSoftDelete, /CONSTRAINT projects_deleter_fk[\s\S]+?REFERENCES nexora\.organization_memberships/);
  assert.match(projectSoftDelete, /CONSTRAINT projects_deleted_by_consistent CHECK/);
  assert.match(projectSoftDelete, /CREATE INDEX projects_active_list_idx[\s\S]+?WHERE deleted_at IS NULL/);
  assert.match(projectSoftDelete, /CREATE INDEX projects_retention_idx[\s\S]+?WHERE deleted_at IS NOT NULL/);
  assert.match(projectSoftDelete, /CREATE FUNCTION nexora\.purge_expired_projects\(\)/);
  assert.match(projectSoftDelete, /SECURITY DEFINER/);
  assert.match(projectSoftDelete, /pg_advisory_xact_lock/);
  assert.match(projectSoftDelete, /deleted_at <= pg_catalog\.now\(\) - interval '30 days'/);
  assert.match(projectSoftDelete, /DELETE FROM nexora\.task_files/);
  assert.match(projectSoftDelete, /DELETE FROM nexora\.projects/);
  assert.doesNotMatch(projectSoftDelete, /DELETE FROM nexora\.audit_events/);
  assert.match(grants, /GRANT EXECUTE ON FUNCTION nexora\.purge_expired_projects\(\) TO nexora_app;/);
  assert.match(grants, /GRANT EXECUTE ON FUNCTION nexora\.list_expired_projects\(\) TO nexora_app;/);
  assert.match(grants, /GRANT EXECUTE ON FUNCTION nexora\.list_expired_task_files\(\) TO nexora_app;/);
  assert.match(cleanupListing, /CREATE FUNCTION nexora\.list_expired_projects\(\)/);
  assert.match(cleanupListing, /CREATE FUNCTION nexora\.list_expired_task_files\(\)/);
  assert.match(cleanupListing, /SECURITY DEFINER/);
  assert.doesNotMatch(cleanupListing, /DELETE FROM nexora\./);
  // Notifications use FORCE row-level security with a recipient-scoped
  // SELECT policy, and DELETE also requires the SELECT policy to pass,
  // so the 0026 DELETE policy alone could not purge them. 0027 therefore
  // carries the deletion through the foreign key cascade instead.
  assert.match(purgeNotificationCascade, /DROP POLICY IF EXISTS notifications_delete_expired_projects/);
  assert.match(purgeNotificationCascade, /ON DELETE CASCADE/);
  assert.match(purgeNotificationCascade, /FOREIGN KEY \(organization_id, project_id\)/);
  assert.match(projectUpdateRoute, /projectDeleteSchema/);
  assert.match(projectUpdateRoute, /'project\.deleted'/);
  assert.match(projectUpdateRoute, /deleted_at = pg_catalog\.now\(\),\s+deleted_by_user_id/);
});

test("milestone soft delete detaches tasks, keeps audit, and purges only after retention", () => {
  assert.match(milestoneSoftDelete, /ADD COLUMN deleted_at timestamptz/);
  assert.match(milestoneSoftDelete, /ADD COLUMN deleted_by_user_id uuid/);
  assert.match(milestoneSoftDelete, /CONSTRAINT milestones_deleted_by_consistent CHECK/);
  assert.match(milestoneSoftDelete, /CONSTRAINT milestones_deleter_fk[\s\S]+?REFERENCES nexora\.organization_memberships/);
  assert.match(milestoneSoftDelete, /CREATE INDEX milestones_active_list_idx[\s\S]+?WHERE deleted_at IS NULL/);
  assert.match(milestoneSoftDelete, /CREATE INDEX milestones_retention_idx[\s\S]+?WHERE deleted_at IS NOT NULL/);
  assert.match(milestoneSoftDelete, /CREATE FUNCTION nexora\.purge_expired_milestones\(\)/);
  assert.match(milestoneSoftDelete, /CREATE FUNCTION nexora\.list_expired_milestones\(\)/);
  assert.match(milestoneSoftDelete, /SECURITY DEFINER/);
  assert.match(milestoneSoftDelete, /pg_advisory_xact_lock/);
  assert.match(milestoneSoftDelete, /deleted_at <= pg_catalog\.now\(\) - interval '30 days'/);
  // Purge detaches tasks (they belong to the project) and deletes both
  // directions of dependency rows; it never deletes tasks or audit rows.
  assert.match(milestoneSoftDelete, /UPDATE nexora\.tasks SET milestone_id = NULL/);
  assert.match(milestoneSoftDelete, /DELETE FROM nexora\.milestone_dependencies/);
  assert.match(milestoneSoftDelete, /DELETE FROM nexora\.milestones/);
  assert.doesNotMatch(milestoneSoftDelete, /DELETE FROM nexora\.tasks/);
  assert.doesNotMatch(milestoneSoftDelete, /DELETE FROM nexora\.audit_events/);
  assert.match(grants, /GRANT EXECUTE ON FUNCTION nexora\.purge_expired_milestones\(\) TO nexora_app;/);
  assert.match(grants, /GRANT EXECUTE ON FUNCTION nexora\.list_expired_milestones\(\) TO nexora_app;/);
  // 0029's RETURNS TABLE OUT parameter milestone_id shadowed the column
  // in the purge DELETE/UPDATE, failing with 42702. 0030 replaces the
  // function with table-qualified references and nothing else changed.
  assert.match(milestonePurgeQualification, /CREATE OR REPLACE FUNCTION nexora\.purge_expired_milestones\(\)/);
  assert.match(milestonePurgeQualification, /nexora\.milestone_dependencies\.milestone_id = expired_id/);
  assert.match(milestonePurgeQualification, /nexora\.milestone_dependencies\.depends_on_milestone_id = expired_id/);
  assert.match(milestonePurgeQualification, /nexora\.tasks\.milestone_id = expired_id/);
  assert.doesNotMatch(milestonePurgeQualification, /WHERE milestone_id = expired_id/);
  // 0030's detach fired the task graph-lock trigger, which requires a
  // tenant session the purge does not have. 0031 adopts the deleter's
  // context per milestone, restores the caller's context afterwards,
  // and isolates per-milestone failures with a warning instead of
  // aborting every other milestone's purge.
  assert.match(milestonePurgeTenantContext, /CREATE OR REPLACE FUNCTION nexora\.purge_expired_milestones\(\)/);
  assert.match(milestonePurgeTenantContext, /set_config\('nexora\.user_id', expired_row\.deleted_by_user_id::text, true\)/);
  assert.match(milestonePurgeTenantContext, /set_config\('nexora\.organization_id', expired_row\.organization_id::text, true\)/);
  assert.match(milestonePurgeTenantContext, /EXCEPTION WHEN OTHERS THEN/);
  assert.match(milestonePurgeTenantContext, /RAISE WARNING 'nexora milestone purge skipped/);
  assert.match(milestonePurgeTenantContext, /COALESCE\(original_user, ''\)/);
  assert.match(milestoneSchemas, /milestoneDeleteSchema/);
  assert.match(milestoneItemRoute, /milestoneDeleteSchema/);
  assert.match(milestoneItemRoute, /'milestone\.deleted'/);
  assert.match(milestoneItemRoute, /deleted_at = pg_catalog\.now\(\),\s+deleted_by_user_id/);
  // Task detail and bulk reads share readProjectTask; a soft-deleted
  // milestone's name and status must not leak through it.
  assert.match(projectWorkBoundary, /milestone\.deleted_at IS NULL/);
});

test("OAuth identities table, lookup function, nullable password, and scopes (0032)", () => {
  // Table shape: one Google identity per user, keyed by subject;
  // provider_email is informational only and deliberately non-unique.
  assert.match(oauthGoogle, /CREATE TABLE nexora\.oauth_identities/);
  assert.match(oauthGoogle, /CONSTRAINT oauth_identities_subject_unique UNIQUE \(provider, provider_subject\)/);
  assert.match(oauthGoogle, /CONSTRAINT oauth_identities_user_provider_unique UNIQUE \(user_id, provider\)/);
  assert.match(oauthGoogle, /provider text NOT NULL CHECK \(provider = 'google'\)/);
  assert.match(oauthGoogle, /provider_subject text NOT NULL CHECK/);
  assert.match(oauthGoogle, /provider_email text NOT NULL CHECK/);
  // provider_email itself is never unique: the UNIQUE constraints
  // below belong to (provider, subject) and (user_id, provider).
  assert.doesNotMatch(oauthGoogle, /provider_email[^\n]*UNIQUE/);
  assert.match(oauthGoogle, /ALTER TABLE nexora\.oauth_identities ENABLE ROW LEVEL SECURITY/);
  assert.match(oauthGoogle, /CREATE POLICY oauth_identities_select_self/);
  assert.match(oauthGoogle, /CREATE POLICY oauth_identities_insert_self/);
  assert.match(oauthGoogle, /CREATE POLICY oauth_identities_update_self/);
  // Pre-auth lookup returns only user_id, status, and
  // email_verified_at -- never email, display_name, or password_hash.
  assert.match(oauthGoogle, /CREATE FUNCTION nexora\.lookup_oauth_identity\(target_provider text, target_subject text\)/);
  assert.match(oauthGoogle, /RETURNS TABLE \(\s+user_id uuid,\s+status text,\s+email_verified_at timestamptz\s+\)/);
  assert.match(oauthGoogle, /SECURITY DEFINER/);
  assert.match(oauthGoogle, /REVOKE ALL ON FUNCTION nexora\.lookup_oauth_identity\(text, text\) FROM PUBLIC/);
  assert.match(grants, /GRANT EXECUTE ON FUNCTION nexora\.lookup_oauth_identity\(text, text\) TO nexora_app;/);
  // Column-scoped grants, mirroring the users pattern, not blanket ALL.
  assert.match(grants, /GRANT SELECT \(id, user_id, provider, provider_subject, provider_email, created_at, last_used_at\),\s+INSERT \(id, user_id, provider, provider_subject, provider_email\),\s+UPDATE \(provider_email, last_used_at\)\s+ON TABLE nexora\.oauth_identities TO nexora_app;/);
  // OAuth-only users have no password: the NOT NULL and the old
  // length CHECK are replaced by a NULL-allowing CHECK.
  assert.match(oauthGoogle, /ALTER TABLE nexora\.users ALTER COLUMN password_hash DROP NOT NULL/);
  assert.match(oauthGoogle, /password_hash IS NULL OR pg_catalog\.length\(password_hash\) BETWEEN 32 AND 512/);
  // OAuth creation sets email_verified_at at insert time (the provider
  // verified the email), so the users INSERT grant gains that column.
  assert.match(grants, /INSERT \(id, email, display_name, password_hash, email_verified_at\),\s+UPDATE \(display_name, password_hash\)\s+ON TABLE nexora\.users TO nexora_app;/);
  // Both rate-limit scopes in both allowlists (the 0023 lesson).
  assert.match(oauthGoogle, /'oauth-start',/);
  assert.match(oauthGoogle, /'oauth-callback'/);
  assert.match(oauthGoogle, /CREATE OR REPLACE FUNCTION nexora\.consume_auth_rate_limit/);
  assert.match(oauthGoogle, /DROP CONSTRAINT auth_rate_scope/);
  assert.match(oauthGoogle, /ADD CONSTRAINT auth_rate_scope CHECK/);
  // Route shape: flag-gated 404s, fail-closed credentials, fixed 302s
  // with no-referrer, no same-origin check on the callback (the
  // provider is cross-origin by design; state and PKCE defend it).
  assert.match(oauthStartShared, /isOAuthEnabled/);
  assert.match(oauthStartRoute, /hasSameOrigin/);
  assert.match(oauthCallbackRoute, /isOAuthEnabled/);
  assert.match(oauthCallbackRoute, /oauth_failed/);
  assert.match(oauthCallbackRoute, /oauth_denied/);
  assert.match(oauthCallbackRoute, /oauth_expired/);
  assert.match(oauthCallbackRoute, /oauth_already_linked/);
  assert.match(oauthCallbackRoute, /oauth_email_taken/);
  assert.match(oauthCallbackRoute, /Referrer-Policy": "no-referrer/);
  assert.doesNotMatch(oauthCallbackRoute, /hasSameOrigin/);
  // Strict id_token validation in the provider module.
  assert.match(oauthGoogleModule, /header\.alg !== "RS256"/);
  assert.match(oauthGoogleModule, /payload\.email_verified !== true/);
  assert.match(oauthGoogleModule, /GOOGLE_ISSUER/);
});

test("organization soft delete keeps audit, purges children, and keeps the tombstone (0033)", () => {
  // Columns and paired-NULL discipline, mirroring projects/milestones.
  assert.match(organizationSoftDelete, /ADD COLUMN deleted_at timestamptz/);
  assert.match(organizationSoftDelete, /ADD COLUMN deleted_by_user_id uuid/);
  assert.match(organizationSoftDelete, /ADD COLUMN purged_at timestamptz/);
  assert.match(organizationSoftDelete, /\(deleted_at IS NULL\) = \(deleted_by_user_id IS NULL\)/);
  assert.match(organizationSoftDelete, /purged_at IS NULL OR deleted_at IS NOT NULL/);
  // The deleter references users, not memberships: the purge deletes
  // memberships, so a membership foreign key would block the purge.
  assert.match(organizationSoftDelete, /FOREIGN KEY \(deleted_by_user_id\)\s+REFERENCES nexora\.users \(id\)/);
  assert.match(organizationSoftDelete, /status = 'deletion_pending'/);
  // Purge order covers every organization-scoped child table; audit
  // events are deliberately absent (retained), and the organization
  // row itself is marked purged, never deleted (RESTRICT from audit).
  assert.match(organizationSoftDelete, /CREATE FUNCTION nexora\.purge_expired_organizations\(\)/);
  assert.match(organizationSoftDelete, /DELETE FROM nexora\.task_files AS file/);
  assert.match(organizationSoftDelete, /DELETE FROM nexora\.notification_preferences AS preference/);
  assert.match(organizationSoftDelete, /DELETE FROM nexora\.organization_memberships AS membership/);
  assert.match(organizationSoftDelete, /SET purged_at = pg_catalog\.now\(\)/);
  assert.doesNotMatch(organizationSoftDelete, /DELETE FROM nexora\.audit_events/);
  assert.doesNotMatch(organizationSoftDelete, /DELETE FROM nexora\.organizations AS organization/);
  // Notifications cascade from project deletion (0027); an explicit
  // session-less DELETE would be a no-op under FORCE RLS.
  assert.doesNotMatch(organizationSoftDelete, /DELETE FROM nexora\.notifications AS notification/);
  assert.match(organizationSoftDelete, /CREATE FUNCTION nexora\.list_expired_organizations\(\)/);
  assert.match(organizationSoftDelete, /interval '30 days'/);
  // Per-organization failure isolation, mirroring the milestone purge.
  assert.match(organizationSoftDelete, /EXCEPTION WHEN OTHERS THEN/);
  assert.match(organizationSoftDelete, /RAISE WARNING 'nexora organization purge skipped/);
  // Marker row per purged organization, so file-less organizations
  // are still counted by the cleanup command.
  assert.match(organizationSoftDelete, /RETURN QUERY SELECT expired_org\.id, NULL::uuid/);
  // Grants for the new columns and functions, column-scoped.
  assert.match(grants, /UPDATE \(name, slug, status, deleted_at, deleted_by_user_id, purged_at\)\s+ON TABLE nexora\.organizations TO nexora_app;/);
  assert.match(grants, /GRANT EXECUTE ON FUNCTION nexora\.purge_expired_organizations\(\) TO nexora_app;/);
  assert.match(grants, /GRANT EXECUTE ON FUNCTION nexora\.list_expired_organizations\(\) TO nexora_app;/);
  // Deletion rate-limit scope in both allowlists (the 0023 lesson).
  assert.match(organizationSoftDelete, /'organization-deletion-user',/);
  assert.match(organizationSoftDelete, /DROP CONSTRAINT auth_rate_scope/);
  assert.match(organizationSoftDelete, /ADD CONSTRAINT auth_rate_scope CHECK/);
  // Route shape: owner-only, slug-confirmed, audited, row-locked.
  assert.match(organizationRoute, /organizationDeleteSchema/);
  assert.match(organizationRoute, /organization-deletion-user/);
  assert.match(organizationRoute, /'organization\.deleted'/);
  assert.match(organizationRoute, /ORGANIZATION_SLUG_MISMATCH/);
  assert.match(organizationRoute, /FOR UPDATE LIMIT 1/);
  // Non-active organizations are rejected centrally in the tenant
  // context, so every organization-scoped route hides a deleted
  // workspace without a filter at each site.
  assert.match(databaseBoundary, /class OrganizationNotFound/);
  assert.match(databaseBoundary, /organizationStatus !== "active"/);
  // The cleanup command purges organizations before projects (their
  // projects go with them) and removes their files from disk.
  assert.match(privateFileCleanup, /list_expired_organizations/);
  assert.match(privateFileCleanup, /purge_expired_organizations/);
  assert.match(privateFileCleanup, /Organization cleanup removed/);
});

test("organization settings rate limit scope exists in both allowlists", () => {
  // The settings scope must be accepted by the rate-limit function and
  // by the auth_rate_limits CHECK, or settings attempts fail with a
  // generic 500 instead of being rate-limited (the 0023 lesson).
  assert.match(organizationSettingsRateLimit, /'organization-settings-user',/);
  assert.match(organizationSettingsRateLimit, /CREATE OR REPLACE FUNCTION nexora\.consume_auth_rate_limit/);
  assert.match(organizationSettingsRateLimit, /DROP CONSTRAINT auth_rate_scope/);
  assert.match(organizationSettingsRateLimit, /ADD CONSTRAINT auth_rate_scope CHECK/);
  assert.doesNotMatch(organizationSettingsRateLimit, /DELETE FROM nexora\./);
  assert.match(organizationRoute, /organizationUpdateSchema/);
  assert.match(organizationRoute, /organization-settings-user/);
  assert.match(organizationRoute, /'organization\.updated'/);
  assert.match(organizationRoute, /ORGANIZATION_MANAGEMENT_REQUIRED/);
});

test("AI execution records are metadata-only, tenant-scoped, and purged (0034)", () => {
  // Metadata only: no prompt or response content column may exist.
  assert.match(aiExecutions, /CREATE TABLE nexora\.ai_executions/);
  assert.doesNotMatch(aiExecutions, /prompt_text|response_text|prompt_content|completion_text/);
  assert.match(aiExecutions, /workflow IN \('planning', 'extraction', 'summarization', 'risk', 'assistant'\)/);
  assert.match(aiExecutions, /status IN \('started', 'succeeded', 'failed'\)/);
  assert.match(aiExecutions, /completed_at IS NULL/);
  // RLS with own-row policies, mirroring the notifications pattern.
  assert.match(aiExecutions, /ALTER TABLE nexora\.ai_executions ENABLE ROW LEVEL SECURITY/);
  assert.match(aiExecutions, /CREATE POLICY ai_executions_select_own/);
  assert.match(aiExecutions, /CREATE POLICY ai_executions_insert_own/);
  assert.match(aiExecutions, /CREATE POLICY ai_executions_update_own/);
  assert.match(aiExecutions, /user_id = nexora\.current_user_id\(\)/);
  assert.match(aiExecutions, /nexora\.is_current_organization_member\(organization_id\)/);
  // Project purge cascades project-scoped rows; the organization purge
  // removes the rest (org-level rows with a NULL project).
  assert.match(aiExecutions, /REFERENCES nexora\.projects \(id\)\s+ON DELETE CASCADE/);
  assert.match(aiExecutions, /DELETE FROM nexora\.ai_executions AS execution/);
  assert.doesNotMatch(aiExecutions, /DELETE FROM nexora\.audit_events/);
  // Both AI rate-limit scopes in both allowlists (the 0023 lesson).
  assert.match(aiExecutions, /'ai-request-user',/);
  assert.match(aiExecutions, /'ai-request-org'/);
  assert.match(aiExecutions, /DROP CONSTRAINT auth_rate_scope/);
  assert.match(aiExecutions, /ADD CONSTRAINT auth_rate_scope CHECK/);
  assert.match(aiExecutions, /CREATE OR REPLACE FUNCTION nexora\.consume_auth_rate_limit/);
  // Column-scoped grants, mirroring the users pattern, not blanket ALL.
  assert.match(grants, /GRANT SELECT \(\s*id,\s*organization_id,\s*project_id,\s*user_id,\s*workflow,\s*provider,\s*model,\s*status,\s*prompt_tokens,\s*completion_tokens,\s*latency_ms,\s*error_code,\s*created_at,\s*completed_at\s*\)/);
  assert.match(grants, /INSERT \(id, organization_id, project_id, user_id, workflow, provider, model, status\),\s+UPDATE \(status, prompt_tokens, completion_tokens, latency_ms, error_code, completed_at\)\s+ON TABLE nexora\.ai_executions TO nexora_app;/);
});

test("AI creation idempotency is organization-level and purged (0035)", () => {
  // The project-scoped table cannot key a confirmation that creates
  // the project, so this table is organization-level by design.
  assert.match(aiCreationIdempotency, /CREATE TABLE nexora\.ai_creation_idempotency/);
  assert.match(aiCreationIdempotency, /operation IN \('planning\.confirm', 'extraction\.confirm'\)/);
  assert.match(aiCreationIdempotency, /PRIMARY KEY \(organization_id, actor_user_id, operation, key_hash\)/);
  assert.doesNotMatch(aiCreationIdempotency, /project_id uuid NOT NULL/);
  assert.match(aiCreationIdempotency, /ALTER TABLE nexora\.ai_creation_idempotency ENABLE ROW LEVEL SECURITY/);
  assert.match(aiCreationIdempotency, /CREATE POLICY ai_creation_idempotency_select_actor/);
  assert.match(aiCreationIdempotency, /CREATE POLICY ai_creation_idempotency_insert_actor/);
  assert.match(aiCreationIdempotency, /CREATE POLICY ai_creation_idempotency_delete_actor/);
  // The organization purge removes these rows with the other children.
  assert.match(aiCreationIdempotency, /DELETE FROM nexora\.ai_creation_idempotency AS idempotency/);
  assert.match(aiCreationIdempotency, /CREATE OR REPLACE FUNCTION nexora\.purge_expired_organizations/);
  assert.match(grants, /ON TABLE nexora\.ai_creation_idempotency TO nexora_app;/);
});

test("Realtime event log is versioned, project-scoped, and purged by cascade (0036)", () => {
  assert.match(realtimeEvents, /CREATE TABLE nexora\.realtime_events/);
  assert.match(realtimeEvents, /type IN \('task\.created', 'task\.updated', 'task\.deleted', 'comment\.created', 'project\.updated'\)/);
  assert.match(realtimeEvents, /UNIQUE \(organization_id, project_id, version\)/);
  assert.match(realtimeEvents, /REFERENCES nexora\.projects \(id\)\n\s+ON DELETE CASCADE/);
  assert.match(realtimeEvents, /ALTER TABLE nexora\.realtime_events ENABLE ROW LEVEL SECURITY/);
  assert.match(realtimeEvents, /CREATE POLICY realtime_events_select_member/);
  assert.match(realtimeEvents, /CREATE POLICY realtime_events_insert_member/);
  // No purge step: project deletion cascades the events, and the
  // organization row itself is never hard-deleted.
  assert.doesNotMatch(realtimeEvents, /DELETE FROM nexora\.realtime_events/);
  // The stream connection scope is in both allowlists.
  assert.match(realtimeEvents, /'realtime-connect-user'/);
  assert.match(grants, /ON TABLE nexora\.realtime_events TO nexora_app;/);
});

test("Project PATCH idempotency widens the mutation operation list without touching 0007 (0037)", () => {
  assert.match(projectUpdateIdempotency, /DROP CONSTRAINT project_mutation_idempotency_operation/);
  assert.match(
    projectUpdateIdempotency,
    /operation IN \('milestone\.create', 'task\.create', 'project\.update'\)/,
  );
  assert.doesNotMatch(projectUpdateIdempotency, /DELETE FROM nexora\.project_mutation_idempotency/);
});

test("Project PATCH idempotency fix restores comment/file operations (0038)", () => {
  // Guards the 0037 regression directly: the effective operation
  // list must be the 0012 list plus project.update, not the 0007
  // list plus project.update.
  assert.match(projectUpdateIdempotencyFix, /DROP CONSTRAINT project_mutation_idempotency_operation/);
  assert.match(
    projectUpdateIdempotencyFix,
    /operation IN \('milestone\.create', 'task\.create', 'comment\.create', 'file\.upload', 'project\.update'\)/,
  );
});
