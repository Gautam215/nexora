import assert from "node:assert/strict";
import test from "node:test";
import { canTransitionProjectStatus } from "../src/security/project-status.ts";

test("project status transitions follow the defined lifecycle", () => {
  assert.equal(canTransitionProjectStatus("planned", "active"), true);
  assert.equal(canTransitionProjectStatus("active", "on_hold"), true);
  assert.equal(canTransitionProjectStatus("on_hold", "active"), true);
  assert.equal(canTransitionProjectStatus("completed", "active"), true);
  assert.equal(canTransitionProjectStatus("active", "completed"), true);
  assert.equal(canTransitionProjectStatus("completed", "archived"), true);
  assert.equal(canTransitionProjectStatus("archived", "active"), false);
  assert.equal(canTransitionProjectStatus("planned", "completed"), false);
  assert.equal(canTransitionProjectStatus("planned", "planned"), true);
});
