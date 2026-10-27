import assert from "node:assert/strict";
import test from "node:test";
import {
  notificationPreferencesSchema,
  notificationReadSchema,
} from "../src/security/notification-schemas.ts";

test("notification read state accepts only a boolean", () => {
  assert.equal(notificationReadSchema.safeParse({ read: true }).success, true);
  assert.equal(notificationReadSchema.safeParse({ read: false }).success, true);
  assert.equal(notificationReadSchema.safeParse({ read: "true" }).success, false);
  assert.equal(notificationReadSchema.safeParse({ read: true, extra: true }).success, false);
});

test("notification preferences are bounded, unique, and use known event types", () => {
  assert.equal(notificationPreferencesSchema.safeParse({
    preferences: [{ eventType: "mention", inAppEnabled: false }],
  }).success, true);
  assert.equal(notificationPreferencesSchema.safeParse({ preferences: [] }).success, false);
  assert.equal(notificationPreferencesSchema.safeParse({
    preferences: [
      { eventType: "mention", inAppEnabled: true },
      { eventType: "mention", inAppEnabled: false },
    ],
  }).success, false);
  assert.equal(notificationPreferencesSchema.safeParse({
    preferences: [{ eventType: "unknown", inAppEnabled: true }],
  }).success, false);
  // emailEnabled became a legitimate field with the notification
  // email outbox (approved default, 2026-10-26): it is opt-in and
  // only takes effect when the operator configured the event type.
  assert.equal(notificationPreferencesSchema.safeParse({
    preferences: [{ eventType: "mention", inAppEnabled: true, emailEnabled: true }],
  }).success, true);
  assert.equal(notificationPreferencesSchema.safeParse({
    preferences: [{ eventType: "mention", inAppEnabled: true, emailEnabled: "yes" }],
  }).success, false);
  assert.equal(notificationPreferencesSchema.safeParse({
    preferences: [{ eventType: "mention", inAppEnabled: true, unknownField: true }],
  }).success, false);
});
