import "server-only";
import type { DatabaseTransaction } from "./db.ts";
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
): Promise<void> {
  const { organizationId, projectId, targetType, targetId } = notification;
  const destination = targetType === "task" ? "tasks" : targetType === "milestone" ? "milestones" : "activity";
  const href = `/organizations/${organizationId.toLowerCase()}/projects/${projectId.toLowerCase()}/${destination}`;
  await transaction.query(
    `SELECT nexora.enqueue_project_notification(
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
     )`,
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
