import { z } from "zod";

export const NOTIFICATION_EVENT_TYPES = [
  "mention",
  "task_assigned",
  "project_activity",
  "due_date",
  "ai_workflow",
] as const;

export const notificationReadSchema = z.strictObject({ read: z.boolean() });

export const notificationPreferencesSchema = z.strictObject({
  preferences: z.array(z.strictObject({
    eventType: z.enum(NOTIFICATION_EVENT_TYPES),
    inAppEnabled: z.boolean(),
  })).min(1).max(NOTIFICATION_EVENT_TYPES.length).refine(
    (items) => new Set(items.map((item) => item.eventType)).size === items.length,
  ),
});
