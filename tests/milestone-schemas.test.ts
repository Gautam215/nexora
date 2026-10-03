import assert from "node:assert/strict";
import test from "node:test";
import { canTransitionMilestoneStatus } from "../src/security/milestone-status.ts";
import {
  milestoneCreateSchema,
  milestoneUpdateSchema,
} from "../src/security/milestone-schemas.ts";

const firstId = "e0b120d8-982d-4e0e-a670-969a7ab8a316";
const secondId = "f5c533ae-7a2a-4e67-9e3b-1800a13bfb71";

test("milestone create validates dates, descriptions, and unique dependencies", () => {
  const parsed = milestoneCreateSchema.safeParse({
    name: "  First release  ",
    description: "  Ready for review. ",
    startDate: "2026-10-01",
    endDate: "2026-10-31",
    dependencies: [firstId],
  });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.name, "First release");
    assert.equal(parsed.data.description, "Ready for review.");
  }

  assert.equal(milestoneCreateSchema.safeParse({ name: "" }).success, false);
  assert.equal(milestoneCreateSchema.safeParse({ name: "Release", startDate: "2026-02-30" }).success, false);
  assert.equal(
    milestoneCreateSchema.safeParse({ name: "Release", startDate: "2026-11-01", endDate: "2026-10-01" }).success,
    false,
  );
  assert.equal(milestoneCreateSchema.safeParse({ name: "Release", dependencies: [firstId, firstId] }).success, false);
  assert.equal(milestoneCreateSchema.safeParse({ name: "Release", unknown: true }).success, false);
});

test("milestone updates require a version and at least one change", () => {
  assert.equal(milestoneUpdateSchema.safeParse({ expectedVersion: 1 }).success, false);
  assert.equal(milestoneUpdateSchema.safeParse({ expectedVersion: 1, status: "unknown" }).success, false);
  assert.equal(milestoneUpdateSchema.safeParse({ expectedVersion: 1, status: "active" }).success, true);
  assert.equal(
    milestoneUpdateSchema.safeParse({ expectedVersion: 1, dependencies: [firstId, secondId] }).success,
    true,
  );
});

test("milestone transitions allow planned work to pause, complete, or reopen safely", () => {
  assert.equal(canTransitionMilestoneStatus("planned", "active"), true);
  assert.equal(canTransitionMilestoneStatus("active", "on_hold"), true);
  assert.equal(canTransitionMilestoneStatus("on_hold", "completed"), true);
  assert.equal(canTransitionMilestoneStatus("completed", "active"), true);
  assert.equal(canTransitionMilestoneStatus("completed", "on_hold"), false);
  assert.equal(canTransitionMilestoneStatus("active", "planned"), false);
});
