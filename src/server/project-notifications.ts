import "server-only";
import type { DatabaseTransaction } from "./db.ts";
import { isNotificationEmailTypeConfigured } from "./notifications/email-policy.ts";
import { readProjectMembers } from "./project-work.ts";

export type NotificationEventType =
  | "mention"
  | "task_assigned"
  | "project_activity"
  | "due_date"
  | "ai_workflow";

interface ProjectNotification {
  organizationId: string;
  projectId: string;
  recipientUserId: string;
  actorUserId: string;
  eventType: NotificationEventType;
  targetType: "task" | "project" | "milestone" | "project_membership";
  targetId: string;
  dedupeKey: string;
  title: string;
  body: string;
}

export async function notifyProjectMember(
  transaction: DatabaseTransaction,
  notification: ProjectNotification,
): Promise<string | null> {
  const { organizationId, projectId, targetType, targetId } = notification;
  const destination = targetType === "task" ? "tasks" : targetType === "milestone" ? "milestones" : "activity";
  const href = `/organizations/${organizationId.toLowerCase()}/projects/${projectId.toLowerCase()}/${destination}`;
  const created = await transaction.query<{ enqueue_project_notification: string | null }>(
    `SELECT nexora.enqueue_project_notification(
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
     ) AS enqueue_project_notification`,
    [
      organizationId,
      projectId,
      notification.recipientUserId,
      notification.actorUserId,
      notification.eventType,
      targetType,
      targetId,
      notification.dedupeKey,
      notification.title,
      notification.body,
      href,
    ],
  );
  const notificationId = created.rows[0]?.enqueue_project_notification ?? null;
  if (!notificationId) return null;
  // Notification email outbox (approved default, 2026-10-26): the
  // outbox row is written in the SAME transaction as the in-app
  // notification, so a rolled-back mutation never leaves an orphan
  // email. Email is opt-in twice over: the operator must configure
  // the event type, and the recipient must enable email for it.
  // With either condition missing, nothing is enqueued and the
  // in-app notification is unaffected.
  if (isNotificationEmailTypeConfigured(notification.eventType)) {
    const enabled = await transaction.query<{ notification_email_enabled: boolean }>(
      `SELECT nexora.notification_email_enabled($1, $2, $3) AS notification_email_enabled`,
      [organizationId, notification.recipientUserId, notification.eventType],
    );
    if (enabled.rows[0]?.notification_email_enabled === true) {
      await transaction.query(
        `SELECT nexora.enqueue_notification_email_outbox($1, $2, $3, $4, $5, $6, $7)`,
        [
          notificationId,
          organizationId,
          notification.recipientUserId,
          notification.eventType,
          notification.title,
          notification.body,
          href,
        ],
      );
    }
  }
  return notificationId;
}

export async function notifyProjectMembers(
  transaction: DatabaseTransaction,
  notification: Omit<ProjectNotification, "recipientUserId" | "eventType" | "dedupeKey"> & {
    eventId: string;
    excludedUserIds?: string[];
  },
): Promise<void> {
  const members = await readProjectMembers(transaction, notification.organizationId, notification.projectId);
  const excluded = new Set([notification.actorUserId, ...(notification.excludedUserIds ?? [])]);
  for (const member of members) {
    if (member.status !== "active" || excluded.has(member.user_id)) continue;
    await notifyProjectMember(transaction, {
      ...notification,
      recipientUserId: member.user_id,
      eventType: "project_activity",
      dedupeKey: `activity:${notification.eventId}:${member.user_id}`,
    });
  }
}
