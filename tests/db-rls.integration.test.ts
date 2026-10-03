import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Client } from "pg";
import {
  closeDatabasePool,
  OrganizationAccessDenied,
  withOrganizationContext,
} from "../src/server/db.ts";

const connectionString = process.env.NEXORA_TEST_DATABASE_URL;
if (connectionString) process.env.DATABASE_URL = connectionString;

after(async () => {
  await closeDatabasePool();
});

test(
  "PostgreSQL RLS denies cross-tenant reads and owner self-assignment",
  { skip: !connectionString },
  async () => {
    const userA = randomUUID();
    const userB = randomUUID();
    const userC = randomUUID();
    const orgA = randomUUID();
    const orgB = randomUUID();
    const auditB = randomUUID();
    const invitationB = randomUUID();
    const sessionB = randomUUID();
    const projectB = randomUUID();
    const milestoneB = randomUUID();
    const taskB = randomUUID();
    const taskFileB = randomUUID();
    const deletedTaskFileB = randomUUID();
    const independentTaskB = randomUUID();
    const commentB = randomUUID();
    const notificationDeduplicationNonce = randomUUID();
    const prerequisiteTaskB = randomUUID();
    const foreignMilestone = randomUUID();
    const idempotencyKeyHash = randomBytes(32).toString("hex");
    const idempotencyRequestHash = randomBytes(32).toString("hex");
    const client = new Client({ connectionString });
    await client.connect();

    const setContext = async (userId: string, organizationId = "") => {
      await client.query(
        "SELECT pg_catalog.set_config('nexora.user_id', $1, true), pg_catalog.set_config('nexora.organization_id', $2, true)",
        [userId, organizationId],
      );
    };

    try {
      await client.query("BEGIN");
      await setContext(userA);
      await client.query(
        "INSERT INTO nexora.users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)",
        [userA, `${userA}@example.test`, "Workspace A", "a".repeat(64)],
      );
      const verificationHashA = randomBytes(32).toString("hex");
      await client.query(
        "SELECT nexora.issue_email_verification($1, $2, $3, $4)",
        [`${userA}@example.test`, randomUUID(), verificationHashA, new Date(Date.now() + 60_000)],
      );
      await client.query("SELECT nexora.consume_email_verification($1)", [verificationHashA]);
      await client.query(
        "INSERT INTO nexora.organizations (id, name, slug, created_by) VALUES ($1, $2, $3, $4)",
        [orgA, "Workspace A", `org-${userA.slice(0, 8)}`, userA],
      );
      await client.query(
        `INSERT INTO nexora.organization_memberships
         (organization_id, user_id, role, status, joined_at)
         VALUES ($1, $2, 'owner', 'active', pg_catalog.now())`,
        [orgA, userA],
      );

      await setContext(userB);
      await client.query(
        "INSERT INTO nexora.users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)",
        [userB, `${userB}@example.test`, "Workspace B", "b".repeat(64)],
      );
      const verificationHashB = randomBytes(32).toString("hex");
      await client.query(
        "SELECT nexora.issue_email_verification($1, $2, $3, $4)",
        [`${userB}@example.test`, randomUUID(), verificationHashB, new Date(Date.now() + 60_000)],
      );
      await client.query("SELECT nexora.consume_email_verification($1)", [verificationHashB]);
      await client.query(
        "INSERT INTO nexora.organizations (id, name, slug, created_by) VALUES ($1, $2, $3, $4)",
        [orgB, "Workspace B", `org-${userB.slice(0, 8)}`, userB],
      );
      await client.query(
        `INSERT INTO nexora.organization_memberships
         (organization_id, user_id, role, status, joined_at)
         VALUES ($1, $2, 'owner', 'active', pg_catalog.now())`,
        [orgB, userB],
      );
      await setContext(userB, orgB);
      await client.query(
        `INSERT INTO nexora.projects (id, organization_id, name, owner_user_id)
         VALUES ($1, $2, 'Private project', $3)`,
        [projectB, orgB, userB],
      );
      const workflowStatus = await client.query<{ id: string }>(
        `SELECT id FROM nexora.project_task_statuses
         WHERE organization_id = $1 AND project_id = $2 AND name = 'To do'`,
        [orgB, projectB],
      );
      assert.ok(workflowStatus.rows[0]);
      await client.query(
        `INSERT INTO nexora.milestones
           (id, organization_id, project_id, name, created_by_user_id)
         VALUES ($1, $2, $3, 'Private milestone', $4)`,
        [milestoneB, orgB, projectB, userB],
      );
      await client.query(
        `INSERT INTO nexora.tasks
           (id, organization_id, project_id, title, workflow_status_id, milestone_id, created_by_user_id)
         VALUES ($1, $2, $3, 'Private task', $4, $5, $6)`,
        [taskB, orgB, projectB, workflowStatus.rows[0].id, milestoneB, userB],
      );
      await client.query(
        `INSERT INTO nexora.tasks
           (id, organization_id, project_id, title, workflow_status_id, created_by_user_id)
          VALUES ($1, $2, $3, 'Private prerequisite', $4, $5)`,
        [prerequisiteTaskB, orgB, projectB, workflowStatus.rows[0].id, userB],
      );
      await client.query(
        `INSERT INTO nexora.tasks
           (id, organization_id, project_id, title, workflow_status_id, created_by_user_id)
         VALUES ($1, $2, $3, 'Independent task', $4, $5)`,
        [independentTaskB, orgB, projectB, workflowStatus.rows[0].id, userB],
      );
      await client.query(
        `INSERT INTO nexora.task_dependencies
           (organization_id, project_id, task_id, depends_on_task_id)
         VALUES ($1, $2, $3, $4)`,
        [orgB, projectB, taskB, prerequisiteTaskB],
      );
      await client.query(
        `INSERT INTO nexora.project_mutation_idempotency
           (organization_id, project_id, actor_user_id, operation, key_hash, request_hash,
            response_status, response_body)
         VALUES ($1, $2, $3, 'task.create', $4, $5, 201, $6::jsonb)`,
        [orgB, projectB, userB, idempotencyKeyHash, idempotencyRequestHash, JSON.stringify({ taskId: taskB })],
      );
      await client.query(
        `INSERT INTO nexora.project_memberships
         (organization_id, project_id, user_id, role, status, added_by_user_id)
          VALUES ($1, $2, $3, 'manager', 'active', $3)`,
        [orgB, projectB, userB],
      );
      await client.query(
        `INSERT INTO nexora.task_files
           (id, organization_id, project_id, task_id, original_filename, mime_type,
            byte_size, sha256, storage_key, uploaded_by_user_id)
         VALUES ($1, $2, $3, $4, 'private.txt', 'text/plain', 5, $5, $6, $7),
                ($8, $2, $3, $4, 'deleted.txt', 'text/plain', 5, $5, $9, $7)`,
        [taskFileB, orgB, projectB, taskB, "a".repeat(64), randomUUID(), userB,
          deletedTaskFileB, randomUUID()],
      );
      await client.query(
        `UPDATE nexora.task_files
         SET deleted_at = pg_catalog.now(), deleted_by_user_id = $1
         WHERE id = $2`,
        [userB, deletedTaskFileB],
      );
      await setContext(userC);
      await client.query(
        "INSERT INTO nexora.users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)",
        [userC, `${userC}@example.test`, "Workspace B Teammate", "c".repeat(64)],
      );
      const verificationHashC = randomBytes(32).toString("hex");
      await client.query(
        "SELECT nexora.issue_email_verification($1, $2, $3, $4)",
        [`${userC}@example.test`, randomUUID(), verificationHashC, new Date(Date.now() + 60_000)],
      );
      await client.query("SELECT nexora.consume_email_verification($1)", [verificationHashC]);
      const organizationInvitationHash = randomBytes(32).toString("hex");
      await setContext(userB, orgB);
      await client.query(
        `INSERT INTO nexora.organization_invitations
         (id, organization_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, 'member', $4, $5, pg_catalog.now() + interval '1 day')`,
        [randomUUID(), orgB, `${userC}@example.test`, organizationInvitationHash, userB],
      );
      await setContext(userC);
      const acceptedOrganizationInvitation = await client.query<{ accept_organization_invitation: boolean }>(
        "SELECT nexora.accept_organization_invitation($1)",
        [organizationInvitationHash],
      );
      assert.equal(acceptedOrganizationInvitation.rows[0]?.accept_organization_invitation, true);
      await setContext(userB, orgB);
      await client.query(
        `INSERT INTO nexora.project_memberships
         (organization_id, project_id, user_id, role, status, added_by_user_id)
         VALUES ($1, $2, $3, 'viewer', 'active', $4)`,
        [orgB, projectB, userC, userB],
      );
      await client.query(
        `INSERT INTO nexora.task_comments
           (id, organization_id, project_id, task_id, author_user_id, body)
         VALUES ($1, $2, $3, $4, $5, 'Private task comment')`,
        [commentB, orgB, projectB, taskB, userB],
      );
      await client.query(
        `INSERT INTO nexora.task_comment_mentions
         (organization_id, project_id, task_id, comment_id, mentioned_user_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [orgB, projectB, taskB, commentB, userC],
      );
      const notificationResult = await client.query<{ notification_id: string | null }>(
        `SELECT nexora.enqueue_project_notification(
           $1, $2, $3, $4, 'mention', 'task', $5, $6, 'You were mentioned',
           'A project member mentioned you.', $7
         ) AS notification_id`,
        [
          orgB,
          projectB,
          userC,
          userB,
          taskB,
          `rls-mention:${notificationDeduplicationNonce}`,
          `/organizations/${orgB}/projects/${projectB}/tasks`,
        ],
      );
      const notificationB = notificationResult.rows[0]?.notification_id;
      assert.ok(notificationB);
      assert.match(notificationB, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      await client.query(
        `INSERT INTO nexora.audit_events
         (id, organization_id, actor_user_id, action, target_type)
         VALUES ($1, $2, $3, 'member.added', 'membership')`,
        [auditB, orgB, userB],
      );
      await client.query(
        `INSERT INTO nexora.organization_invitations
         (id, organization_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, 'member', $4, $5, pg_catalog.now() + interval '1 day')`,
        [invitationB, orgB, `invite-${userB}@example.test`, randomBytes(32).toString("hex"), userB],
      );
      await client.query(
        `INSERT INTO nexora.user_sessions (id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, pg_catalog.now() + interval '1 day')`,
        [sessionB, userB, randomBytes(32).toString("hex")],
      );
      await client.query("COMMIT");

      const ownOrganization = await withOrganizationContext(
        userA,
        orgA,
        async (transaction) => {
          const result = await transaction.query<{ name: string }>(
            "SELECT name FROM nexora.organizations WHERE id = $1",
            [orgA],
          );
          return result.rows[0]?.name;
        },
      );
      assert.equal(ownOrganization, "Workspace A");

      let unauthorizedCallbackCalled = false;
      await assert.rejects(
        withOrganizationContext(userA, orgB, async () => {
          unauthorizedCallbackCalled = true;
        }),
        OrganizationAccessDenied,
      );
      assert.equal(unauthorizedCallbackCalled, false);

      await client.query("BEGIN");
      await setContext(userA, orgB);
      const hiddenRows = await client.query(
        `SELECT 'organization' AS kind FROM nexora.organizations WHERE id = $1
         UNION ALL SELECT 'invitation' FROM nexora.organization_invitations WHERE id = $2
         UNION ALL SELECT 'audit' FROM nexora.audit_events WHERE id = $3
         UNION ALL SELECT 'session' FROM nexora.user_sessions WHERE id = $4
         UNION ALL SELECT 'project' FROM nexora.projects WHERE id = $5
         UNION ALL SELECT 'project_member' FROM nexora.project_memberships WHERE project_id = $5
         UNION ALL SELECT 'task_status' FROM nexora.project_task_statuses WHERE project_id = $5
         UNION ALL SELECT 'milestone' FROM nexora.milestones WHERE id = $6
         UNION ALL SELECT 'task' FROM nexora.tasks WHERE id IN ($7, $8)
          UNION ALL SELECT 'task_dependency' FROM nexora.task_dependencies WHERE task_id = $7
           UNION ALL SELECT 'task_comment' FROM nexora.task_comments WHERE id = $10
            UNION ALL SELECT 'task_comment_mention' FROM nexora.task_comment_mentions WHERE comment_id = $10
            UNION ALL SELECT 'notification' FROM nexora.notifications WHERE id = $11
            UNION ALL SELECT 'task_file' FROM nexora.task_files WHERE id = $12
            UNION ALL SELECT 'idempotency' FROM nexora.project_mutation_idempotency WHERE key_hash = $9`,
           [orgB, invitationB, auditB, sessionB, projectB, milestoneB, taskB, prerequisiteTaskB, idempotencyKeyHash, commentB, notificationB, taskFileB],
        );
      assert.equal(hiddenRows.rowCount, 0);

      await client.query("SAVEPOINT before_direct_notification_insert");
      await assert.rejects(
        client.query(
          `INSERT INTO nexora.notifications
           (id, organization_id, project_id, recipient_user_id, actor_user_id,
            event_type, target_type, target_id, dedupe_key, title, body, href)
           VALUES ($1, $2, $3, $4, $5, 'mention', 'task', $6, $7,
                   'Direct insert', 'Must use notification function.', $8)`,
          [
            randomUUID(),
            orgB,
            projectB,
            userC,
            userB,
            taskB,
            `direct:${randomUUID()}`,
            `/organizations/${orgB}/projects/${projectB}/tasks`,
          ],
        ),
        (error: { code?: string }) => error.code === "42501",
      );
      await client.query("ROLLBACK TO SAVEPOINT before_direct_notification_insert");

      await setContext(userC, orgB);
      const ownNotification = await client.query(
        "SELECT id FROM nexora.notifications WHERE id = $1",
        [notificationB],
      );
      assert.equal(ownNotification.rowCount, 1);
      const visibleTaskFiles = await client.query(
        "SELECT id FROM nexora.task_files WHERE id IN ($1, $2) ORDER BY id",
        [taskFileB, deletedTaskFileB],
      );
      assert.deepEqual(visibleTaskFiles.rows.map((row) => row.id), [taskFileB]);
      const markOwnNotificationRead = await client.query(
        "UPDATE nexora.notifications SET read_at = pg_catalog.now() WHERE id = $1",
        [notificationB],
      );
      assert.equal(markOwnNotificationRead.rowCount, 1);
      const viewerCannotUpdateFile = await client.query(
        "UPDATE nexora.task_files SET version = version + 1 WHERE id = $1",
        [taskFileB],
      );
      assert.equal(viewerCannotUpdateFile.rowCount, 0);

      await client.query("SAVEPOINT before_viewer_file_insert");
      await assert.rejects(
        client.query(
          `INSERT INTO nexora.task_files
             (id, organization_id, project_id, task_id, original_filename, mime_type,
              byte_size, sha256, storage_key, uploaded_by_user_id)
           VALUES ($1, $2, $3, $4, 'viewer.txt', 'text/plain', 5, $5, $6, $7)`,
          [randomUUID(), orgB, projectB, taskB, "b".repeat(64), randomUUID(), userC],
        ),
        (error: { code?: string }) => error.code === "42501",
      );
      await client.query("ROLLBACK TO SAVEPOINT before_viewer_file_insert");

      await setContext(userB, orgB);
      await client.query("SAVEPOINT before_task_file_hard_delete");
      await assert.rejects(
        client.query("DELETE FROM nexora.task_files WHERE id = $1", [taskFileB]),
        (error: { code?: string }) => error.code === "42501",
      );
      await client.query("ROLLBACK TO SAVEPOINT before_task_file_hard_delete");

      await setContext(userC, orgB);
      const attemptedMilestoneUpdate = await client.query(
        `UPDATE nexora.milestones SET name = 'Cross-tenant edit'
         WHERE organization_id = $1 AND project_id = $2 AND id = $3`,
        [orgB, projectB, milestoneB],
      );
      assert.equal(attemptedMilestoneUpdate.rowCount, 0);
      const attemptedTaskUpdate = await client.query(
        `UPDATE nexora.tasks SET title = 'Cross-tenant edit'
         WHERE organization_id = $1 AND project_id = $2 AND id = $3`,
        [orgB, projectB, taskB],
      );
      assert.equal(attemptedTaskUpdate.rowCount, 0);
      const attemptedDependencyDelete = await client.query(
        `DELETE FROM nexora.task_dependencies
         WHERE organization_id = $1 AND project_id = $2 AND task_id = $3`,
        [orgB, projectB, taskB],
      );
      assert.equal(attemptedDependencyDelete.rowCount, 0);
      const attemptedIdempotencyDelete = await client.query(
        `DELETE FROM nexora.project_mutation_idempotency
         WHERE organization_id = $1 AND project_id = $2 AND key_hash = $3`,
        [orgB, projectB, idempotencyKeyHash],
      );
      assert.equal(attemptedIdempotencyDelete.rowCount, 0);

      await client.query("SAVEPOINT before_cross_tenant_milestone_insert");
      await assert.rejects(
        client.query(
          `INSERT INTO nexora.milestones
             (id, organization_id, project_id, name, created_by_user_id)
           VALUES ($1, $2, $3, 'Cross-tenant insert', $4)`,
          [foreignMilestone, orgB, projectB, userA],
        ),
        (error: { code?: string }) => error.code === "42501",
      );
      await client.query("ROLLBACK TO SAVEPOINT before_cross_tenant_milestone_insert");

      await client.query("SAVEPOINT before_cross_tenant_dependency_insert");
      await assert.rejects(
        client.query(
          `INSERT INTO nexora.task_dependencies
           (organization_id, project_id, task_id, depends_on_task_id)
          VALUES ($1, $2, $3, $4)`,
          [orgB, projectB, taskB, independentTaskB],
        ),
        (error: { code?: string }) => error.code === "42501",
      );
      await client.query("ROLLBACK TO SAVEPOINT before_cross_tenant_dependency_insert");

      await client.query("SAVEPOINT before_cross_tenant_comment_insert");
      await assert.rejects(
        client.query(
          `INSERT INTO nexora.task_comments
             (id, organization_id, project_id, task_id, author_user_id, body)
           VALUES ($1, $2, $3, $4, $5, 'Cross-tenant comment')`,
          [randomUUID(), orgB, projectB, taskB, userA],
        ),
        (error: { code?: string }) => error.code === "42501",
      );
      await client.query("ROLLBACK TO SAVEPOINT before_cross_tenant_comment_insert");

      await client.query("SAVEPOINT before_task_comment_update");
      await assert.rejects(
        client.query(
          "UPDATE nexora.task_comments SET body = 'Edited comment' WHERE id = $1",
          [commentB],
        ),
        (error: { code?: string }) => error.code === "42501",
      );
      await client.query("ROLLBACK TO SAVEPOINT before_task_comment_update");

      await client.query("SAVEPOINT before_task_comment_delete");
      await assert.rejects(
        client.query("DELETE FROM nexora.task_comments WHERE id = $1", [commentB]),
        (error: { code?: string }) => error.code === "42501",
      );
      await client.query("ROLLBACK TO SAVEPOINT before_task_comment_delete");

      await client.query("SAVEPOINT before_self_assignment");
      await assert.rejects(
        client.query(
          `INSERT INTO nexora.organization_memberships
           (organization_id, user_id, role, status, joined_at)
           VALUES ($1, $2, 'owner', 'active', pg_catalog.now())`,
          [orgB, userA],
        ),
        (error: { code?: string }) => error.code === "42501",
      );
      await client.query("ROLLBACK TO SAVEPOINT before_self_assignment");

      await client.query("SAVEPOINT before_project_self_assignment");
      await assert.rejects(
        client.query(
          `INSERT INTO nexora.project_memberships
           (organization_id, project_id, user_id, role, status, added_by_user_id)
           VALUES ($1, $2, $3, 'manager', 'active', $3)`,
          [orgB, projectB, userA],
        ),
        (error: { code?: string }) => error.code === "42501",
      );
      await client.query("ROLLBACK TO SAVEPOINT before_project_self_assignment");
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  },
);
