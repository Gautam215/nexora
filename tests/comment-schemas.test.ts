import assert from "node:assert/strict";
import test from "node:test";
import { taskCommentCreateSchema } from "../src/security/comment-schemas.ts";

test("task comments trim text and reject empty, oversized, or unknown input", () => {
  const parsed = taskCommentCreateSchema.safeParse({ body: "  Need design review before release.  " });
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data.body, "Need design review before release.");

  assert.equal(taskCommentCreateSchema.safeParse({ body: "   " }).success, false);
  assert.equal(taskCommentCreateSchema.safeParse({ body: "x".repeat(4001) }).success, false);
  assert.equal(taskCommentCreateSchema.safeParse({ body: "A note", html: "<b>" }).success, false);
});
