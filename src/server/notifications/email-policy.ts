import "server-only";
import { NOTIFICATION_EVENT_TYPES } from "../../security/notification-schemas.ts";

// Notification-email policy (approved default, 2026-10-26).
// Email is off by default and opt-in twice over:
// 1. The operator must list an event type in
//    NEXORA_NOTIFICATION_EMAIL_TYPES (comma-separated, unknown
//    values are ignored, empty means disabled).
// 2. The recipient must enable email for that event type in their
//    notification preferences (email_enabled, default false).
// Neither condition alone sends email, and no notification is
// emailed by default. This module is pure env parsing so it can be
// unit-tested without a database.

export type NotificationEmailEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export function parseNotificationEmailTypes(value: string | undefined): Set<string> {
  if (!value) return new Set();
  const known = new Set<string>(NOTIFICATION_EVENT_TYPES);
  return new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => known.has(item)),
  );
}

export function notificationEmailTypesConfigured(): Set<string> {
  return parseNotificationEmailTypes(process.env.NEXORA_NOTIFICATION_EMAIL_TYPES);
}

export function isNotificationEmailTypeConfigured(eventType: string): boolean {
  return notificationEmailTypesConfigured().has(eventType);
}
