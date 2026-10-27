import "server-only";
import type { DatabaseTransaction } from "../db.ts";

// Per-user notification stream (approved default, 2026-10-26).
// The channel is per-organization AND per-recipient: the route runs
// in organization context, so the notifications table's FORCE RLS
// select policy (recipient = current user, organization = current
// organization, and the project must still be accessible to the
// caller) filters every row. A recipient therefore never sees
// another user's notifications, notifications from an organization
// they are not a member of, or notifications for a project they
// lost access to — even if they guess another notification's id.
// A global per-user stream across organizations was rejected for
// exactly that reason: it would need a new recipient-only policy
// that bypasses the project-access check, and it would leak old
// notifications after a project removal. Clients that belong to
// several organizations open one stream per organization, which
// matches how the notification centre itself is organized.
//
// Cursor: (created_at, id) tuple ordering. Notifications created
// in the same transaction share created_at (now() is transaction
// start), so created_at alone would skip or duplicate rows; the
// tuple is deterministic and total.

export interface UserNotificationRow {
  id: string;
  organization_id: string;
  project_id: string;
  event_type: string;
  title: string;
  body: string;
  href: string;
  created_at: Date;
}

export interface NotificationCursor {
  createdAt: Date;
  id: string;
}

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export function cursorFromSince(since: Date): NotificationCursor {
  return { createdAt: since, id: ZERO_UUID };
}

export async function listUserNotificationsAfter(
  transaction: DatabaseTransaction,
  organizationId: string,
  userId: string,
  cursor: NotificationCursor,
  limit: number,
): Promise<UserNotificationRow[]> {
  const result = await transaction.query<UserNotificationRow>(
    `SELECT notification.id, notification.organization_id, notification.project_id,
            notification.event_type, notification.title, notification.body,
            notification.href, notification.created_at
     FROM nexora.notifications AS notification
     WHERE notification.organization_id = $1
       AND notification.recipient_user_id = $2
       AND (notification.created_at, notification.id) > ($3, $4)
     ORDER BY notification.created_at ASC, notification.id ASC
     LIMIT $5`,
    [organizationId, userId, cursor.createdAt, cursor.id, limit],
  );
  return result.rows;
}

export async function latestUserNotificationCursor(
  transaction: DatabaseTransaction,
  organizationId: string,
  userId: string,
): Promise<NotificationCursor | null> {
  const result = await transaction.query<{ created_at: Date; id: string }>(
    `SELECT notification.created_at, notification.id
     FROM nexora.notifications AS notification
     WHERE notification.organization_id = $1
       AND notification.recipient_user_id = $2
     ORDER BY notification.created_at DESC, notification.id DESC
     LIMIT 1`,
    [organizationId, userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { createdAt: row.created_at, id: row.id };
}

// Resolve a last-event-id to its cursor. A lookup that finds
// nothing (another user's id, a notification for a project the
// caller lost access to, or a deleted notification) returns null,
// and the route then goes live-only instead of leaking anything
// about whether that id exists.
export async function cursorForNotificationId(
  transaction: DatabaseTransaction,
  organizationId: string,
  userId: string,
  notificationId: string,
): Promise<NotificationCursor | null> {
  const result = await transaction.query<{ created_at: Date; id: string }>(
    `SELECT notification.created_at, notification.id
     FROM nexora.notifications AS notification
     WHERE notification.organization_id = $1
       AND notification.recipient_user_id = $2
       AND notification.id = $3
     LIMIT 1`,
    [organizationId, userId, notificationId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { createdAt: row.created_at, id: row.id };
}
