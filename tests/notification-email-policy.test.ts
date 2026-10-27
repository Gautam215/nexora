import assert from "node:assert/strict";
import test from "node:test";
import { parseNotificationEmailTypes } from "../src/server/notifications/email-policy.ts";

// Approved default: email is off unless the operator lists a type,
// and unknown values are ignored, never treated as "all".

test("notification email types parse as a set of known types only", () => {
  assert.deepEqual([...parseNotificationEmailTypes(undefined)], []);
  assert.deepEqual([...parseNotificationEmailTypes("")], []);
  assert.deepEqual(
    [...parseNotificationEmailTypes("mention, project_activity")].sort(),
    ["mention", "project_activity"],
  );
  assert.deepEqual(
    [...parseNotificationEmailTypes("mention, unknown, all, task_assigned")].sort(),
    ["mention", "task_assigned"],
  );
  assert.deepEqual([...parseNotificationEmailTypes(" , ")], []);
});
