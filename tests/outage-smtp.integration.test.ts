import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Client } from "pg";
import { notifyProjectMember } from "../src/server/project-notifications.ts";
import { processNotificationEmailBatch } from "../src/server/notifications/email-outbox.ts";
import { closeDatabasePool, withOrganizationContext } from "../src/server/db.ts";

const connectionString = process.env.NEXORA_TEST_DATABASE_URL;
const migratorConnectionString = process.env.NEXORA_TEST_MIGRATOR_DATABASE_URL;
if (connectionString) process.env.DATABASE_URL = connectionString;

after(async () => {
  await closeDatabasePool();
});

test(
  "SMTP outage: the email-outbox batch leaves the row pending with backoff, never lost",
  { skip: !connectionString || !migratorConnectionString },
  async () => {
    // The operator gate for task_assigned emails, plus a dead SMTP
    // host. No mail is sent before the batch in this process (the
    // notify call below only enqueues), so the transporter's
    // module-level cache picks up the dead host on first send.
    process.env.NEXORA_NOTIFICATION_EMAIL_TYPES = "task_assigned";
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = "1";
    process.env.SMTP_SECURE = "false";
    process.env.SMTP_REQUIRE_TLS = "false";
    process.env.SMTP_FROM = "noreply@nexora.example.test";
    process.env.SMTP_USER = "";
    process.env.SMTP_PASSWORD = "";

    // Seed the workspace directly as the migrator: two users, one
    // workspace, one project, the recipient as an active project
    // member with email enabled for task_assigned. (No registration
    // flow runs in this file, so no working SMTP is needed.)
    const suffix = randomUUID().slice(0, 8);
    const actorId = randomUUID();
    const recipientId = randomUUID();
    const organizationId = randomUUID();
    const projectId = randomUUID();
    const slug = `outage-smtp-${suffix}`;
    const migrator = new Client({ connectionString: migratorConnectionString });
    await migrator.connect();
    try {
      await migrator.query(
        "INSERT INTO nexora.users (id, email, display_name, password_hash, status, email_verified_at) VALUES ($1, $2, $3, $4, 'active', pg_catalog.now()), ($5, $6, $7, $8, 'active', pg_catalog.now())",
        [
          actorId, `outage-actor-${suffix}@example.test`, "Outage Actor", "a".repeat(64),
          recipientId, `outage-recipient-${suffix}@example.test`, "Outage Recipient", "b".repeat(64),
        ],
      );
      await migrator.query(
        "INSERT INTO nexora.organizations (id, name, slug, created_by) VALUES ($1, $2, $3, $4)",
        [organizationId, `Outage Org ${suffix}`, slug, actorId],
      );
      await migrator.query(
        "INSERT INTO nexora.organization_memberships (organization_id, user_id, role, status, joined_at) VALUES ($1, $2, 'owner', 'active', pg_catalog.now()), ($1, $3, 'member', 'active', pg_catalog.now())",
        [organizationId, actorId, recipientId],
      );
      await migrator.query(
        "INSERT INTO nexora.projects (id, organization_id, name, owner_user_id) VALUES ($1, $2, $3, $4)",
        [projectId, organizationId, `Outage Project ${suffix}`, actorId],
      );
      await migrator.query(
        "INSERT INTO nexora.project_memberships (organization_id, project_id, user_id, role, added_by_user_id) VALUES ($1, $2, $3, 'member', $4)",
        [organizationId, projectId, recipientId, actorId],
      );
      await migrator.query(
        "INSERT INTO nexora.notification_preferences (organization_id, user_id, event_type, email_enabled) VALUES ($1, $2, 'task_assigned', true)",
        [organizationId, recipientId],
      );
    } finally {
      await migrator.end();
    }

    // The real notify path: in-app notification plus outbox row
    // in one transaction (both email gates pass).
    const notificationId = await withOrganizationContext(actorId, organizationId, async (transaction) =>
      notifyProjectMember(transaction, {
        organizationId,
        projectId,
        recipientUserId: recipientId,
        actorUserId: actorId,
        eventType: "task_assigned",
        targetType: "task",
        targetId: randomUUID(),
        dedupeKey: `outage-smtp-${suffix}`,
        title: "Outage test task",
        body: "Outage test body",
      }),
    );
    assert.ok(notificationId);

    const result = await processNotificationEmailBatch();
    assert.equal(result.claimed, 1);
    assert.equal(result.sent, 0);
    assert.equal(result.pendingRetry, 1);

    const check = new Client({ connectionString: migratorConnectionString });
    await check.connect();
    try {
      const row = await check.query(
        "SELECT status, attempts, next_attempt_at, sent_at FROM nexora.notification_email_outbox WHERE notification_id = $1",
        [notificationId],
      );
      // Still pending (not failed, not lost), one attempt spent,
      // and the next attempt pushed into the future by backoff.
      assert.equal(row.rows[0]?.status, "pending");
      assert.equal(row.rows[0]?.attempts, 1);
      assert.ok((row.rows[0]?.next_attempt_at as Date) > new Date());
      assert.equal(row.rows[0]?.sent_at, null);
    } finally {
      await check.end();
    }
  },
);
